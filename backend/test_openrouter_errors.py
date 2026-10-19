"""Unit tests for OpenRouter 402 handling and token reservation."""

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

from backend.config import OPENROUTER_MAX_TOKENS, OPENROUTER_MAX_TOKENS_HIGH
from backend.council import (
    MODELS_UNAVAILABLE,
    Stage1AllFailed,
    pending_stage1_slots,
    red_team_review,
    retained_stage1_failures,
    stage1_collect_responses_streaming,
    stage2_collect_rankings_streaming,
    stage3_synthesize_final,
)
from backend.main import _usable_final_answer, app
from backend.openrouter import (
    catalogue_model_id,
    has_visible_content,
    parse_http_error,
    query_model_result,
    resolve_max_tokens,
)
from backend.roster import FREE_START_GAP_SECONDS, blocked_ids
from backend.settings import settings


def _response(status, body, headers=None):
    return httpx.Response(
        status,
        json=body,
        headers=headers,
        request=httpx.Request(
            'POST', 'https://openrouter.ai/api/v1/chat/completions'
        ),
    )


_REAL_SLEEP = asyncio.sleep


class _MonoClock:
    def __init__(self):
        self.now = 0.0
        self.starts = []
        self.sleeps = []
        self.on_sleep = None

    def monotonic(self):
        return self.now

    async def sleep(self, seconds):
        self.sleeps.append(seconds)
        hook = self.on_sleep
        self.on_sleep = None
        if hook is not None:
            hook()
        self.now += seconds
        await _REAL_SLEEP(0)


def _fake_client(handler):
    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def _send(self, *args, **kwargs):
            result = handler(*args, **kwargs)
            if hasattr(result, '__await__'):
                return await result
            return result

        post = _send
        get = _send

    return FakeClient()


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

    def test_detail_includes_provider_raw(self):
        response = httpx.Response(429, json={
            'error': {
                'message': 'Provider returned error',
                'metadata': {'raw': 'temporarily rate-limited upstream'},
            },
        })
        error = parse_http_error(response)
        self.assertIn('Provider returned error', error['detail'])
        self.assertIn('temporarily rate-limited upstream', error['detail'])


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

    async def test_phi4_reasoning_plus_is_not_a_suffix(self):
        captured = {}

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def post(self, *args, **kwargs):
                captured['json'] = kwargs.get('json')
                return httpx.Response(
                    200,
                    json={'choices': [{'message': {'content': 'yes'}}], 'usage': {}},
                    request=httpx.Request('POST', 'https://openrouter.ai/api/v1/chat/completions'),
                )

        with (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch('backend.openrouter.httpx.AsyncClient', return_value=FakeClient()),
        ):
            result = await query_model_result(
                'microsoft/phi-4-reasoning-plus',
                [{'role': 'user', 'content': 'q'}],
            )

        self.assertTrue(result['ok'])
        self.assertEqual(catalogue_model_id('microsoft/phi-4-reasoning-plus'), 'microsoft/phi-4-reasoning-plus')
        self.assertEqual(captured['json']['model'], 'microsoft/phi-4-reasoning-plus')
        self.assertNotIn('reasoning', captured['json'])
        self.assertEqual(captured['json']['max_tokens'], OPENROUTER_MAX_TOKENS)

    async def test_missing_choices_is_empty_response(self):
        response = httpx.Response(
            200,
            json={'usage': {}},
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
            result = await query_model_result('openai/gpt-real', [{'role': 'user', 'content': 'q'}])

        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['message'], 'Empty model response')

    async def test_reasoning_only_reply_is_an_answer(self):
        def handler(*args, **kwargs):
            return _response(200, {
                'choices': [{
                    'message': {'content': '', 'reasoning': 'the visible answer'},
                }],
                'usage': {},
            })

        with (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch('backend.openrouter.httpx.AsyncClient', return_value=_fake_client(handler)),
        ):
            result = await query_model_result(
                'nvidia/nemotron-3-ultra-550b-a55b:free',
                [{'role': 'user', 'content': 'q'}],
            )

        self.assertTrue(result['ok'])
        self.assertEqual(result['content'], 'the visible answer')

    async def test_reasoning_details_fill_an_empty_content(self):
        def handler(*args, **kwargs):
            return _response(200, {
                'choices': [{
                    'message': {
                        'content': None,
                        'reasoning_details': [{'text': 'from details'}],
                    },
                }],
                'usage': {},
            })

        with (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch('backend.openrouter.httpx.AsyncClient', return_value=_fake_client(handler)),
        ):
            result = await query_model_result(
                'openai/gpt-4.1',
                [{'role': 'user', 'content': 'q'}],
            )

        self.assertTrue(result['ok'])
        self.assertEqual(result['content'], 'from details')

    async def test_harness_only_403_is_not_retried(self):
        original = list(settings.council_models)
        original_chairman = settings.chairman_model
        original_samples = settings.n_samples
        settings.council_models = [
            'thinkingmachines/inkling:free',
            'google/gemma-4-31b-it:free',
        ]
        settings.chairman_model = 'google/gemma-4-31b-it:free'
        calls = {'n': 0}

        def handler(*args, **kwargs):
            calls['n'] += 1
            return _response(403, {
                'error': {
                    'message': (
                        'thinkingmachines/inkling:free is only available '
                        'on agentic harnesses.'
                    ),
                },
            })

        messages = [{'role': 'user', 'content': 'q'}]
        try:
            with (
                patch('backend.openrouter.get_api_key', return_value='sk-test'),
                patch(
                    'backend.openrouter.httpx.AsyncClient',
                    return_value=_fake_client(handler),
                ),
            ):
                first = await query_model_result(
                    'thinkingmachines/inkling:free', messages
                )
                second = await query_model_result(
                    'thinkingmachines/inkling:free', messages
                )
            self.assertFalse(first['ok'])
            self.assertTrue(first.get('skipped'))
            self.assertTrue(second.get('skipped'))
            self.assertEqual(calls['n'], 1)
            self.assertIn('thinkingmachines/inkling:free', blocked_ids())
            self.assertEqual(
                settings.council_models,
                ['google/gemma-4-31b-it:free'],
            )
            self.assertEqual(
                settings.chairman_model, 'google/gemma-4-31b-it:free'
            )
        finally:
            settings.council_models = original
            settings.chairman_model = original_chairman
            settings.n_samples = original_samples

    async def test_upstream_429_cools_that_model(self):
        clock = _MonoClock()
        calls = {'n': 0}

        def handler(*args, **kwargs):
            calls['n'] += 1
            if calls['n'] == 1:
                return _response(429, {
                    'error': {
                        'message': 'Provider returned error',
                        'metadata': {
                            'raw': (
                                'google/gemma-4-31b-it:free is temporarily '
                                'rate-limited upstream.'
                            ),
                        },
                    },
                })
            return _response(200, {
                'choices': [{'message': {'content': 'ok'}}],
                'usage': {},
            })

        messages = [{'role': 'user', 'content': 'q'}]
        with (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch(
                'backend.openrouter.httpx.AsyncClient',
                return_value=_fake_client(handler),
            ),
            patch('backend.roster.time.monotonic', new=clock.monotonic),
            patch('backend.roster.asyncio.sleep', new=clock.sleep),
        ):
            first = await query_model_result('google/gemma-4-31b-it:free', messages)
            second = await query_model_result(
                'google/gemma-4-31b-it:free-reasoning-high', messages
            )
            self.assertTrue(first.get('skipped'))
            self.assertTrue(second.get('skipped'))
            self.assertEqual(calls['n'], 1)
            clock.now += 600
            third = await query_model_result('google/gemma-4-31b-it:free', messages)
        self.assertTrue(third['ok'])
        self.assertEqual(calls['n'], 2)

    async def test_provider_text_with_free_minute_still_retries(self):
        clock = _MonoClock()
        calls = {'n': 0}

        def handler(*args, **kwargs):
            calls['n'] += 1
            if calls['n'] == 1:
                return _response(429, {
                    'error': {
                        'message': 'Provider returned error',
                        'metadata': {
                            'raw': 'Rate limit exceeded: free-models-per-min',
                        },
                    },
                }, headers={'Retry-After': '10'})
            return _response(200, {
                'choices': [{'message': {'content': 'ok'}}],
                'usage': {},
            })

        messages = [{'role': 'user', 'content': 'q'}]
        with (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch(
                'backend.openrouter.httpx.AsyncClient',
                return_value=_fake_client(handler),
            ),
            patch('backend.roster.time.monotonic', new=clock.monotonic),
            patch('backend.roster.asyncio.sleep', new=clock.sleep),
        ):
            result = await query_model_result('a/one:free', messages)
        self.assertTrue(result['ok'])
        self.assertEqual(calls['n'], 2)

    async def test_free_calls_start_at_least_3_seconds_apart(self):
        clock = _MonoClock()

        def handler(*args, **kwargs):
            clock.starts.append(clock.now)
            return _response(200, {
                'choices': [{'message': {'content': 'ok'}}],
                'usage': {},
            })

        messages = [{'role': 'user', 'content': 'q'}]
        with (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch('backend.openrouter.httpx.AsyncClient', return_value=_fake_client(handler)),
            patch('backend.roster.time.monotonic', new=clock.monotonic),
            patch('backend.roster.asyncio.sleep', new=clock.sleep),
        ):
            await asyncio.gather(
                query_model_result('a/one:free', messages),
                query_model_result('b/two:free', messages),
            )

        self.assertEqual(FREE_START_GAP_SECONDS, 3)
        self.assertEqual(clock.starts, [0.0, 3.0])

    async def test_free_models_per_min_waits_then_succeeds(self):
        clock = _MonoClock()
        calls = {'n': 0}

        def handler(*args, **kwargs):
            calls['n'] += 1
            clock.starts.append(clock.now)
            if calls['n'] == 1:
                return _response(429, {
                    'error': {
                        'message': 'Rate limit exceeded: free-models-per-min',
                    },
                })
            return _response(200, {
                'choices': [{'message': {'content': 'ok'}}],
                'usage': {},
            })

        with (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch('backend.openrouter.httpx.AsyncClient', return_value=_fake_client(handler)),
            patch('backend.roster.time.monotonic', new=clock.monotonic),
            patch('backend.roster.asyncio.sleep', new=clock.sleep),
        ):
            result = await query_model_result(
                'google/gemma-4-31b-it:free',
                [{'role': 'user', 'content': 'q'}],
            )

        self.assertTrue(result['ok'])
        self.assertEqual(result['content'], 'ok')
        self.assertEqual(calls['n'], 2)
        self.assertEqual(clock.starts, [0.0, 60.0])

    async def test_paid_call_is_not_queued_behind_free(self):
        started = []
        release = asyncio.Event()

        async def handler(*args, **kwargs):
            model = kwargs['json']['model']
            started.append(model)
            if str(model).endswith(':free'):
                await release.wait()
            return _response(200, {
                'choices': [{'message': {'content': 'ok'}}],
                'usage': {},
            })

        messages = [{'role': 'user', 'content': 'q'}]
        free_task = None
        paid_task = None
        with (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch('backend.openrouter.httpx.AsyncClient', return_value=_fake_client(handler)),
        ):
            free_task = asyncio.create_task(
                query_model_result('google/gemma-4-31b-it:free', messages)
            )
            try:
                for _ in range(20):
                    if started:
                        break
                    await asyncio.sleep(0)
                paid_task = asyncio.create_task(
                    query_model_result('openai/gpt-4.1', messages)
                )
                for _ in range(20):
                    if 'openai/gpt-4.1' in started:
                        break
                    await asyncio.sleep(0)
                self.assertIn('google/gemma-4-31b-it:free', started)
                self.assertIn('openai/gpt-4.1', started)
            finally:
                release.set()
                pending = [task for task in (free_task, paid_task) if task]
                if pending:
                    await asyncio.gather(*pending)


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

    async def test_stage1_skips_a_model_missing_from_the_catalogue(self):
        original_models = list(settings.council_models)
        original_chairman = settings.chairman_model
        settings.council_models = [
            'google/gemma-4-31b-it:free',
            'apodex/apodex-1.1-mini:free',
        ]
        settings.chairman_model = 'apodex/apodex-1.1-mini:free-reasoning-high'
        queried = []

        async def fake_result(model, messages, **kwargs):
            queried.append(model)
            return {'ok': True, 'content': 'yes', 'usage': {}}

        async def pricing():
            return {'google/gemma-4-31b-it:free': {}}

        try:
            with (
                patch('backend.council.query_model_result', new=fake_result),
                patch('backend.openrouter.get_models_pricing', new=pricing),
            ):
                events = []
                async for event in stage1_collect_responses_streaming('q', n=1):
                    events.append(event)
            self.assertEqual(queried, ['google/gemma-4-31b-it:free'])
            self.assertEqual(
                settings.council_models,
                ['google/gemma-4-31b-it:free'],
            )
            self.assertEqual(
                settings.chairman_model,
                'google/gemma-4-31b-it:free-reasoning-high',
            )
            complete = next(
                event[1] for event in events if event[0] == 'all_complete'
            )
            self.assertEqual(len(complete['results']), 1)
        finally:
            settings.council_models = original_models
            settings.chairman_model = original_chairman
            settings.n_samples = 3

    def test_all_failed_exception_keeps_failures(self):
        failures = [{'model': 'a', 'error': {'message': '402: cannot afford reserved tokens'}}]
        exc = Stage1AllFailed(failures)
        self.assertEqual(list(exc.failures), failures)
        self.assertIn('All models failed', str(exc))

    def test_all_skipped_stage1_says_the_models_are_unavailable(self):
        exc = Stage1AllFailed([])
        self.assertEqual(str(exc), MODELS_UNAVAILABLE)


class SkippedLaterStageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.models = list(settings.council_models)
        self.chairman = settings.chairman_model

    def tearDown(self):
        settings.council_models = self.models
        settings.chairman_model = self.chairman

    async def test_stage2_skips_without_a_failure_row(self):
        settings.council_models = ['a/one:free', 'openai/gpt-4.1']
        stage1 = [{'model': 'openai/gpt-4.1', 'response': 'answer'}]

        async def fake(model, messages, **kwargs):
            if str(model).endswith(':free'):
                return {
                    'ok': False,
                    'skipped': True,
                    'error': {'message': 'Skipped'},
                }
            return {
                'ok': True,
                'content': 'FINAL RANKING:\n1. Response 1',
                'usage': {},
            }

        events = []
        with patch('backend.council.query_model_result', new=fake):
            async for event in stage2_collect_rankings_streaming('q', stage1):
                events.append(event)
        complete = next(data for kind, data in events if kind == 'all_complete')
        self.assertEqual(complete['failures'], [])
        self.assertEqual(len(complete['results']), 1)
        skipped = [data for kind, data in events if kind == 'model_failed']
        self.assertEqual(len(skipped), 1)
        self.assertTrue(skipped[0]['skipped'])

    async def test_skipped_red_team_is_a_miss(self):
        async def fake(model, messages, **kwargs):
            return {
                'ok': False,
                'skipped': True,
                'error': {'message': 'Skipped'},
            }

        with patch('backend.council.query_model_result', new=fake):
            result = await red_team_review(
                'q',
                'answer',
                0,
                [],
                [{'model': 'openai/gpt-4.1', 'response': 'answer'}],
            )
        self.assertIsNone(result)

    async def test_cooled_chairman_uses_the_next_council_model(self):
        from backend.roster import remember_model_cooldown

        settings.chairman_model = 'google/gemma-4-31b-it:free'
        settings.council_models = [
            'google/gemma-4-31b-it:free',
            'openai/gpt-4.1',
        ]
        remember_model_cooldown('google/gemma-4-31b-it:free', 1)
        called = []

        async def fake(model, messages, **kwargs):
            called.append(model)
            return {'ok': True, 'content': 'final', 'usage': {}}

        with patch('backend.council.query_model_result', new=fake):
            result = await stage3_synthesize_final(
                'q',
                [{'model': 'openai/gpt-4.1', 'response': 'a'}],
            )
        self.assertEqual(called, ['openai/gpt-4.1'])
        self.assertEqual(result['model'], 'openai/gpt-4.1')
        self.assertEqual(
            settings.chairman_model,
            'google/gemma-4-31b-it:free',
        )

    async def test_skipped_chairman_call_uses_the_next_council_model(self):
        settings.chairman_model = 'google/gemma-4-31b-it:free-reasoning-high'
        settings.council_models = [
            'google/gemma-4-31b-it:free',
            'openai/gpt-4.1',
        ]
        called = []

        async def fake(model, messages, **kwargs):
            called.append(model)
            if 'gemma' in model:
                return {
                    'ok': False,
                    'skipped': True,
                    'error': {'message': 'Skipped'},
                }
            return {'ok': True, 'content': 'final', 'usage': {}}

        with patch('backend.council.query_model_result', new=fake):
            result = await stage3_synthesize_final(
                'q',
                [{'model': 'openai/gpt-4.1', 'response': 'a'}],
            )
        self.assertEqual(called, [
            'google/gemma-4-31b-it:free-reasoning-high',
            'openai/gpt-4.1',
        ])
        self.assertEqual(result['model'], 'openai/gpt-4.1')
        self.assertEqual(
            settings.chairman_model,
            'google/gemma-4-31b-it:free-reasoning-high',
        )

    async def test_real_chairman_failure_does_not_try_another_model(self):
        settings.chairman_model = 'google/gemma-4-31b-it:free'
        settings.council_models = ['openai/gpt-4.1']
        called = []

        async def fake(model, messages, **kwargs):
            called.append(model)
            return {
                'ok': False,
                'error': {'message': '402: cannot afford reserved tokens'},
            }

        with patch('backend.council.query_model_result', new=fake):
            with self.assertRaises(Exception) as raised:
                await stage3_synthesize_final(
                    'q',
                    [{'model': 'openai/gpt-4.1', 'response': 'a'}],
                )
        self.assertIn('402: cannot afford reserved tokens', str(raised.exception))
        self.assertEqual(called, ['google/gemma-4-31b-it:free'])

    async def test_every_skipped_synthesizer_says_the_models_are_unavailable(self):
        settings.chairman_model = 'google/gemma-4-31b-it:free'
        settings.council_models = ['openai/gpt-4.1']

        async def fake(model, messages, **kwargs):
            return {
                'ok': False,
                'skipped': True,
                'error': {'message': 'Skipped'},
            }

        with patch('backend.council.query_model_result', new=fake):
            with self.assertRaises(Exception) as raised:
                await stage3_synthesize_final(
                    'q',
                    [{'model': 'openai/gpt-4.1', 'response': 'a'}],
                )
        self.assertEqual(str(raised.exception), MODELS_UNAVAILABLE)


if __name__ == '__main__':
    unittest.main()

