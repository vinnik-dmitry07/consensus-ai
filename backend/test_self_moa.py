"""Self-MoA (S8) mode in the local backend."""

import json
import unittest
import uuid
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend import storage
from backend.config import SELF_MOA_SAMPLES
from backend.main import app
from backend.settings import settings

SYNTH_LEAD = 'You are aggregating independent answers from one model.'


def sse_types(text):
    types = []
    for line in text.splitlines():
        if line.startswith('data: '):
            types.append(json.loads(line[len('data: '):])['type'])
    return types


class FakeModel:
    """Answers samples with numbered text and the synthesis with 'final'."""

    def __init__(self, fail_synthesis=False):
        self.calls = []
        self.fail_synthesis = fail_synthesis

    async def __call__(self, model, messages, *args, **kwargs):
        content = messages[0]['content']
        prompt = content if isinstance(content, str) else json.dumps(content)
        self.calls.append((model, prompt))
        if prompt.startswith(SYNTH_LEAD):
            if self.fail_synthesis:
                return {'ok': False, 'error': {'status': 500, 'message': 'down'}}
            return {'ok': True, 'content': 'final', 'usage': {}}
        index = len(self.calls)
        return {'ok': True, 'content': f'sample {index}', 'usage': {}}


class SelfMoaTests(unittest.TestCase):
    def setUp(self):
        self.saved = settings.to_dict()
        self.addCleanup(setattr, settings, '_api_key', settings._api_key)
        if not settings.has_api_key:
            settings.api_key = 'sk-test'
        self.tmp = TemporaryDirectory()
        self.dir_patch = patch('backend.storage.DATA_DIR', self.tmp.name)
        self.dir_patch.start()
        self.title_patch = patch(
            'backend.main.generate_conversation_title',
            new=AsyncMock(return_value='Title'),
        )
        self.title_patch.start()
        self.conv_id = str(uuid.uuid4())
        storage.create_conversation(self.conv_id)

    def tearDown(self):
        self.title_patch.stop()
        self.dir_patch.stop()
        self.tmp.cleanup()
        settings.update_from_dict({
            key: self.saved[key]
            for key in (
                'mode', 'council_models', 'n_samples', 'chairman_model',
                'top_k', 'red_team_model', 'self_exclusion',
            )
        })

    def use_self_moa(self, model):
        settings.update_from_dict({
            'mode': 'self_moa',
            'council_models': ['a/one', 'b/two'],
            'chairman_model': model,
            'n_samples': 1,
        })

    def send(self, fake):
        with patch('backend.council.query_model_result', new=fake):
            client = TestClient(app)
            return client.post(
                f'/api/conversations/{self.conv_id}/message/stream',
                json={'content': 'What is 2 + 2?'},
            )

    def test_stream_samples_one_model_and_synthesizes(self):
        self.use_self_moa('x/model')
        fake = FakeModel()
        response = self.send(fake)
        self.assertEqual(response.status_code, 200)
        types = sse_types(response.text)
        self.assertNotIn('stage2_start', types)
        self.assertNotIn('redteam_start', types)
        self.assertIn('stage3_complete', types)
        self.assertEqual(types[-1], 'complete')

        self.assertEqual(len(fake.calls), SELF_MOA_SAMPLES + 1)
        self.assertTrue(all(model == 'x/model' for model, _ in fake.calls))
        synth = [prompt for _, prompt in fake.calls if prompt.startswith(SYNTH_LEAD)]
        self.assertEqual(len(synth), 1)
        self.assertIn('Original Question: What is 2 + 2?', synth[0])
        self.assertIn(f'Sample slot {SELF_MOA_SAMPLES}:', synth[0])

        assistant = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertEqual(len(assistant['stage1']), SELF_MOA_SAMPLES)
        self.assertFalse(assistant.get('stage2'))
        self.assertEqual(assistant['metadata']['mode'], 'self_moa')
        self.assertEqual(assistant['metadata']['model'], 'x/model')
        self.assertEqual(assistant['metadata']['sample_count'], SELF_MOA_SAMPLES)
        self.assertEqual(assistant['stage3']['response'], 'final')
        self.assertEqual(assistant['stage3']['mode'], 'self_moa')
        self.assertFalse(assistant.get('streaming'))

    def test_free_model_keeps_every_sample(self):
        self.use_self_moa('x/model:free')
        fake = FakeModel()
        response = self.send(fake)
        self.assertEqual(response.status_code, 200)
        samples = [prompt for _, prompt in fake.calls if not prompt.startswith(SYNTH_LEAD)]
        self.assertEqual(len(samples), SELF_MOA_SAMPLES)

    def test_council_mode_still_ranks(self):
        settings.update_from_dict({
            'mode': 'council',
            'council_models': ['a/one'],
            'chairman_model': 'a/one',
            'n_samples': 1,
        })
        fake = FakeModel()
        response = self.send(fake)
        self.assertIn('stage2_start', sse_types(response.text))

    def test_synthesis_failure_is_stage3_error(self):
        self.use_self_moa('x/model')
        response = self.send(FakeModel(fail_synthesis=True))
        types = sse_types(response.text)
        self.assertIn('stage3_error', types)
        self.assertNotIn('complete', types)
        assistant = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertEqual(assistant['error']['stage'], 3)
        self.assertFalse(assistant.get('streaming'))

    def test_retry_stage3_uses_stored_samples_and_model(self):
        self.use_self_moa('x/model')
        self.send(FakeModel(fail_synthesis=True))
        # The setting changes after the run; the retry keeps the stored model.
        settings.update_from_dict({'mode': 'council', 'chairman_model': 'a/one'})
        fake = FakeModel()
        for stage in (2, 3):
            with patch('backend.council.query_model_result', new=fake):
                client = TestClient(app)
                response = client.post(
                    f'/api/conversations/{self.conv_id}/retry/stage{stage}/stream',
                    json={'message_index': 1},
                )
            self.assertEqual(response.status_code, 200)
            types = sse_types(response.text)
            self.assertIn('stage3_complete', types)
            self.assertNotIn('stage2_start', types)
        self.assertEqual([model for model, _ in fake.calls], ['x/model', 'x/model'])
        assistant = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertEqual(assistant['stage3']['response'], 'final')

    def test_retry_stage1_resumes_samples(self):
        self.use_self_moa('x/model')
        self.send(FakeModel())
        settings.update_from_dict({'mode': 'council'})
        fake = FakeModel()
        with patch('backend.council.query_model_result', new=fake):
            client = TestClient(app)
            response = client.post(
                f'/api/conversations/{self.conv_id}/retry/stage1/stream',
                json={'message_index': 1},
            )
        types = sse_types(response.text)
        self.assertNotIn('stage2_start', types)
        self.assertIn('stage3_complete', types)
        # Five samples are stored already, so only the synthesis runs again.
        self.assertEqual(len(fake.calls), 1)
        assistant = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertEqual(assistant['metadata']['mode'], 'self_moa')


class SelfMoaSettingsTests(unittest.TestCase):
    def setUp(self):
        self.saved = settings.to_dict()
        catalogue = patch(
            'backend.main.unknown_catalogue_ids',
            new=AsyncMock(return_value=[]),
        )
        catalogue.start()
        self.addCleanup(catalogue.stop)

    def tearDown(self):
        settings.update_from_dict({
            key: self.saved[key]
            for key in ('mode', 'council_models', 'chairman_model', 'n_samples')
        })

    def test_mode_round_trip_and_reset(self):
        client = TestClient(app)
        response = client.put('/api/settings', json={'mode': 'self_moa'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['mode'], 'self_moa')
        self.assertEqual(client.get('/api/settings').json()['mode'], 'self_moa')
        reset = client.post('/api/settings/reset').json()
        self.assertEqual(reset['mode'], 'council')

    def test_unknown_mode_is_rejected(self):
        client = TestClient(app)
        response = client.put('/api/settings', json={'mode': 'mystery'})
        self.assertEqual(response.status_code, 400)


if __name__ == '__main__':
    unittest.main()
