"""Tests for settings-save catalogue validation."""

import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend.main import app
from backend.openrouter import CatalogueUnavailable, unknown_catalogue_ids
from backend.settings import settings


class SettingsCatalogueTests(unittest.TestCase):
    def tearDown(self):
        settings.reset_to_defaults()

    def test_rejects_unknown_council_id(self):
        with patch(
            'backend.main.unknown_catalogue_ids',
            new=AsyncMock(return_value=['~openai/gpt-latest']),
        ):
            client = TestClient(app)
            response = client.put(
                '/api/settings',
                json={'council_models': ['~openai/gpt-latest']},
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()['detail']['unknown_models'],
            ['~openai/gpt-latest'],
        )
        self.assertNotIn('~openai/gpt-latest', settings.council_models)

    def test_accepts_known_ids(self):
        with patch(
            'backend.main.unknown_catalogue_ids',
            new=AsyncMock(return_value=[]),
        ):
            client = TestClient(app)
            response = client.put(
                '/api/settings',
                json={'chairman_model': '~anthropic/claude-fable-latest'},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()['chairman_model'],
            '~anthropic/claude-fable-latest',
        )

    def test_rejects_when_catalogue_unavailable(self):
        before = list(settings.council_models)
        with patch(
            'backend.main.unknown_catalogue_ids',
            new=AsyncMock(side_effect=CatalogueUnavailable()),
        ):
            client = TestClient(app)
            response = client.put(
                '/api/settings',
                json={'n_samples': 2},
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(settings.council_models, before)
        self.assertEqual(settings.n_samples, 3)

    def test_all_free_council_persists_one_sample(self):
        with patch(
            'backend.main.unknown_catalogue_ids',
            new=AsyncMock(return_value=[]),
        ):
            client = TestClient(app)
            saved = client.put('/api/settings', json={
                'council_models': ['a/one:free', 'b/two:free'],
                'chairman_model': 'openai/gpt-4.1',
                'n_samples': 3,
            })
            again = client.get('/api/settings')
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()['n_samples'], 1)
        self.assertEqual(settings.n_samples, 1)
        self.assertEqual(again.json()['n_samples'], 1)
        self.assertEqual(
            again.json()['council_models'],
            ['a/one:free', 'b/two:free'],
        )

    def test_partial_sample_patch_stays_at_one_for_all_free(self):
        with patch(
            'backend.main.unknown_catalogue_ids',
            new=AsyncMock(return_value=[]),
        ):
            client = TestClient(app)
            client.put('/api/settings', json={
                'council_models': ['google/gemma:free-reasoning-high'],
                'chairman_model': 'openai/gpt-4.1',
                'n_samples': 3,
            })
            patched = client.put('/api/settings', json={'n_samples': 3})
        self.assertEqual(patched.status_code, 200)
        self.assertEqual(patched.json()['n_samples'], 1)
        self.assertEqual(settings.n_samples, 1)
        self.assertEqual(
            settings.council_models,
            ['google/gemma:free-reasoning-high'],
        )

    def test_mixed_council_keeps_requested_samples(self):
        with patch(
            'backend.main.unknown_catalogue_ids',
            new=AsyncMock(return_value=[]),
        ):
            client = TestClient(app)
            saved = client.put('/api/settings', json={
                'council_models': ['a/one:free', 'openai/gpt-4.1'],
                'chairman_model': 'openai/gpt-4.1',
                'n_samples': 3,
            })
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()['n_samples'], 3)
        self.assertEqual(settings.n_samples, 3)


class UnknownCatalogueIdsTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_pricing_raises(self):
        with patch(
            'backend.openrouter.get_models_pricing',
            new=AsyncMock(return_value={}),
        ):
            with self.assertRaises(CatalogueUnavailable):
                await unknown_catalogue_ids(['~openai/gpt-sol-latest'])
