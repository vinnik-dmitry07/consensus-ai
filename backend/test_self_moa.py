"""Self-MoA (S8) mode in the local backend."""

import asyncio
import json
import unittest
import uuid
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend import storage
from backend.config import SELF_MOA_SAMPLES, SELF_MOA_TAIL_MARKER
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

    def __init__(self, fail_synthesis=False, sample=None):
        self.calls = []
        self.options = []
        self.fail_synthesis = fail_synthesis
        self.sample = sample

    async def __call__(self, model, messages, *args, **kwargs):
        content = messages[0]['content']
        prompt = content if isinstance(content, str) else json.dumps(content)
        self.calls.append((model, prompt))
        self.options.append(kwargs)
        if prompt.startswith(SYNTH_LEAD):
            if self.fail_synthesis:
                return {'ok': False, 'error': {'status': 500, 'message': 'down'}}
            return {'ok': True, 'content': 'final', 'usage': {}}
        index = len(self.calls)
        if self.sample:
            result = self.sample(index)
            if asyncio.iscoroutine(result):
                result = await result
            return result
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
        self.assertEqual(synth[0], (
            f'{SYNTH_LEAD}\nThe samples may repeat the same mistake. '
            'Do not treat agreement as proof.\nGive your own final answer.\n\n'
            'What is 2 + 2?\n\n'
            + '\n\n'.join(f'Sample slot {n}:\nsample {n}' for n in range(1, 6))
        ))
        for options in fake.options:
            self.assertEqual(options['max_tokens'], 32768)
            self.assertEqual(options['temperature'], 0.7)
            self.assertEqual(options['top_p'], 1)
            self.assertEqual(options['total_seconds'], 4216)
            self.assertEqual(options['max_retries'], 2)
            self.assertTrue(options['loop_guard'])
            self.assertTrue(options['stream'])
            self.assertTrue(options['annotate'])

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


    def test_incomplete_set_stops_and_combines_on_request(self):
        self.use_self_moa('x/model')

        def sample(index):
            if index == 2:
                return {'ok': False, 'error': {'status': 500, 'message': 'down'}}
            return {'ok': True, 'content': f'sample {index}', 'usage': {}}

        fake = FakeModel(sample=sample)
        response = self.send(fake)
        types = sse_types(response.text)
        self.assertIn('stage1_complete', types)
        self.assertIn('stage1_error', types)
        self.assertNotIn('stage3_start', types)
        self.assertFalse(any(prompt.startswith(SYNTH_LEAD) for _, prompt in fake.calls))
        assistant = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertEqual(assistant['error'], {
            'stage': 1,
            'message': 'Only 4 of 5 samples arrived. Resume Stage 1 to fetch the rest, '
                       'or combine the 4 you have.',
        })
        self.assertEqual(assistant['metadata'], {'mode': 'self_moa', 'model': 'x/model'})

        combine = FakeModel()
        with patch('backend.council.query_model_result', new=combine):
            TestClient(app).post(
                f'/api/conversations/{self.conv_id}/retry/stage3/stream',
                json={'message_index': 1},
            )
        self.assertEqual(len(combine.calls), 1)
        assistant = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertEqual(assistant['stage3']['sample_count'], 4)
        self.assertIsNone(assistant.get('error'))

    def test_cut_sample_passes_only_its_marked_tail(self):
        self.use_self_moa('x/model')
        reasoning = 'head ' * 2000 + 'z' * 8000

        def sample(index):
            if index == 1:
                return {
                    'ok': True, 'content': reasoning, 'usage': {},
                    'content_from_reasoning': True, 'finish_reason': 'length',
                }
            return {'ok': True, 'content': f'sample {index}', 'usage': {}, 'finish_reason': 'stop'}

        fake = FakeModel(sample=sample)
        self.send(fake)
        assistant = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertTrue(assistant['stage1'][0]['cut_reasoning'])
        self.assertTrue(all('cut_reasoning' not in row for row in assistant['stage1'][1:]))
        synth = next(prompt for _, prompt in fake.calls if prompt.startswith(SYNTH_LEAD))
        self.assertIn(
            f'Sample slot 1:\n{SELF_MOA_TAIL_MARKER}\n' + 'z' * 8000 + '\n\nSample slot 2:',
            synth,
        )
        self.assertNotIn('head head', synth)

    def test_samples_keep_slot_order(self):
        self.use_self_moa('x/model')

        async def sample(index):
            await asyncio.sleep((6 - index) * 0.04)
            return {'ok': True, 'content': f'sample {index}', 'usage': {}}

        fake = FakeModel(sample=sample)
        response = self.send(fake)
        finished = []
        for line in response.text.splitlines():
            if line.startswith('data: '):
                event = json.loads(line[len('data: '):])
                if event['type'] == 'stage1_model_complete':
                    finished.append(event['data']['result']['response'])
        # Calls start in slot order and here finish in reverse; Stage 1 is
        # stored by slot, never by finish time.
        self.assertEqual(finished, [f'sample {n}' for n in range(5, 0, -1)])
        assistant = storage.get_conversation(self.conv_id)['messages'][1]
        self.assertEqual(
            [row['response'] for row in assistant['stage1']],
            [f'sample {n}' for n in range(1, 6)],
        )

    def test_reads_a_browser_s8_message(self):
        settings.update_from_dict({'mode': 'council', 'council_models': ['y/other'], 'chairman_model': 'y/other'})
        storage.add_user_message(self.conv_id, 'q')
        samples = [{'model': 'x/model', 'response': f's{n}'} for n in range(1, 6)]
        storage.add_assistant_message(self.conv_id, samples, [], None, metadata=None)
        conversation = storage.get_conversation(self.conv_id)
        conversation['messages'][1]['run_roster'] = {
            'mode': 'self_moa', 'chairmanModel': 'x/model', 'councilModels': ['y/other'],
        }
        storage.save_conversation(conversation)
        fake = FakeModel()
        with patch('backend.council.query_model_result', new=fake):
            response = TestClient(app).post(
                f'/api/conversations/{self.conv_id}/retry/stage3/stream',
                json={'message_index': 1},
            )
        self.assertIn('stage3_complete', sse_types(response.text))
        self.assertEqual([model for model, _ in fake.calls], ['x/model'])


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
