'''Regression coverage for skips and chairman fallback after provider refusals.'''

import unittest
from unittest.mock import AsyncMock, patch

from backend.council import (
    red_team_review,
    stage2_collect_rankings_streaming,
    stage3_synthesize_final,
)
from backend.roster import remember_blocked_id, remember_model_cooldown
from backend.settings import settings


CHAIR = 'google/gemma-4-31b-it:free'
OTHER = 'other/answer:free'
STAGE1 = [{'model': OTHER, 'response': 'An answer'}]
SKIPPED = {
    'ok': False,
    'skipped': True,
    'error': {
        'status': 429,
        'message': 'Provider returned error',
        'detail': 'upstream',
    },
}


class RefusedStagesTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.addCleanup(
            setattr, settings, 'council_models', list(settings.council_models)
        )
        self.addCleanup(
            setattr, settings, 'chairman_model', settings.chairman_model
        )
        self.addCleanup(
            setattr, settings, 'red_team_model', settings.red_team_model
        )
        settings.council_models = [CHAIR, OTHER]
        settings.chairman_model = CHAIR

    async def test_stage2_skips_advance_progress_without_failure_rows(self):
        settings.council_models = [CHAIR, OTHER, 'real/failure']

        async def query(model, messages):
            if model == CHAIR:
                return SKIPPED
            if model == 'real/failure':
                return {'ok': False, 'error': {'message': 'HTTP 500'}}
            return {
                'ok': True,
                'content': 'FINAL RANKING:\n1. Response 1',
                'usage': {},
            }

        with patch('backend.council.query_model_result', new=query):
            events = [
                event async for event in stage2_collect_rankings_streaming(
                    'q', STAGE1
                )
            ]
        progress = [
            data for kind, data in events
            if kind in ('model_failed', 'model_complete')
        ]
        self.assertEqual(len(progress), 3)
        self.assertEqual(
            next(row['model'] for row in progress if row.get('skipped')),
            CHAIR,
        )
        complete = events[-1][1]
        self.assertEqual(len(complete['results']), 1)
        self.assertEqual(complete['failures'], [{
            'model': 'real/failure', 'error': {'message': 'HTTP 500'},
        }])

    async def test_skipped_red_team_is_unavailable(self):
        settings.red_team_model = CHAIR
        with patch(
            'backend.council.query_model_result',
            new=AsyncMock(return_value=SKIPPED),
        ):
            result = await red_team_review('q', 'An answer', 0, [], STAGE1)
        self.assertIsNone(result)

    async def assert_unavailable_chairman_fallback(self):
        settings.chairman_model = f'{CHAIR}-reasoning-high'
        query = AsyncMock(return_value={
            'ok': True, 'content': 'Final answer', 'usage': {'total_tokens': 12},
        })
        with patch('backend.council.query_model_result', new=query):
            result = await stage3_synthesize_final('q', STAGE1)
        self.assertEqual(query.await_count, 1)
        self.assertEqual(query.await_args.args[0], OTHER)
        self.assertEqual(result['model'], OTHER)
        self.assertEqual(result['response'], 'Final answer')
        self.assertEqual(result['usage'], {'total_tokens': 12})
        self.assertEqual(settings.chairman_model, f'{CHAIR}-reasoning-high')

    async def test_cooling_chairman_uses_temporary_fallback(self):
        remember_model_cooldown(CHAIR, 600)
        await self.assert_unavailable_chairman_fallback()

    async def test_blocked_chairman_uses_temporary_fallback(self):
        remember_blocked_id(CHAIR)
        await self.assert_unavailable_chairman_fallback()

    async def test_new_refusal_falls_back_without_repeating_variants(self):
        settings.chairman_model = f'{CHAIR}-reasoning-high'
        settings.council_models = [CHAIR, f'{CHAIR}-reasoning', OTHER]
        query = AsyncMock(side_effect=[
            SKIPPED, {'ok': True, 'content': 'Final answer'},
        ])
        with patch('backend.council.query_model_result', new=query):
            result = await stage3_synthesize_final('q', STAGE1)
        self.assertEqual(
            [call.args[0] for call in query.await_args_list],
            [f'{CHAIR}-reasoning-high', OTHER],
        )
        self.assertEqual(result['model'], OTHER)
        self.assertEqual(settings.chairman_model, f'{CHAIR}-reasoning-high')

    async def test_genuine_failure_does_not_fall_back(self):
        query = AsyncMock(return_value={
            'ok': False, 'error': {'message': 'HTTP 402'},
        })
        with patch('backend.council.query_model_result', new=query):
            with self.assertRaisesRegex(Exception, 'HTTP 402'):
                await stage3_synthesize_final('q', STAGE1)
        self.assertEqual(query.await_count, 1)

    async def test_no_available_model_does_not_dispatch(self):
        remember_model_cooldown(CHAIR, 600)
        remember_blocked_id(OTHER)
        query = AsyncMock()
        with patch('backend.council.query_model_result', new=query):
            with self.assertRaisesRegex(
                Exception, 'No chairman model is available'
            ):
                await stage3_synthesize_final('q', STAGE1)
        query.assert_not_awaited()

    async def test_exhaustion_attempts_each_catalogue_id_only_once(self):
        settings.council_models = [CHAIR, OTHER, f'{OTHER}-reasoning']
        query = AsyncMock(return_value=SKIPPED)
        with patch('backend.council.query_model_result', new=query):
            with self.assertRaisesRegex(
                Exception, 'No chairman model is available'
            ):
                await stage3_synthesize_final('q', STAGE1)
        self.assertEqual(
            [call.args[0] for call in query.await_args_list], [CHAIR, OTHER]
        )
