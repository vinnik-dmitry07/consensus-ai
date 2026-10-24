"""Regression tests: a retry must re-ask the same question and drop the old run."""

import json
import unittest
import uuid
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend import storage
from backend.council import Stage1AllFailed
from backend.main import app
from backend.settings import settings


def _final(text):
    return {'model': 'chair', 'response': text, 'usage': {}}


def _pin_api_key(test):
    """Keep existing retry tests runnable when the process has no key."""
    test.addCleanup(setattr, settings, '_api_key', settings._api_key)
    if not settings.has_api_key:
        settings.api_key = 'sk-test'


class FollowUpRetryTests(unittest.TestCase):
    """Retrying a follow-up message must keep the prior answer in the prompt."""

    def setUp(self):
        _pin_api_key(self)
        self.tmp = TemporaryDirectory()
        self.dir_patch = patch('backend.storage.DATA_DIR', self.tmp.name)
        self.dir_patch.start()
        self.conv_id = str(uuid.uuid4())
        storage.create_conversation(self.conv_id)
        storage.add_user_message(self.conv_id, 'What is the capital of France?')
        storage.add_assistant_message(
            self.conv_id,
            [{'model': 'a', 'response': 'Paris'}],
            [{'model': 'b', 'ranking': '1. Response 1'}],
            _final('The capital of France is Paris.'),
            metadata={'label_to_model': {'Response 1': 'a'}},
        )
        storage.add_user_message(
            self.conv_id, 'What about its population?', follow_up_to=1
        )
        storage.add_assistant_message(
            self.conv_id,
            [{'model': 'a', 'response': 'about 2.1M'}],
            [{'model': 'b', 'ranking': '1. Response 1'}],
            _final('Roughly 2.1 million.'),
            metadata={'label_to_model': {'Response 1': 'a'}},
        )

    def tearDown(self):
        self.dir_patch.stop()
        self.tmp.cleanup()

    def _retry(self, stage, message_index=3):
        seen = {}

        async def fake_stage3(query_text, *args, **kwargs):
            seen['query_text'] = query_text
            return _final('retried')

        async def fake_stage1(*args, **kwargs):
            seen['stage1_query'] = args[2]
            args[3]['results'] = [{'model': 'a', 'response': 'again'}]
            yield 'data: {"type": "stage1_complete"}\n\n'

        async def fake_stage2(*args, **kwargs):
            seen['stage2_query'] = args[2]
            args[4]['results'] = [{'model': 'b', 'ranking': '1. Response 1'}]
            args[4]['label_to_model'] = {'Response 1': 'a'}
            yield 'data: {"type": "stage2_complete"}\n\n'

        with (
            patch('backend.main._emit_stage1_sse', new=fake_stage1),
            patch('backend.main._emit_stage2_sse', new=fake_stage2),
            patch(
                'backend.main._run_and_save_post_ranking',
                new=AsyncMock(return_value=({'label_to_model': {}}, True, None)),
            ),
            patch('backend.main.stage3_synthesize_final', new=fake_stage3),
        ):
            client = TestClient(app)
            response = client.post(
                f'/api/conversations/{self.conv_id}/retry/stage{stage}/stream',
                json={'message_index': message_index},
            )
        return response, seen

    def test_retry_stage3_recomposes_follow_up_context(self):
        response, seen = self._retry(3)
        self.assertEqual(response.status_code, 200)
        self.assertIn('The capital of France is Paris.', seen['query_text'])
        self.assertIn('What about its population?', seen['query_text'])

    def test_retry_stage2_recomposes_follow_up_context(self):
        response, seen = self._retry(2)
        self.assertEqual(response.status_code, 200)
        self.assertIn('The capital of France is Paris.', seen['stage2_query'])

    def test_retry_stage1_recomposes_follow_up_context(self):
        response, seen = self._retry(1)
        self.assertEqual(response.status_code, 200)
        self.assertIn('The capital of France is Paris.', seen['stage1_query'])

    def test_plain_message_retry_is_not_composed(self):
        response, seen = self._retry(3, message_index=1)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(seen['query_text'], 'What is the capital of France?')

    def test_retry_rejected_when_prior_answer_is_gone(self):
        storage.update_streaming_message(
            self.conv_id, 1, stage3=None, streaming=False
        )
        client = TestClient(app)
        response = client.post(
            f'/api/conversations/{self.conv_id}/retry/stage3/stream',
            json={'message_index': 3},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('Retry that message first', response.json()['detail'])


class StaleStageClearingTests(unittest.TestCase):
    """A retry that fails must not leave the previous run's answer behind."""

    def setUp(self):
        _pin_api_key(self)
        self.tmp = TemporaryDirectory()
        self.dir_patch = patch('backend.storage.DATA_DIR', self.tmp.name)
        self.dir_patch.start()
        self.conv_id = str(uuid.uuid4())
        storage.create_conversation(self.conv_id)
        storage.add_user_message(self.conv_id, 'hello')
        storage.add_assistant_message(
            self.conv_id,
            [{'model': 'a', 'response': 'old answer'}],
            [{'model': 'b', 'ranking': '1. Response 1'}],
            _final('STALE FINAL ANSWER'),
            metadata={'label_to_model': {'Response 1': 'a'}},
        )

    def tearDown(self):
        self.dir_patch.stop()
        self.tmp.cleanup()

    def test_failed_stage1_retry_clears_stage2_and_stage3(self):
        async def fake_stage1(*args, **kwargs):
            yield 'data: {"type": "stage1_start"}\n\n'
            raise Stage1AllFailed([{'model': 'a', 'error': {'message': 'boom'}}])

        with patch('backend.main._emit_stage1_sse', new=fake_stage1):
            client = TestClient(app)
            client.post(
                f'/api/conversations/{self.conv_id}/retry/stage1/stream',
                json={'message_index': 1},
            )

        message = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertIsNone(message['stage2'])
        self.assertIsNone(message['stage3'])
        self.assertIsNone(message['metadata'])
        self.assertFalse(message['stage1_complete'])

    def test_failed_stage2_retry_clears_stage3(self):
        async def fake_stage2(*args, **kwargs):
            yield 'data: {"type": "stage2_start"}\n\n'
            raise RuntimeError('all judges failed')

        with patch('backend.main._emit_stage2_sse', new=fake_stage2):
            client = TestClient(app)
            client.post(
                f'/api/conversations/{self.conv_id}/retry/stage2/stream',
                json={'message_index': 1},
            )

        message = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertIsNone(message['stage3'])

    def test_failed_stage3_retry_clears_stage3(self):
        with (
            patch(
                'backend.main._run_and_save_post_ranking',
                new=AsyncMock(return_value=({'label_to_model': {}}, True, None)),
            ),
            patch(
                'backend.main.stage3_synthesize_final',
                new=AsyncMock(side_effect=RuntimeError('chairman down')),
            ),
        ):
            client = TestClient(app)
            client.post(
                f'/api/conversations/{self.conv_id}/retry/stage3/stream',
                json={'message_index': 1},
            )

        message = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertIsNone(message['stage3'])

    def test_omitted_fields_are_left_alone(self):
        storage.update_streaming_message(self.conv_id, 1, streaming=True)
        message = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertEqual(message['stage3']['response'], 'STALE FINAL ANSWER')
        self.assertEqual(len(message['stage2']), 1)

    def test_empty_skip_list_replaces_and_omission_keeps_it(self):
        note = {'model': 'a', 'error': {'message': 'Skipped'}}
        storage.update_streaming_message(
            self.conv_id,
            1,
            stage1_skipped=[note],
            stage2_skipped=[note],
            streaming=False,
        )
        storage.update_streaming_message(self.conv_id, 1, streaming=True)
        message = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertEqual(message['stage1_skipped'], [note])
        self.assertEqual(message['stage2_skipped'], [note])
        storage.update_streaming_message(
            self.conv_id,
            1,
            stage1_skipped=[],
            stage2_skipped=[],
            streaming=False,
        )
        message = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertEqual(message['stage1_skipped'], [])
        self.assertEqual(message['stage2_skipped'], [])
        self.assertEqual(message['stage3']['response'], 'STALE FINAL ANSWER')


class Stage1ResumeWritebackTests(unittest.TestCase):
    """A resume must persist the filtered Stage 1 set, not only rank it."""

    def setUp(self):
        _pin_api_key(self)
        self.saved_models = list(settings.council_models)
        self.saved_n = settings.n_samples
        self.tmp = TemporaryDirectory()
        self.dir_patch = patch('backend.storage.DATA_DIR', self.tmp.name)
        self.dir_patch.start()
        self.conv_id = str(uuid.uuid4())
        storage.create_conversation(self.conv_id)
        storage.add_user_message(self.conv_id, 'hello')
        storage.add_assistant_message(
            self.conv_id,
            [
                {'model': 'a/keep', 'response': 'kept'},
                {'model': 'gone/removed', 'response': 'stale'},
            ],
            [{'model': 'b', 'ranking': '1. Response 1'}],
            _final('old'),
            metadata={'label_to_model': {'Response 1': 'gone/removed'}},
        )
        settings.council_models = ['a/keep']
        settings.n_samples = 1

    def tearDown(self):
        settings.council_models = self.saved_models
        settings.n_samples = self.saved_n
        self.dir_patch.stop()
        self.tmp.cleanup()

    def test_resume_writes_back_only_current_council_samples(self):
        query = AsyncMock()

        async def fake_stage2(*args, **kwargs):
            yield 'data: {"type": "stage2_start"}\n\n'
            raise RuntimeError('stop after stage 1')

        with (
            patch('backend.council.query_model_result', new=query),
            patch('backend.main._emit_stage2_sse', new=fake_stage2),
        ):
            client = TestClient(app)
            response = client.post(
                f'/api/conversations/{self.conv_id}/retry/stage1/stream',
                json={'message_index': 1},
            )

        self.assertEqual(response.status_code, 200)
        message = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertEqual(
            message['stage1'],
            [{'model': 'a/keep', 'response': 'kept'}],
        )
        query.assert_not_called()


class ApiKeyRequiredTests(unittest.TestCase):
    """A missing key must fail before the run writes or clears anything."""

    def setUp(self):
        self.addCleanup(setattr, settings, '_api_key', settings._api_key)
        settings._api_key = None
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir_patch = patch('backend.storage.DATA_DIR', self.tmp.name)
        self.dir_patch.start()
        self.addCleanup(self.dir_patch.stop)
        self.conv_id = str(uuid.uuid4())
        storage.create_conversation(self.conv_id)
        storage.add_user_message(self.conv_id, 'hello')
        storage.add_assistant_message(
            self.conv_id,
            [{'model': 'a', 'response': 'old'}],
            [{'model': 'b', 'ranking': '1. Response 1'}],
            _final('kept'),
        )

    def test_send_stream_does_not_append_a_turn(self):
        client = TestClient(app)
        response = client.post(
            f'/api/conversations/{self.conv_id}/message/stream',
            json={'content': 'new question'},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('API key', response.json()['detail'])
        messages = storage.get_conversation(self.conv_id)['messages']
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[1]['stage3']['response'], 'kept')

    def test_retry_does_not_clear_the_previous_answer(self):
        client = TestClient(app)
        response = client.post(
            f'/api/conversations/{self.conv_id}/retry/stage1/stream',
            json={'message_index': 1},
        )
        self.assertEqual(response.status_code, 400)
        message = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertEqual(message['stage3']['response'], 'kept')
        self.assertNotEqual(message.get('streaming'), True)


def _sse_events(response):
    events = []
    for line in response.text.splitlines():
        if line.startswith('data: '):
            events.append(json.loads(line[len('data: '):]))
    return events


class SkipPersistenceTests(unittest.TestCase):
    """Skip lists are replaced before appends and unknown failures stay put."""

    def setUp(self):
        _pin_api_key(self)
        self.saved_models = list(settings.council_models)
        self.saved_chairman = settings.chairman_model
        self.saved_samples = settings.n_samples
        self.tmp = TemporaryDirectory()
        self.dir_patch = patch('backend.storage.DATA_DIR', self.tmp.name)
        self.dir_patch.start()
        self.conv_id = str(uuid.uuid4())
        storage.create_conversation(self.conv_id)
        storage.add_user_message(self.conv_id, 'hello')
        storage.add_assistant_message(
            self.conv_id,
            [
                {'model': 'a/keep', 'response': 'first'},
                {'model': 'a/keep', 'response': 'second'},
                {'model': 'gone/removed', 'response': 'stale'},
            ],
            [{'model': 'b', 'ranking': '1. Response 1'}],
            _final('old'),
            metadata={'label_to_model': {'Response 1': 'a/keep'}},
        )
        storage.update_streaming_message(
            self.conv_id,
            1,
            stage1_failures=[
                {'model': 'a/keep', 'error': {'message': 'Model not found (404)'}},
                {
                    'model': 'gone/removed',
                    'error': {'message': 'Model not found (404)'},
                },
            ],
            stage1_skipped=[{
                'model': 'old/skip',
                'error': {'message': 'Temporarily rate-limited upstream'},
            }],
            stage2_skipped=[{
                'model': 'old/judge',
                'error': {'message': 'old'},
            }],
            streaming=False,
        )
        settings.council_models = ['a/keep', 'c/new']
        settings.chairman_model = 'a/keep'
        settings.n_samples = 1

    def tearDown(self):
        settings.council_models = self.saved_models
        settings.chairman_model = self.saved_chairman
        settings.n_samples = self.saved_samples
        self.dir_patch.stop()
        self.tmp.cleanup()

    def test_stage1_retry_keeps_unknown_failures_and_drops_old_skips(self):
        seen = {}

        async def fake_collect(*args, **kwargs):
            message = storage.get_conversation(self.conv_id)['messages'][1]
            seen['before_skips'] = list(message.get('stage1_skipped') or [])
            seen['before_stage1'] = list(message.get('stage1') or [])
            seen['before_failures'] = list(message.get('stage1_failures') or [])
            yield 'model_failed', {
                'model': 'c/new',
                'error': {'message': 'Temporarily rate-limited upstream'},
                'skipped': True,
            }
            yield 'model_failed', {
                'model': 'c/new',
                'error': {'message': 'Temporarily rate-limited upstream'},
                'skipped': True,
            }
            seen['mid'] = list(
                storage.get_conversation(self.conv_id)['messages'][1]['stage1_skipped']
            )
            raise RuntimeError('boom')

        with (
            patch('backend.main._require_servable_roster', new=AsyncMock()),
            patch('backend.main.stage1_collect_responses_streaming', new=fake_collect),
        ):
            client = TestClient(app)
            response = client.post(
                f'/api/conversations/{self.conv_id}/retry/stage1/stream',
                json={'message_index': 1},
            )

        self.assertEqual(response.status_code, 200)
        message = storage.get_conversation(self.conv_id)['messages'][1]
        error = next(
            event for event in _sse_events(response)
            if event['type'] == 'stage1_error'
        )
        self.assertEqual(seen['before_skips'], [])
        self.assertEqual(
            [item['response'] for item in seen['before_stage1']],
            ['first', 'second', 'stale'],
        )
        self.assertEqual(
            [item['model'] for item in seen['before_failures']],
            ['a/keep'],
        )
        self.assertEqual(len(seen['mid']), 2)
        self.assertEqual(
            [item['response'] for item in message['stage1']],
            ['first', 'second', 'stale'],
        )
        self.assertEqual(
            [item['model'] for item in message['stage1_failures']],
            ['a/keep'],
        )
        self.assertEqual(len(message['stage1_skipped']), 2)
        self.assertNotIn('failures', error)
        self.assertEqual(len(error['skipped']), 2)
        self.assertEqual(message.get('stage2_skipped'), [])

    def test_send_stream_keeps_a_partial_failure(self):
        async def fake_collect(*args, **kwargs):
            yield 'init', {
                'total_models': 1,
                'pending_models': 1,
                'existing_count': 0,
            }
            yield 'model_failed', {
                'model': 'openai/missing',
                'error': {'message': 'Model not found (404)'},
            }
            raise RuntimeError('provider exploded')

        with (
            patch('backend.main._require_servable_roster', new=AsyncMock()),
            patch('backend.main.stage1_collect_responses_streaming', new=fake_collect),
        ):
            client = TestClient(app)
            response = client.post(
                f'/api/conversations/{self.conv_id}/message/stream',
                json={'content': 'another question'},
            )

        self.assertEqual(response.status_code, 200)
        message = storage.get_conversation(self.conv_id)['messages'][-1]
        error = next(
            event for event in _sse_events(response)
            if event['type'] == 'stage1_error'
        )
        self.assertEqual(
            [item['model'] for item in message['stage1_failures']],
            ['openai/missing'],
        )
        self.assertEqual(message['stage1_skipped'], [])
        self.assertNotIn('failures', error)
        self.assertEqual(error['skipped'], [])

    def test_stage2_retry_replaces_skips_before_append(self):
        async def fake_collect(*args, **kwargs):
            message = storage.get_conversation(self.conv_id)['messages'][1]
            self.assertEqual(message.get('stage2_skipped'), [])
            yield 'model_failed', {
                'model': 'c/new',
                'error': {'message': 'Temporarily rate-limited upstream'},
                'skipped': True,
            }
            mid = storage.get_conversation(self.conv_id)['messages'][1]
            self.assertEqual(
                [item['model'] for item in mid['stage2_skipped']],
                ['c/new'],
            )
            raise RuntimeError('boom')

        with (
            patch('backend.main._require_servable_roster', new=AsyncMock()),
            patch(
                'backend.main.stage2_collect_rankings_streaming',
                new=fake_collect,
            ),
        ):
            client = TestClient(app)
            response = client.post(
                f'/api/conversations/{self.conv_id}/retry/stage2/stream',
                json={'message_index': 1},
            )

        self.assertEqual(response.status_code, 200)
        message = storage.get_conversation(self.conv_id)['messages'][1]
        error = next(
            event for event in _sse_events(response)
            if event['type'] == 'stage2_error'
        )
        self.assertEqual(
            [item['model'] for item in message['stage2_skipped']],
            ['c/new'],
        )
        self.assertEqual(
            [item['response'] for item in message['stage1']],
            ['first', 'second', 'stale'],
        )
        self.assertEqual(
            [item['model'] for item in error['skipped']],
            ['c/new'],
        )

    def test_normal_stage2_entry_clears_skips_planted_after_stage1(self):
        async def fake_stage1(*args, **kwargs):
            yield 'init', {
                'total_models': 1,
                'pending_models': 1,
                'existing_count': 0,
            }
            yield 'model_complete', {
                'result': {'model': 'a/keep', 'response': 'yes'},
                'existing': False,
            }
            yield 'model_failed', {
                'model': 'c/new',
                'error': {'message': 'Temporarily rate-limited upstream'},
                'skipped': True,
            }
            yield 'all_complete', {
                'results': [{'model': 'a/keep', 'response': 'yes'}],
                'failures': [],
            }
            assistant = storage.get_conversation(self.conv_id)['messages'][-1]
            index = len(storage.get_conversation(self.conv_id)['messages']) - 1
            self.assertEqual(
                [item['model'] for item in assistant.get('stage1_skipped') or []],
                ['c/new'],
            )
            storage.update_streaming_message(
                self.conv_id,
                index,
                stage2_skipped=[{
                    'model': 'old/judge',
                    'error': {'message': 'old'},
                }],
            )

        async def fake_stage2(*args, **kwargs):
            message = storage.get_conversation(self.conv_id)['messages'][-1]
            if message.get('stage2_skipped') != []:
                raise RuntimeError('stage 2 skips were not cleared')
            if [item['model'] for item in message['stage1_skipped']] != ['c/new']:
                raise RuntimeError('stage 1 skip was not stored')
            yield 'init', {'total_models': 1, 'completed': 0}
            raise RuntimeError('stop')

        with (
            patch('backend.main._require_servable_roster', new=AsyncMock()),
            patch('backend.main.stage1_collect_responses_streaming', new=fake_stage1),
            patch('backend.main.stage2_collect_rankings_streaming', new=fake_stage2),
        ):
            client = TestClient(app)
            response = client.post(
                f'/api/conversations/{self.conv_id}/message/stream',
                json={'content': 'another question'},
            )

        self.assertEqual(response.status_code, 200)
        message = storage.get_conversation(self.conv_id)['messages'][-1]
        self.assertEqual(
            [item['model'] for item in message['stage1_skipped']],
            ['c/new'],
        )
        self.assertEqual(message.get('stage2_skipped'), [])


if __name__ == '__main__':
    unittest.main()
