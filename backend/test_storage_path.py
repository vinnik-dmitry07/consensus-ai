"""Tests for conversation path safety."""

import unittest
import uuid
from pathlib import Path

from backend import storage
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
