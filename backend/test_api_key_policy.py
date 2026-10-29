"""Personal-key routing and the run gate. Free and paid ids share that key."""

import copy
import unittest
import uuid
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend import storage
from backend.config import (
    CHAIRMAN_MODEL,
    COUNCIL_MODELS,
    RED_TEAM_MODEL,
)
from backend.council import (
    generate_conversation_title,
    red_team_review,
    stage3_synthesize_final,
)
from backend.main import API_KEY_REQUIRED, app
from backend.openrouter import get_credits, get_key_info, query_model_result
from backend.roster import (
    remember_model_cooldown,
    reset_free_queue_for_tests,
    stage1_sample_limit,
)
from backend.settings import settings
from backend.test_openrouter_errors import _MonoClock, _fake_client, _response


def _bearer(headers):
    return (headers or {}).get('Authorization', '')


def _uses(headers, key):
    return _bearer(headers) == f'Bearer {key}'


def _ok_response():
    return _response(200, {
        'choices': [{'message': {'content': 'ok'}}],
        'usage': {},
    })


class RosterPolicyTests(unittest.TestCase):
    def test_paid_chairman_does_not_change_the_free_sample_cap(self):
        self.assertEqual(stage1_sample_limit(['a/one:free', 'b/two:free'], 3), 1)


class KeyRoutingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._saved = (
            list(settings.council_models),
            settings.chairman_model,
            settings.red_team_model,
            settings._api_key,
        )
        reset_free_queue_for_tests()

    def tearDown(self):
        council, chairman, red_team, key = self._saved
        settings.council_models = council
        settings.chairman_model = chairman
        settings.red_team_model = red_team
        settings._api_key = key
        reset_free_queue_for_tests()

    async def _post(self, model, handler):
        with patch(
            'backend.openrouter.httpx.AsyncClient',
            return_value=_fake_client(handler),
        ):
            return await query_model_result(model, [{'role': 'user', 'content': 'q'}])

    async def test_free_models_use_the_personal_key(self):
        for model in (
            'vendor/model:free',
            'vendor/model:free-reasoning',
            'vendor/model:free-reasoning-high',
        ):
            settings._api_key = None
            with patch('backend.openrouter.httpx.AsyncClient') as client:
                refused = await query_model_result(
                    model,
                    [{'role': 'user', 'content': 'q'}],
                )
            self.assertFalse(refused['ok'])
            self.assertEqual(refused['error']['message'], 'No API key configured')
            client.assert_not_called()

            settings._api_key = 'sk-user'
            seen = []

            def handler(*args, **kwargs):
                seen.append(kwargs)
                return _ok_response()

            result = await self._post(model, handler)
            self.assertTrue(result['ok'])
            self.assertEqual(len(seen), 1)
            self.assertTrue(_uses(seen[0]['headers'], 'sk-user'))
            self.assertTrue(seen[0]['json']['model'].endswith(':free'))

    async def test_paid_models_use_only_the_personal_key(self):
        settings._api_key = 'sk-user'
        for model, expected in (
            ('openai/gpt-4.1', 'openai/gpt-4.1'),
            ('~openai/gpt-sol-latest', '~openai/gpt-sol-latest'),
            ('vendor/name:free-extra', 'vendor/name:free-extra'),
        ):
            seen = []

            def handler(*args, **kwargs):
                seen.append(kwargs)
                return _ok_response()

            result = await self._post(model, handler)
            self.assertTrue(result['ok'])
            self.assertTrue(_uses(seen[-1]['headers'], 'sk-user'))
            self.assertEqual(seen[-1]['json']['model'], expected)

    async def test_paid_model_without_a_personal_key_does_not_post(self):
        settings._api_key = None
        with patch('backend.openrouter.httpx.AsyncClient') as client:
            result = await query_model_result(
                'openai/gpt-4.1',
                [{'role': 'user', 'content': 'q'}],
            )
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['message'], 'No API key configured')
        client.assert_not_called()

    async def test_free_retry_keeps_the_personal_key(self):
        settings._api_key = 'sk-user'
        clock = _MonoClock()
        calls = []

        def handler(*args, **kwargs):
            calls.append(kwargs['headers'])
            if len(calls) == 1:
                return _response(429, {
                    'error': {'message': 'Rate limit exceeded: free-models-per-min'},
                })
            return _ok_response()

        with (
            patch('backend.roster.time.monotonic', new=clock.monotonic),
            patch('backend.roster.asyncio.sleep', new=clock.sleep),
            patch('backend.openrouter.httpx.AsyncClient', return_value=_fake_client(handler)),
        ):
            result = await query_model_result(
                'a/one:free',
                [{'role': 'user', 'content': 'q'}],
            )
        self.assertTrue(result['ok'])
        self.assertGreater(len(calls), 1)
        self.assertTrue(all(_uses(headers, 'sk-user') for headers in calls))

    async def test_paid_failure_does_not_switch_keys(self):
        settings._api_key = 'sk-user'
        calls = []

        def handler(*args, **kwargs):
            calls.append(kwargs['headers'])
            return _response(402, {
                'error': {'message': 'This request requires more credits'},
            })

        result = await self._post('openai/gpt-4.1', handler)
        self.assertFalse(result['ok'])
        self.assertEqual(len(calls), 1)
        self.assertTrue(_uses(calls[0], 'sk-user'))

    async def test_credits_and_key_info_need_the_personal_key(self):
        settings._api_key = None
        with patch('backend.openrouter.httpx.AsyncClient') as client:
            self.assertIsNone(await get_credits())
            self.assertIsNone(await get_key_info())
        client.assert_not_called()

        settings._api_key = 'sk-user'
        seen = []

        def handler(*args, **kwargs):
            seen.append(kwargs.get('headers'))
            return _response(200, {
                'data': {'total_credits': 1, 'total_usage': 0},
            })

        with patch(
            'backend.openrouter.httpx.AsyncClient',
            return_value=_fake_client(handler),
        ):
            credits = await get_credits()
            await get_key_info()
        self.assertEqual(credits['total_credits'], 1)
        self.assertEqual(len(seen), 2)
        self.assertTrue(all(_uses(headers, 'sk-user') for headers in seen))

    async def test_title_skips_the_client_without_a_personal_key(self):
        settings._api_key = None
        with patch('backend.council.query_model', new=AsyncMock()) as query:
            title = await generate_conversation_title('What is rain?')
        self.assertEqual(title, 'New Conversation')
        query.assert_not_called()

    async def test_title_uses_the_personal_key(self):
        settings._api_key = 'sk-user'
        seen = []

        def handler(*args, **kwargs):
            seen.append(kwargs)
            return _ok_response()

        with patch(
            'backend.openrouter.httpx.AsyncClient',
            return_value=_fake_client(handler),
        ):
            title = await generate_conversation_title('What is rain?')
        self.assertEqual(title, 'ok')
        self.assertEqual(len(seen), 1)
        self.assertTrue(_uses(seen[0]['headers'], 'sk-user'))
        self.assertEqual(seen[0]['json']['model'], 'google/gemini-2.5-flash')

    async def test_paid_historical_red_team_does_not_post(self):
        settings._api_key = None
        settings.chairman_model = 'a/one:free'
        settings.red_team_model = None
        with patch('backend.openrouter.httpx.AsyncClient') as client:
            result = await red_team_review(
                'q',
                'answer',
                0,
                [{'model': 'openai/gpt-4.1', 'index': 1}],
                [{'model': 'a/one:free', 'response': 'answer'}],
            )
        client.assert_not_called()
        self.assertEqual(result['model'], 'openai/gpt-4.1')
        self.assertIsNone(result['verdict'])
        self.assertEqual(result['error']['message'], 'No API key configured')

    async def test_stage3_fallback_uses_the_next_models_key(self):
        settings._api_key = 'sk-user'
        settings.chairman_model = 'openai/gpt-4.1'
        settings.council_models = ['b/two:free']
        remember_model_cooldown('openai/gpt-4.1', 600)
        seen = []

        def handler(*args, **kwargs):
            seen.append(kwargs)
            return _ok_response()

        with patch(
            'backend.openrouter.httpx.AsyncClient',
            return_value=_fake_client(handler),
        ):
            stage3 = await stage3_synthesize_final(
                'q',
                [{'model': 'b/two:free', 'response': 'yes'}],
            )
        self.assertEqual(stage3['response'], 'ok')
        self.assertEqual(len(seen), 1)
        self.assertTrue(_uses(seen[0]['headers'], 'sk-user'))
        self.assertEqual(seen[0]['json']['model'], 'b/two:free')


class RunGateTests(unittest.TestCase):
    def setUp(self):
        self._saved = (
            list(settings.council_models),
            settings.chairman_model,
            settings.red_team_model,
            settings.n_samples,
            settings._api_key,
        )
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir_patch = patch('backend.storage.DATA_DIR', self.tmp.name)
        self.dir_patch.start()
        self.addCleanup(self.dir_patch.stop)
        self.conv_id = self._seed()

    def _seed(self):
        conv_id = str(uuid.uuid4())
        storage.create_conversation(conv_id)
        storage.add_user_message(conv_id, 'hello')
        storage.add_assistant_message(
            conv_id,
            [
                {'model': 'a/one:free', 'response': 'one'},
                {'model': 'b/two:free', 'response': 'two'},
            ],
            [{'model': 'b/two:free', 'ranking': '1. Response 1'}],
            {'model': 'a/one:free', 'response': 'old', 'usage': {}},
            metadata={'label_to_model': {'Response 1': 'a/one:free'}},
        )
        return conv_id

    def tearDown(self):
        council, chairman, red_team, samples, key = self._saved
        settings.council_models = council
        settings.chairman_model = chairman
        settings.red_team_model = red_team
        settings.n_samples = samples
        settings._api_key = key

    def _free_roster(self, api_key=None):
        settings._api_key = api_key
        settings.council_models = ['a/one:free', 'b/two:free']
        settings.chairman_model = 'a/one:free'
        settings.red_team_model = None

    def _paid_roster(self):
        settings._api_key = None
        settings.council_models = list(COUNCIL_MODELS)
        settings.chairman_model = CHAIRMAN_MODEL
        settings.red_team_model = RED_TEAM_MODEL

    def _stream_patches(self, seen):
        async def fake_stage1(*args, **kwargs):
            del kwargs
            seen.append('stage1')
            args[3]['results'] = [{'model': 'a/one:free', 'response': 'yes'}]
            yield 'data: {"type": "stage1_complete"}\n\n'

        async def fake_stage2(*args, **kwargs):
            del kwargs
            seen.append('stage2')
            args[4]['results'] = [{'model': 'b/two:free', 'ranking': '1. Response 1'}]
            args[4]['label_to_model'] = {'Response 1': 'a/one:free'}
            yield 'data: {"type": "stage2_complete"}\n\n'

        return (
            patch('backend.main._emit_stage1_sse', new=fake_stage1),
            patch('backend.main._emit_stage2_sse', new=fake_stage2),
            patch(
                'backend.main._run_and_save_post_ranking',
                new=AsyncMock(return_value=({'label_to_model': {}}, True, None)),
            ),
            patch(
                'backend.main.stage3_synthesize_final',
                new=AsyncMock(return_value={
                    'model': 'a/one:free',
                    'response': 'final',
                    'usage': {},
                }),
            ),
        )

    def test_settings_do_not_expose_a_shared_key(self):
        settings._api_key = None
        payload = settings.to_dict()
        self.assertFalse(payload['has_api_key'])
        self.assertIsNone(payload['masked_api_key'])
        self.assertNotIn('sk-or-v1-', str(payload))

    def test_denied_endpoints_leave_the_conversation_unchanged(self):
        self._paid_roster()
        before = copy.deepcopy(storage.get_conversation(self.conv_id))
        client = TestClient(app)
        calls = (
            ('post', f'/api/conversations/{self.conv_id}/message', {'content': 'again'}),
            (
                'post',
                f'/api/conversations/{self.conv_id}/message/stream',
                {'content': 'again'},
            ),
            (
                'post',
                f'/api/conversations/{self.conv_id}/retry/stage1/stream',
                {'message_index': 1},
            ),
            (
                'post',
                f'/api/conversations/{self.conv_id}/retry/stage2/stream',
                {'message_index': 1},
            ),
            (
                'post',
                f'/api/conversations/{self.conv_id}/retry/stage3/stream',
                {'message_index': 1},
            ),
        )
        with patch('backend.main.run_full_council', new=AsyncMock()) as council:
            for method, path, body in calls:
                response = getattr(client, method)(path, json=body)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()['detail'], API_KEY_REQUIRED)
                self.assertEqual(storage.get_conversation(self.conv_id), before)
            council.assert_not_called()

    def test_allowed_message_reaches_the_mocked_pipeline(self):
        self._free_roster('sk-user')
        council = AsyncMock(return_value=(
            [{'model': 'a/one:free', 'response': 'yes'}],
            [{'model': 'b/two:free', 'ranking': '1. Response 1'}],
            {'model': 'a/one:free', 'response': 'final', 'usage': {}},
            {},
        ))
        with (
            patch('backend.main.run_full_council', new=council),
            patch('backend.council.query_model', new=AsyncMock()) as title,
        ):
            response = TestClient(app).post(
                f'/api/conversations/{self.conv_id}/message',
                json={'content': 'again'},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['stage3']['response'], 'final')
        council.assert_awaited()
        title.assert_not_called()
        stored = storage.get_conversation(self.conv_id)
        self.assertEqual(stored['messages'][-1]['stage3']['response'], 'final')

    def test_allowed_streams_and_retries_reach_the_mocked_pipeline(self):
        self._free_roster('sk-user')
        client = TestClient(app)
        paths = (
            (f'/api/conversations/{self.conv_id}/message/stream', {'content': 'again'}),
            (
                f'/api/conversations/{self.conv_id}/retry/stage1/stream',
                {'message_index': 1},
            ),
            (
                f'/api/conversations/{self.conv_id}/retry/stage2/stream',
                {'message_index': 1},
            ),
            (
                f'/api/conversations/{self.conv_id}/retry/stage3/stream',
                {'message_index': 1},
            ),
        )
        for path, body in paths:
            conv_id = self._seed()
            path = path.replace(self.conv_id, conv_id)
            seen = []
            patches = self._stream_patches(seen)
            with patches[0], patches[1], patches[2], patches[3]:
                response = client.post(path, json=body)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIn('complete', response.text)
            self.assertIn('final', response.text)
            if path.endswith('/message/stream') or path.endswith('stage1/stream'):
                self.assertIn('stage1', seen)
            stored = storage.get_conversation(conv_id)
            self.assertEqual(stored['messages'][-1]['stage3']['response'], 'final')


if __name__ == '__main__':
    unittest.main()
