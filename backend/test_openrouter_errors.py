"""Unit tests for OpenRouter 402 handling and token reservation."""

import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

from backend.config import OPENROUTER_MAX_TOKENS, OPENROUTER_MAX_TOKENS_HIGH
from backend.council import (
    Stage1AllFailed,
    pending_stage1_slots,
    retained_stage1_failures,
    stage1_collect_responses_streaming,
)
from backend.main import _usable_final_answer, app
from backend.openrouter import (
    has_visible_content,
    parse_http_error,
    query_model_result,
    resolve_max_tokens,
)
from backend.settings import settings


class ParseHttpErrorTests(unittest.TestCase):
    def test_402_uses_reserved_tokens_message(self):
        response = httpx.Response(
            402,
            json={
                'error': {
                    'message': (
                        'This request requires more credits, or fewer max_tokens. '
                        'You requested up to 65536 tokens, but can only afford 2194.'
                    )
                }
            },
        )
        error = parse_http_error(response)
        self.assertEqual(error['status'], 402)
        self.assertEqual(error['message'], '402: cannot afford reserved tokens')
        self.assertIn('fewer max_tokens', error['detail'])

    def test_404_message(self):
        response = httpx.Response(404, json={'error': {'message': 'No endpoints found'}})
        error = parse_http_error(response)
        self.assertEqual(error['message'], 'Model not found (404)')
        self.assertEqual(error['detail'], 'No endpoints found')

    def test_non_json_body(self):
        response = httpx.Response(500, content=b'upstream exploded')
        error = parse_http_error(response)
        self.assertEqual(error['status'], 500)
        self.assertIn('upstream exploded', error['message'])


class ResolveMaxTokensTests(unittest.TestCase):
    def test_default_is_16k(self):
        self.assertEqual(resolve_max_tokens('~openai/gpt-latest'), OPENROUTER_MAX_TOKENS)

    def test_reasoning_high_default_is_32k(self):
        self.assertEqual(
            resolve_max_tokens('~anthropic/claude-fable-latest-reasoning-high'),
            OPENROUTER_MAX_TOKENS_HIGH,
        )

    def test_override_wins(self):
        self.assertEqual(resolve_max_tokens('any-reasoning-high', 4096), 4096)


class CreditsEndpointTests(unittest.TestCase):
    def test_includes_key_limit_fields(self):
        with (
            patch(
                'backend.main.get_credits',
                new=AsyncMock(
                    return_value={'total_credits': 10, 'total_usage': 3}
                ),
            ),
            patch(
                'backend.main.get_key_info',
                new=AsyncMock(
                    return_value={
                        'limit': 5,
                        'limit_remaining': 1.25,
                        'limit_reset': 'daily',
                    }
                ),
            ),
        ):
            client = TestClient(app)
            response = client.get('/api/credits')

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body['remaining'], 7)
        self.assertEqual(body['limit_remaining'], 1.25)
        self.assertEqual(body['limit_reset'], 'daily')

    def test_credits_succeed_when_key_lookup_fails(self):
        with (
            patch(
                'backend.main.get_credits',
                new=AsyncMock(return_value={'total_credits': 4, 'total_usage': 1}),
            ),
            patch(
                'backend.main.get_key_info',
                new=AsyncMock(return_value=None),
            ),
        ):
            client = TestClient(app)
            response = client.get('/api/credits')

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body['remaining'], 3)
        self.assertNotIn('limit_remaining', body)


class VisibleContentTests(unittest.TestCase):
    def test_empty_string_is_not_visible(self):
        self.assertFalse(has_visible_content(''))
        self.assertFalse(has_visible_content('   '))
        self.assertFalse(has_visible_content(None))
        self.assertFalse(has_visible_content([]))
        self.assertFalse(has_visible_content({'text': 'x'}))

    def test_text_is_visible(self):
        self.assertTrue(has_visible_content('hello'))


class UsableFinalAnswerTests(unittest.TestCase):
    def test_rejects_missing_and_error_payloads(self):
        self.assertIsNone(_usable_final_answer(None))
        self.assertIsNone(_usable_final_answer({'model': 'error', 'response': 'x'}))
        self.assertIsNone(_usable_final_answer({'response': ''}))
        self.assertIsNone(_usable_final_answer({'response': '   '}))
        self.assertIsNone(_usable_final_answer({'response': 'Error: failed'}))
        self.assertIsNone(_usable_final_answer({
            'response': 'All models failed to respond. Please try again.',
        }))
        self.assertIsNone(_usable_final_answer({'response': ['not', 'text']}))

    def test_accepts_real_answer(self):
        self.assertEqual(
            _usable_final_answer({'model': 'chairman', 'response': 'Yes.'}),
            'Yes.',
        )


class PendingSlotTests(unittest.TestCase):
    def test_counts_remaining_samples_per_model(self):
        pending = pending_stage1_slots(
            ['a', 'b'],
            3,
            [{'model': 'a'}, {'model': 'a'}],
        )
        self.assertEqual(pending, ['a', 'b', 'b', 'b'])

    def test_drops_failures_for_models_being_retried(self):
        kept = retained_stage1_failures(
            [
                {'model': 'a', 'error': {'message': 'old'}},
                {'model': 'b', 'error': {'message': 'keep'}},
            ],
            ['a'],
        )
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]['model'], 'b')


class QueryModelResultTests(unittest.IsolatedAsyncioTestCase):
    async def test_402_returns_structured_error(self):
        response = httpx.Response(
            402,
            json={'error': {'message': 'This request requires more credits'}},
            request=httpx.Request('POST', 'https://openrouter.ai/api/v1/chat/completions'),
        )

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def post(self, *args, **kwargs):
                return response

        with (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch('backend.openrouter.httpx.AsyncClient', return_value=FakeClient()),
        ):
            result = await query_model_result('~x-ai/grok-latest', [{'role': 'user', 'content': 'q'}])

        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['message'], '402: cannot afford reserved tokens')

    async def test_empty_content_is_failure(self):
        response = httpx.Response(
            200,
            json={'choices': [{'message': {'content': ''}}], 'usage': {}},
            request=httpx.Request('POST', 'https://openrouter.ai/api/v1/chat/completions'),
        )

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def post(self, *args, **kwargs):
                return response

        with (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch('backend.openrouter.httpx.AsyncClient', return_value=FakeClient()),
        ):
            result = await query_model_result('~openai/gpt-latest', [{'role': 'user', 'content': 'q'}])

        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['message'], 'Empty model response')


class Stage1FailureEventTests(unittest.IsolatedAsyncioTestCase):
    async def test_yields_model_failed_on_402(self):
        original = list(settings.council_models)
        settings.council_models = ['~x-ai/grok-latest-reasoning']

        async def fake_result(model, messages, **kwargs):
            return {
                'ok': False,
                'error': {
                    'status': 402,
                    'message': '402: cannot afford reserved tokens',
                    'detail': 'need more credits',
                },
            }

        try:
            with patch('backend.council.query_model_result', new=fake_result):
                events = []
                async for event in stage1_collect_responses_streaming('q', n=1):
                    events.append(event)
            types = [event[0] for event in events]
            self.assertIn('model_failed', types)
            failed = next(event[1] for event in events if event[0] == 'model_failed')
            self.assertEqual(failed['model'], '~x-ai/grok-latest-reasoning')
            self.assertEqual(
                failed['error']['message'],
                '402: cannot afford reserved tokens',
            )
            complete = next(event[1] for event in events if event[0] == 'all_complete')
            self.assertEqual(complete['results'], [])
            self.assertEqual(len(complete['failures']), 1)
        finally:
            settings.council_models = original

    async def test_resume_queries_remaining_samples(self):
        original = list(settings.council_models)
        settings.council_models = ['a', 'b']
        queried = []

        async def fake_result(model, messages, **kwargs):
            queried.append(model)
            return {
                'ok': True,
                'content': f'ok {model}',
                'usage': {},
            }

        try:
            with patch('backend.council.query_model_result', new=fake_result):
                events = []
                async for event in stage1_collect_responses_streaming(
                    'q',
                    n=2,
                    existing_results=[{'model': 'a', 'response': 'old'}],
                    existing_failures=[{'model': 'a', 'error': {'message': 'old 402'}}],
                ):
                    events.append(event)
            self.assertEqual(queried.count('a'), 1)
            self.assertEqual(queried.count('b'), 2)
            complete = next(event[1] for event in events if event[0] == 'all_complete')
            self.assertEqual(len(complete['results']), 4)
            self.assertEqual(complete['failures'], [])
        finally:
            settings.council_models = original

    def test_all_failed_exception_keeps_failures(self):
        failures = [{'model': 'a', 'error': {'message': '402: cannot afford reserved tokens'}}]
        exc = Stage1AllFailed(failures)
        self.assertEqual(list(exc.failures), failures)
        self.assertIn('All models failed', str(exc))


if __name__ == '__main__':
    unittest.main()

