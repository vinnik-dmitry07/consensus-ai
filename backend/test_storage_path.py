"""Tests for conversation path safety and JSON transfer."""

import unittest
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import storage
from backend.main import app
from backend.storage import get_conversation_path


class ConversationPathTests(unittest.TestCase):
    def test_rejects_non_uuid_and_traversal(self):
        for bad in (
            r'..\..\secret',
            '../secret',
            r'C:\Windows\secret',
            'not-a-uuid',
            '',
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    get_conversation_path(bad)

    def test_accepts_uuid_under_data_dir(self):
        conv_id = str(uuid.uuid4())
        path = Path(get_conversation_path(conv_id)).resolve()
        self.assertTrue(path.is_relative_to(Path(storage.DATA_DIR).resolve()))
        self.assertEqual(path.name, f'{conv_id}.json')

    def test_get_conversation_returns_none_for_bad_id(self):
        self.assertIsNone(storage.get_conversation(r'..\..\secret'))


class ConversationTransferTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.dir_patch = patch('backend.storage.DATA_DIR', self.tmp.name)
        self.dir_patch.start()
        self.conv_id = str(uuid.uuid4())
        storage.create_conversation(self.conv_id)
        storage.add_user_message(self.conv_id, 'hello')

    def tearDown(self):
        self.dir_patch.stop()
        self.tmp.cleanup()

    def test_export_route_is_not_captured_as_an_id(self):
        client = TestClient(app)
        exported = client.get('/api/conversations/export')
        self.assertEqual(exported.status_code, 200)
        body = exported.json()
        self.assertEqual(body['version'], 1)
        self.assertEqual(body['conversations'][0]['id'], self.conv_id)

        storage.remove_conversation(self.conv_id)
        imported = client.post('/api/conversations/import', json=body)
        self.assertEqual(imported.status_code, 200)
        self.assertIn(self.conv_id, imported.json()['imported'])
        self.assertFalse(storage.get_conversation(self.conv_id)['removed'])
        self.assertEqual(
            storage.get_conversation(self.conv_id)['messages'][0]['content'],
            'hello',
        )
