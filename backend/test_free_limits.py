"""Free-council sample cap and the shared free-start window."""

import asyncio
import unittest
from unittest.mock import patch

from backend.council import (
    stage1_collect_responses,
    stage1_collect_responses_streaming,
)
from backend.openrouter import query_model_result
from backend.roster import (
    FREE_MAX_STARTS_PER_MINUTE,
    FREE_MINUTE_SECONDS,
    FREE_START_GAP_SECONDS,
    RosterEmpty,
    clear_blocked_ids,
    drop_blocked_model,
    pause_free_queue,
)
from backend.settings import settings
from backend.test_openrouter_errors import _MonoClock, _fake_client, _response


def _ok_body(text='ok'):
    return {
        'choices': [{'message': {'content': text}}],
        'usage': {},
    }


def _assert_schedule(test, starts):
    for index, start in enumerate(starts):
        if index:
            test.assertGreaterEqual(
                start - starts[index - 1], FREE_START_GAP_SECONDS - 1e-9
            )
        window = [
            item for item in starts
            if start - FREE_MINUTE_SECONDS < item <= start
        ]
        test.assertLessEqual(len(window), FREE_MAX_STARTS_PER_MINUTE)


_REAL_SLEEP = asyncio.sleep


class FreeSampleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_models = list(settings.council_models)
        self.original_chairman = settings.chairman_model
        self.original_red = settings.red_team_model
        self.original_samples = settings.n_samples

    def tearDown(self):
        settings.council_models = self.original_models
        settings.chairman_model = self.original_chairman
        settings.red_team_model = self.original_red
        settings.n_samples = self.original_samples

    async def _collect(self, n, existing=None):
        queried = []

        async def fake_result(model, messages, **kwargs):
            queried.append(model)
            return {'ok': True, 'content': f'ok {model}', 'usage': {}}

        events = []
        with patch('backend.council.query_model_result', new=fake_result):
            async for event in stage1_collect_responses_streaming(
                'q', n=n, existing_results=existing,
            ):
                events.append(event)
        return queried, events

    async def test_explicit_n_is_one_for_an_all_free_council(self):
        settings.council_models = ['a/one:free', 'b/two:free']
        settings.chairman_model = 'openai/gpt-4.1'
        settings.red_team_model = 'openai/gpt-4.1'
        settings.n_samples = 3
        queried, events = await self._collect(3)
        self.assertCountEqual(queried, ['a/one:free', 'b/two:free'])
        self.assertEqual(settings.n_samples, 1)
        init = next(event[1] for event in events if event[0] == 'init')
        self.assertEqual(init['total_models'], 2)

        async def fake_result(model, messages, **kwargs):
            queried.append(model)
            return {'ok': True, 'content': 'ok', 'usage': {}}

        queried.clear()
        with patch('backend.council.query_model_result', new=fake_result):
            results, _failures = await stage1_collect_responses('q', n=3)
        self.assertEqual(len(results), 2)
        self.assertCountEqual(queried, ['a/one:free', 'b/two:free'])

    async def test_mixed_council_keeps_the_explicit_count(self):
        settings.council_models = ['a/one:free', 'openai/gpt-4.1']
        settings.chairman_model = 'openai/gpt-4.1'
        settings.n_samples = 3
        queried, _events = await self._collect(3)
        self.assertEqual(queried.count('a/one:free'), 3)
        self.assertEqual(queried.count('openai/gpt-4.1'), 3)
        self.assertEqual(settings.n_samples, 3)

    async def test_resume_drops_samples_past_the_free_limit(self):
        settings.council_models = ['a/one:free']
        settings.chairman_model = 'openai/gpt-4.1'
        settings.n_samples = 3
        existing = [
            {'model': 'a/one:free', 'response': 'first'},
            {'model': 'a/one:free', 'response': 'second'},
            {'model': 'a/one:free', 'response': 'third'},
        ]
        queried, events = await self._collect(3, existing)
        self.assertEqual(queried, [])
        complete = next(event[1] for event in events if event[0] == 'all_complete')
        self.assertEqual(complete['results'], [existing[0]])
        self.assertEqual(settings.n_samples, 1)

    async def test_reasoning_suffix_and_pruning_use_the_free_roster(self):
        settings.council_models = [
            'gone/dead:free',
            'google/gemma:free-reasoning-high',
        ]
        settings.chairman_model = 'openai/gpt-4.1'
        settings.n_samples = 3

        async def pricing():
            return {
                'google/gemma:free': {},
                'openai/gpt-4.1': {},
            }

        queried = []

        async def fake_result(model, messages, **kwargs):
            queried.append(model)
            return {'ok': True, 'content': 'ok', 'usage': {}}

        with (
            patch('backend.council.query_model_result', new=fake_result),
            patch('backend.openrouter.get_models_pricing', new=pricing),
        ):
            async for _event in stage1_collect_responses_streaming('q', n=3):
                pass
        self.assertEqual(
            settings.council_models,
            ['google/gemma:free-reasoning-high'],
        )
        self.assertEqual(settings.n_samples, 1)
        self.assertEqual(queried, ['google/gemma:free-reasoning-high'])

    async def test_empty_roster_stays_invalid(self):
        settings.council_models = ['gone/dead:free']
        settings.chairman_model = 'gone/dead:free'
        settings.n_samples = 3

        async def pricing():
            return {'google/gemma:free': {}}

        with patch('backend.openrouter.get_models_pricing', new=pricing):
            with self.assertRaises(RosterEmpty):
                async for _event in stage1_collect_responses_streaming('q', n=3):
                    pass
        self.assertEqual(settings.n_samples, 3)
        self.assertEqual(settings.council_models, ['gone/dead:free'])

    async def test_empty_catalogue_still_caps_samples(self):
        settings.council_models = ['a/one:free']
        settings.chairman_model = 'openai/gpt-4.1'
        settings.n_samples = 3
        queried = []

        async def fake_result(model, messages, **kwargs):
            queried.append(model)
            return {'ok': True, 'content': 'ok', 'usage': {}}

        async def pricing():
            return {}

        with (
            patch('backend.council.query_model_result', new=fake_result),
            patch('backend.openrouter.get_models_pricing', new=pricing),
        ):
            results, _failures = await stage1_collect_responses('q', n=3)
        self.assertEqual(len(results), 1)
        self.assertEqual(queried, ['a/one:free'])
        self.assertEqual(settings.council_models, ['a/one:free'])
        self.assertEqual(settings.n_samples, 1)


class FreeWindowTests(unittest.IsolatedAsyncioTestCase):
    def _patch_clock(self, clock, handler):
        return (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch(
                'backend.openrouter.httpx.AsyncClient',
                return_value=_fake_client(handler),
            ),
            patch('backend.roster.time.monotonic', new=clock.monotonic),
            patch('backend.roster.asyncio.sleep', new=clock.sleep),
        )

    async def test_eighteen_starts_follow_the_window(self):
        clock = _MonoClock()
        starts = []

        def handler(*args, **kwargs):
            starts.append(clock.now)
            return _response(200, _ok_body())

        messages = [{'role': 'user', 'content': 'q'}]
        patches = self._patch_clock(clock, handler)
        with patches[0], patches[1], patches[2], patches[3]:
            await asyncio.gather(*[
                query_model_result(f'm{index}/x:free', messages)
                for index in range(18)
            ])
        self.assertEqual(
            starts,
            [index * 3.0 for index in range(16)] + [60.0, 63.0],
        )
        _assert_schedule(self, starts)

    async def test_long_run_then_idle_starts_immediately(self):
        clock = _MonoClock()
        starts = []

        def handler(*args, **kwargs):
            starts.append(clock.now)
            return _response(200, _ok_body())

        messages = [{'role': 'user', 'content': 'q'}]
        patches = self._patch_clock(clock, handler)
        with patches[0], patches[1], patches[2], patches[3]:
            for index in range(34):
                await query_model_result(f'm{index}/x:free', messages)
            _assert_schedule(self, starts)
            self.assertEqual(len(starts), 34)
            slept = len(clock.sleeps)
            clock.now += 61
            await query_model_result('idle/x:free', messages)
        self.assertEqual(len(clock.sleeps), slept)
        self.assertEqual(starts[-1], starts[-2] + 61)
        _assert_schedule(self, starts)

    async def test_waiting_retry_rereads_an_extended_cooldown(self):
        clock = _MonoClock()
        starts = []
        calls = {'n': 0}

        def handler(*args, **kwargs):
            calls['n'] += 1
            starts.append(clock.now)
            if calls['n'] == 1:
                return _response(429, {
                    'error': {
                        'message': 'Rate limit exceeded: free-models-per-min',
                    },
                }, headers={'Retry-After': '10'})
            return _response(200, _ok_body())

        def extend():
            pause_free_queue(25)

        clock.on_sleep = extend
        messages = [{'role': 'user', 'content': 'q'}]
        patches = self._patch_clock(clock, handler)
        with patches[0], patches[1], patches[2], patches[3]:
            result = await query_model_result('a/one:free', messages)
        self.assertTrue(result['ok'])
        self.assertEqual(calls['n'], 2)
        self.assertEqual(starts, [0.0, 25.0])

    async def test_paid_call_bypasses_a_full_free_window(self):
        clock = _MonoClock()
        free_starts = []
        paid_starts = []

        def handler(*args, **kwargs):
            model = kwargs['json']['model']
            if str(model).endswith(':free'):
                free_starts.append(clock.now)
            else:
                paid_starts.append(clock.now)
            return _response(200, _ok_body())

        messages = [{'role': 'user', 'content': 'q'}]
        patches = self._patch_clock(clock, handler)
        with patches[0], patches[1], patches[2], patches[3]:
            for index in range(16):
                await query_model_result(f'm{index}/x:free', messages)
            paid_at = clock.now
            await query_model_result('openai/gpt-4.1', messages)
            self.assertEqual(paid_starts, [paid_at])
            self.assertEqual(len(free_starts), 16)
            await query_model_result('next/x:free', messages)
        self.assertEqual(free_starts[-1], 60.0)
        self.assertEqual(len(free_starts), 17)

    async def test_cancel_before_dispatch_does_not_consume_a_slot(self):
        clock = _MonoClock()
        starts = []
        parked = asyncio.Event()
        mode = {'park': False}

        def handler(*args, **kwargs):
            starts.append(clock.now)
            return _response(200, _ok_body())

        async def sleep(seconds):
            if mode['park']:
                mode['park'] = False
                parked.set()
                await asyncio.Event().wait()
            clock.now += seconds

        messages = [{'role': 'user', 'content': 'q'}]
        with (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch(
                'backend.openrouter.httpx.AsyncClient',
                return_value=_fake_client(handler),
            ),
            patch('backend.roster.time.monotonic', new=clock.monotonic),
            patch('backend.roster.asyncio.sleep', new=sleep),
        ):
            await query_model_result('a/one:free', messages)
            mode['park'] = True
            task = asyncio.create_task(
                query_model_result('b/two:free', messages)
            )
            await asyncio.wait_for(parked.wait(), timeout=2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(starts, [0.0])
            await asyncio.wait_for(
                query_model_result('c/three:free', messages), timeout=2,
            )
        self.assertEqual(starts, [0.0, 3.0])

    async def test_cancel_after_dispatch_keeps_the_start(self):
        clock = _MonoClock()
        starts = []
        release = asyncio.Event()

        async def handler(*args, **kwargs):
            starts.append(clock.now)
            if len(starts) == 1:
                await release.wait()
            return _response(200, _ok_body())

        messages = [{'role': 'user', 'content': 'q'}]
        patches = self._patch_clock(clock, handler)
        with patches[0], patches[1], patches[2], patches[3]:
            task = asyncio.create_task(
                query_model_result('a/one:free', messages)
            )
            for _ in range(50):
                if starts:
                    break
                await _REAL_SLEEP(0)
            self.assertEqual(starts, [0.0])
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(starts, [0.0])
            await query_model_result('b/two:free', messages)
        self.assertEqual(starts, [0.0, 3.0])

    async def test_transport_error_does_not_stick_the_queue(self):
        clock = _MonoClock()
        starts = []

        def handler(*args, **kwargs):
            starts.append(clock.now)
            if len(starts) == 1:
                raise RuntimeError('network down')
            return _response(200, _ok_body())

        messages = [{'role': 'user', 'content': 'q'}]
        patches = self._patch_clock(clock, handler)
        with patches[0], patches[1], patches[2], patches[3]:
            first = await query_model_result('a/one:free', messages)
            second = await query_model_result('b/two:free', messages)
        self.assertFalse(first['ok'])
        self.assertIn('network down', first['error']['message'])
        self.assertTrue(second['ok'])
        self.assertEqual(starts, [0.0, 3.0])

    async def test_final_free_minute_429_holds_the_next_start(self):
        clock = _MonoClock()
        starts = []
        calls = {'n': 0}

        def handler(*args, **kwargs):
            calls['n'] += 1
            starts.append(clock.now)
            if calls['n'] <= 5:
                return _response(429, {
                    'error': {
                        'message': 'Rate limit exceeded: free-models-per-min',
                    },
                }, headers={'Retry-After': '10'})
            return _response(200, _ok_body())

        messages = [{'role': 'user', 'content': 'q'}]
        patches = self._patch_clock(clock, handler)
        with patches[0], patches[1], patches[2], patches[3]:
            failed = await query_model_result('a/one:free', messages)
            followed = await query_model_result('b/two:free', messages)
        self.assertFalse(failed['ok'])
        self.assertTrue(followed['ok'])
        self.assertEqual(
            starts, [0.0, 10.0, 20.0, 30.0, 40.0, 50.0]
        )

    async def test_cancel_during_client_enter_does_not_consume_a_slot(self):
        clock = _MonoClock()
        starts = []
        entered = asyncio.Event()
        enters = {'n': 0}

        class Client:
            async def __aenter__(self):
                enters['n'] += 1
                if enters['n'] == 1:
                    entered.set()
                    await asyncio.Event().wait()
                return self

            async def __aexit__(self, *args):
                return False

            async def post(self, *args, **kwargs):
                starts.append(clock.now)
                return _response(200, _ok_body())

        messages = [{'role': 'user', 'content': 'q'}]
        with (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch(
                'backend.openrouter.httpx.AsyncClient',
                return_value=Client(),
            ),
            patch('backend.roster.time.monotonic', new=clock.monotonic),
            patch('backend.roster.asyncio.sleep', new=clock.sleep),
        ):
            task = asyncio.create_task(
                query_model_result('a/one:free', messages)
            )
            for _ in range(50):
                if entered.is_set():
                    break
                await _REAL_SLEEP(0)
            self.assertTrue(entered.is_set())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(starts, [])
            followed_task = asyncio.create_task(
                query_model_result('b/two:free', messages)
            )
            for _ in range(50):
                if followed_task.done():
                    break
                await _REAL_SLEEP(0)
            self.assertTrue(followed_task.done())
            followed = followed_task.result()
        self.assertTrue(followed['ok'])
        self.assertEqual(starts, [0.0])


class HarnessDropSampleTests(unittest.TestCase):
    def setUp(self):
        self.models = list(settings.council_models)
        self.chairman = settings.chairman_model
        self.samples = settings.n_samples

    def tearDown(self):
        settings.council_models = self.models
        settings.chairman_model = self.chairman
        settings.n_samples = self.samples
        clear_blocked_ids()

    def test_all_free_remainder_uses_one_sample(self):
        settings.council_models = ['openai/gpt-4.1', 'a/one:free']
        settings.chairman_model = 'openai/gpt-4.1'
        settings.n_samples = 3
        drop_blocked_model('openai/gpt-4.1')
        self.assertEqual(settings.council_models, ['a/one:free'])
        self.assertEqual(settings.n_samples, 1)

    def test_mixed_remainder_keeps_samples(self):
        settings.council_models = ['openai/gpt-4.1', 'a/one:free']
        settings.chairman_model = 'openai/gpt-4.1'
        settings.n_samples = 3
        drop_blocked_model('a/one:free')
        self.assertEqual(settings.council_models, ['openai/gpt-4.1'])
        self.assertEqual(settings.n_samples, 3)
