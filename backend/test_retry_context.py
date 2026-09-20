"""Regression tests: a retry must re-ask the same question and drop the old run."""

import unittest
import uuid
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend import storage
from backend.council import Stage1AllFailed
from backend.main import app


def _final(text):
    return {'model': 'chair', 'response': text, 'usage': {}}


class FollowUpRetryTests(unittest.TestCase):
    """Retrying a follow-up message must keep the prior answer in the prompt."""

    def setUp(self):
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


if __name__ == '__main__':
    unittest.main()
