"""Refused free models skip transport until their refusal expires."""

import asyncio
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch

import httpx

from backend.openrouter import parse_http_error, parse_retry_after
from backend.openrouter import query_model_result
from backend.roster import (
    blocked_ids,
    clear_model_cooldowns,
    is_model_unavailable,
    remember_blocked_id,
    remember_model_cooldown,
    reset_free_queue_for_tests,
)
from backend.settings import settings
from backend.test_openrouter_errors import _MonoClock, _fake_client, _response


GEMMA = 'google/gemma-4-31b-it:free'
INKLING = 'thinkingmachines/inkling:free'
MESSAGES = [{'role': 'user', 'content': 'q'}]


def _provider_error(raw='temporarily rate-limited upstream', headers=None):
    return _response(429, {
        'error': {
            'message': 'Provider returned error',
            'metadata': {'raw': raw},
        },
    }, headers=headers)


def _ok():
    return _response(200, {
        'choices': [{'message': {'content': 'ok'}}],
        'usage': {},
    })


@contextmanager
def _transport(clock, handler):
    with (
        patch('backend.openrouter.get_api_key', return_value='sk-test'),
        patch(
            'backend.openrouter.httpx.AsyncClient',
            return_value=_fake_client(handler),
        ),
        patch('backend.roster.time.monotonic', new=clock.monotonic),
        patch('backend.roster.asyncio.sleep', new=clock.sleep),
    ):
        yield


class RawErrorTests(unittest.TestCase):
    def test_raw_strings_and_objects_keep_the_primary_message(self):
        for raw in (
            'temporarily rate-limited upstream',
            {'error': {'message': 'temporarily rate-limited upstream'}},
        ):
            with self.subTest(raw=raw):
                error = parse_http_error(_provider_error(raw))
                self.assertEqual(
                    error['message'], 'HTTP 429: Provider returned error'
                )
                self.assertIn('Provider returned error', error['detail'])
                self.assertIn(
                    'temporarily rate-limited upstream', error['detail']
                )

    def test_non_object_json_and_plain_text_are_readable(self):
        for response in (
            httpx.Response(429, json=['temporarily rate-limited upstream']),
            httpx.Response(429, text='temporarily rate-limited upstream'),
        ):
            with self.subTest(body=response.text):
                error = parse_http_error(response)
                self.assertIn(
                    'temporarily rate-limited upstream', error['detail']
                )

    def test_missing_or_invalid_metadata_does_not_break_parsing(self):
        for metadata in (None, 'unexpected', {'raw': None}):
            with self.subTest(metadata=metadata):
                error = parse_http_error(_response(403, {
                    'error': {'message': 'Forbidden', 'metadata': metadata},
                }))
                self.assertEqual(error['detail'], 'Forbidden')

    def test_retry_after_keeps_the_existing_default_cap(self):
        self.assertEqual(parse_retry_after('900', 1), 60)
        self.assertEqual(
            parse_retry_after('900', 600, max_seconds=3600), 900
        )
        self.assertEqual(
            parse_retry_after('NaN', 600, max_seconds=3600), 600
        )


class ModelRefusalTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.models = list(settings.council_models)
        self.chairman = settings.chairman_model
        self.red_team = settings.red_team_model
        self.samples = settings.n_samples

    def tearDown(self):
        settings.council_models = self.models
        settings.chairman_model = self.chairman
        settings.red_team_model = self.red_team
        settings.n_samples = self.samples

    async def test_provider_refusal_skips_once_then_reopens_at_expiry(self):
        clock = _MonoClock()
        starts = []
        settings.council_models = [GEMMA, 'google/other:free']
        settings.chairman_model = GEMMA

        def handler(*args, **kwargs):
            starts.append((clock.now, kwargs['json']['model']))
            return _provider_error() if len(starts) == 1 else _ok()

        with _transport(clock, handler):
            first = await query_model_result(GEMMA, MESSAGES)
            repeated = await query_model_result(
                f'{GEMMA}-reasoning-high', MESSAGES
            )
            self.assertTrue(first['skipped'])
            self.assertEqual(first['skip_reason'], 'provider_cooldown')
            self.assertEqual(first['error']['status'], 429)
            self.assertEqual(first, repeated)
            self.assertEqual(starts, [(0, GEMMA)])
            self.assertEqual(clock.sleeps, [])
            self.assertNotIn(GEMMA, blocked_ids())
            self.assertEqual(
                settings.council_models, [GEMMA, 'google/other:free']
            )
            self.assertEqual(settings.chairman_model, GEMMA)

            # Another id from the same vendor stays available.
            other = await query_model_result('google/other:free', MESSAGES)
            self.assertTrue(other['ok'])
            self.assertEqual(starts[-1], (3, 'google/other:free'))
            clock.now = 599.999
            self.assertTrue(is_model_unavailable(GEMMA))
            skipped = await query_model_result(GEMMA, MESSAGES)
            self.assertTrue(skipped['skipped'])
            clock.now = 600
            self.assertFalse(is_model_unavailable(GEMMA))
            recovered = await query_model_result(GEMMA, MESSAGES)
            self.assertTrue(recovered['ok'])
            self.assertEqual(starts[-1], (600, GEMMA))

    async def test_retry_after_minimum_maximum_and_invalid_values(self):
        for header, duration in (
            ('30', 600), ('900', 900), ('7200', 3600),
            ('invalid', 600), ('NaN', 600),
        ):
            with self.subTest(header=header):
                clear_model_cooldowns()
                reset_free_queue_for_tests()
                clock = _MonoClock()

                def handler(*args, **kwargs):
                    return _provider_error(headers={'Retry-After': header})

                with _transport(clock, handler):
                    result = await query_model_result(GEMMA, MESSAGES)
                    self.assertTrue(result['skipped'])
                    clock.now = duration - 0.001
                    self.assertTrue(is_model_unavailable(GEMMA))
                    clock.now = duration
                    self.assertFalse(is_model_unavailable(GEMMA))
                    self.assertEqual(clock.sleeps, [])

    async def test_retry_after_http_date_preserves_a_long_provider_wait(self):
        clock = _MonoClock()

        def handler(*args, **kwargs):
            return _provider_error(headers={
                'Retry-After': 'Fri, 16 Oct 2026 12:15:00 GMT',
            })

        with _transport(clock, handler), patch(
            'backend.openrouter.datetime'
        ) as current_time:
            current_time.now.return_value = datetime(
                2026, 10, 16, 12, tzinfo=timezone.utc
            )
            result = await query_model_result(GEMMA, MESSAGES)
            self.assertTrue(result['skipped'])
            clock.now = 899
            self.assertTrue(is_model_unavailable(GEMMA))
            clock.now = 900
            self.assertFalse(is_model_unavailable(GEMMA))

    async def test_nested_shared_quota_takes_priority(self):
        for raw in (
            'Rate limit exceeded: free-models-per-min',
            {'error': {'message': 'Rate limit exceeded: free-models-per-min'}},
        ):
            with self.subTest(raw=raw):
                reset_free_queue_for_tests()
                clock = _MonoClock()
                starts = []

                def handler(*args, **kwargs):
                    starts.append(clock.now)
                    return _provider_error(raw) if len(starts) == 1 else _ok()

                with _transport(clock, handler):
                    result = await query_model_result(GEMMA, MESSAGES)
                    self.assertTrue(result['ok'])
                    self.assertFalse(is_model_unavailable(GEMMA))
                    self.assertEqual(starts, [0, 60])

    async def test_unrelated_429_and_paid_provider_429_keep_short_retry(self):
        for model, first_response, second_at in (
            (GEMMA, _response(429, {'error': {'message': 'Slow down'}}), 3),
            ('google/paid', _provider_error(), 1),
        ):
            with self.subTest(model=model):
                reset_free_queue_for_tests()
                clock = _MonoClock()
                starts = []

                def handler(*args, **kwargs):
                    starts.append(clock.now)
                    return first_response if len(starts) == 1 else _ok()

                with _transport(clock, handler):
                    result = await query_model_result(model, MESSAGES)
                    self.assertTrue(result['ok'])
                    self.assertFalse(is_model_unavailable(model))
                    self.assertEqual(starts, [0, second_at])

    async def test_generic_403_remains_a_failure(self):
        clock = _MonoClock()
        starts = []

        def handler(*args, **kwargs):
            starts.append(clock.now)
            return _response(403, {
                'error': {'message': 'Invalid credentials'},
            })

        with _transport(clock, handler):
            result = await query_model_result(GEMMA, MESSAGES)
            self.assertFalse(result.get('skipped'))
            self.assertEqual(result['error']['status'], 403)
            self.assertFalse(is_model_unavailable(GEMMA))
            self.assertEqual(starts, [0])

    async def test_upstream_text_skips_without_generic_provider_text(self):
        for body in (
            {'error': {
                'message': 'Rate limited',
                'metadata': {'raw': 'temporarily rate-limited upstream'},
            }},
            None,
        ):
            with self.subTest(body=body):
                clear_model_cooldowns()
                reset_free_queue_for_tests()
                clock = _MonoClock()
                starts = []

                def handler(*args, **kwargs):
                    starts.append(clock.now)
                    if body is not None:
                        return _response(429, body)
                    return httpx.Response(
                        429,
                        text='temporarily rate-limited upstream',
                        request=httpx.Request(
                            'POST',
                            'https://openrouter.ai/api/v1/chat/completions',
                        ),
                    )

                with _transport(clock, handler):
                    result = await query_model_result(GEMMA, MESSAGES)
                    self.assertTrue(result['skipped'])
                    self.assertEqual(result['error']['status'], 429)
                    self.assertEqual(starts, [0])

    async def test_queued_duplicate_variants_do_not_consume_free_starts(self):
        clock = _MonoClock()
        starts = []
        response_started = asyncio.Event()
        release_response = asyncio.Event()

        async def handler(*args, **kwargs):
            starts.append((clock.now, kwargs['json']['model']))
            if len(starts) == 1:
                response_started.set()
                await release_response.wait()
                return _provider_error()
            return _ok()

        with _transport(clock, handler):
            first = asyncio.create_task(query_model_result(GEMMA, MESSAGES))
            await response_started.wait()
            duplicate = asyncio.create_task(query_model_result(
                f'{GEMMA}-reasoning', MESSAGES
            ))
            await clock.sleep(0)
            release_response.set()
            results = await asyncio.gather(first, duplicate)
            self.assertTrue(all(result['skipped'] for result in results))
            self.assertEqual(starts, [(0, GEMMA)])
            next_result = await query_model_result('other/free:free', MESSAGES)
            self.assertTrue(next_result['ok'])
            self.assertEqual(starts[-1], (3, 'other/free:free'))

    async def test_harness_refusal_in_raw_skips_first_and_queued_variant(self):
        clock = _MonoClock()
        starts = []
        settings.council_models = [INKLING, GEMMA]
        settings.chairman_model = GEMMA

        def handler(*args, **kwargs):
            starts.append(clock.now)
            return _response(403, {
                'error': {
                    'message': 'Provider returned error',
                    'metadata': {'raw': {
                        'message': 'Only available on agentic harnesses',
                    }},
                },
            })

        with _transport(clock, handler):
            results = await asyncio.gather(
                query_model_result(INKLING, MESSAGES),
                query_model_result(f'{INKLING}-reasoning-high', MESSAGES),
            )
            self.assertTrue(all(result['skipped'] for result in results))
            self.assertTrue(all(
                result['skip_reason'] == 'harness_only' for result in results
            ))
            self.assertEqual(results[0]['error'], results[1]['error'])
            self.assertEqual(starts, [0])
            self.assertEqual(clock.sleeps, [])
            self.assertEqual(settings.council_models, [GEMMA])

    async def test_refusal_while_waiting_does_not_reserve_a_start(self):
        clock = _MonoClock()
        starts = []

        def handler(*args, **kwargs):
            starts.append((clock.now, kwargs['json']['model']))
            return _ok()

        with _transport(clock, handler):
            await query_model_result('other/first:free', MESSAGES)
            clock.on_sleep = lambda: remember_model_cooldown(GEMMA, 600)
            result = await query_model_result(GEMMA, MESSAGES)
            self.assertTrue(result['skipped'])
            await query_model_result('other/next:free', MESSAGES)
            self.assertEqual(starts, [
                (0, 'other/first:free'), (3, 'other/next:free'),
            ])

    async def test_refusal_during_client_setup_does_not_reserve_a_start(self):
        clock = _MonoClock()
        starts = []

        class Client:
            async def __aenter__(self):
                remember_model_cooldown(GEMMA, 600)
                return self

            async def __aexit__(self, *args):
                return False

            async def post(self, *args, **kwargs):
                starts.append(clock.now)
                return _ok()

        with (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch(
                'backend.openrouter.httpx.AsyncClient', return_value=Client(),
            ),
            patch('backend.roster.time.monotonic', new=clock.monotonic),
        ):
            result = await query_model_result(GEMMA, MESSAGES)
            self.assertTrue(result['skipped'])
            self.assertEqual(starts, [])

    async def test_known_refusals_never_enter_the_free_queue(self):
        clock = _MonoClock()
        with patch('backend.roster.time.monotonic', new=clock.monotonic):
            remember_model_cooldown(GEMMA, 600)
            remember_blocked_id(INKLING)
            with patch('backend.openrouter.run_free_call') as queue:
                for model in (GEMMA, INKLING):
                    result = await query_model_result(model, MESSAGES)
                    self.assertTrue(result['skipped'])
                queue.assert_not_called()
