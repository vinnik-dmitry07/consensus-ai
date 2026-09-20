"""Regression tests for Stage 3 retry."""

import unittest
import uuid
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend import storage
from backend.main import app


class RetryStage3Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.dir_patch = patch('backend.storage.DATA_DIR', self.tmp.name)
        self.dir_patch.start()
        self.conv_id = str(uuid.uuid4())
        storage.create_conversation(self.conv_id)
        storage.add_user_message(self.conv_id, 'hello')
        storage.add_assistant_message(
            self.conv_id,
            [{'model': 'a', 'response': 'one'}],
            [{'model': 'b', 'ranking': '1. Response 1'}],
            None,
            metadata={'label_to_model': {'Response 1': 'a'}},
        )

    def tearDown(self):
        self.dir_patch.stop()
        self.tmp.cleanup()

    def test_retry_stage3_uses_stored_metadata(self):
        complete = {'model': 'chairman', 'response': 'final', 'usage': {}}
        with (
            patch(
                'backend.main._run_and_save_post_ranking',
                new=AsyncMock(
                    return_value=(
                        {'label_to_model': {'Response 1': 'a'}},
                        True,
                        None,
                    )
                ),
            ),
            patch(
                'backend.main.stage3_synthesize_final',
                new=AsyncMock(return_value=complete),
            ),
        ):
            client = TestClient(app)
            response = client.post(
                f'/api/conversations/{self.conv_id}/retry/stage3/stream',
                json={'message_index': 1},
            )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn('referenced before assignment', response.text)
        self.assertIn('stage3_complete', response.text)
        stored = storage.get_conversation(self.conv_id)
        assistant = stored['messages'][1]
        self.assertFalse(assistant.get('streaming'))
        self.assertEqual(assistant['stage3']['response'], 'final')
        self.assertIsNone(assistant.get('error'))

    def test_retry_stage3_error_sse_includes_stage(self):
        with patch(
            'backend.main._run_and_save_post_ranking',
            new=AsyncMock(side_effect=RuntimeError('boom')),
        ):
            client = TestClient(app)
            response = client.post(
                f'/api/conversations/{self.conv_id}/retry/stage3/stream',
                json={'message_index': 1},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn('"type": "error"', response.text)
        self.assertIn('"stage": 3', response.text)
        assistant = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertFalse(assistant.get('streaming'))
        self.assertEqual(assistant.get('error'), {'stage': 3, 'message': 'boom'})


class RetryStage12ErrorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.dir_patch = patch('backend.storage.DATA_DIR', self.tmp.name)
        self.dir_patch.start()
        self.conv_id = str(uuid.uuid4())
        storage.create_conversation(self.conv_id)
        storage.add_user_message(self.conv_id, 'hello')
        storage.add_assistant_message(
            self.conv_id,
            [{'model': 'a', 'response': 'one'}],
            [{'model': 'b', 'ranking': '1. Response 1'}],
            None,
            metadata={'label_to_model': {'Response 1': 'a'}},
        )

    def tearDown(self):
        self.dir_patch.stop()
        self.tmp.cleanup()

    def test_retry_stage1_persists_outer_error(self):
        async def fake_stage1(*args, **kwargs):
            collected = args[3]
            collected['results'] = [{'model': 'a', 'response': 'one'}]
            yield 'data: {"type": "stage1_complete"}\n\n'

        async def fake_stage2(*args, **kwargs):
            collected = args[4]
            collected['results'] = [{'model': 'b', 'ranking': '1. Response 1'}]
            collected['label_to_model'] = {'Response 1': 'a'}
            yield 'data: {"type": "stage2_complete"}\n\n'

        with (
            patch('backend.main._emit_stage1_sse', new=fake_stage1),
            patch('backend.main._emit_stage2_sse', new=fake_stage2),
            patch(
                'backend.main._run_and_save_post_ranking',
                new=AsyncMock(side_effect=RuntimeError('boom')),
            ),
        ):
            client = TestClient(app)
            response = client.post(
                f'/api/conversations/{self.conv_id}/retry/stage1/stream',
                json={'message_index': 1},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn('"type": "error"', response.text)
        self.assertIn('"stage": 2', response.text)
        assistant = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertFalse(assistant.get('streaming'))
        self.assertEqual(assistant.get('error'), {'stage': 2, 'message': 'boom'})

    def test_retry_stage2_persists_outer_error(self):
        async def fake_stage2(*args, **kwargs):
            collected = args[4]
            collected['results'] = [{'model': 'b', 'ranking': '1. Response 1'}]
            collected['label_to_model'] = {'Response 1': 'a'}
            yield 'data: {"type": "stage2_complete"}\n\n'

        with (
            patch('backend.main._emit_stage2_sse', new=fake_stage2),
            patch(
                'backend.main._run_and_save_post_ranking',
                new=AsyncMock(side_effect=RuntimeError('boom')),
            ),
        ):
            client = TestClient(app)
            response = client.post(
                f'/api/conversations/{self.conv_id}/retry/stage2/stream',
                json={'message_index': 1},
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn('"type": "error"', response.text)
        self.assertIn('"stage": 2', response.text)
        assistant = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertFalse(assistant.get('streaming'))
        self.assertEqual(assistant.get('error'), {'stage': 2, 'message': 'boom'})
