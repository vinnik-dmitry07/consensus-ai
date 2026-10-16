'''Skipped requests advance SSE progress without persisting failure tabs.'''

import json
import uuid

import pytest
from fastapi.testclient import TestClient

from backend import council, main, storage
from backend.settings import settings


@pytest.fixture
def conversation(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(settings, '_api_key', 'sk-test')
    monkeypatch.setattr(settings, '_council_models', [
        'a/keep', 'b/refused:free',
    ])
    monkeypatch.setattr(settings, '_chairman_model', 'a/keep')
    monkeypatch.setattr(settings, '_n_samples', 1)
    conversation_id = str(uuid.uuid4())
    storage.create_conversation(conversation_id)
    storage.add_user_message(conversation_id, 'hello')
    storage.add_assistant_message(
        conversation_id,
        [{'model': 'a/keep', 'response': 'kept answer'}],
        [{'model': 'a/keep', 'ranking': '1. Response 1'}],
        {'model': 'a/keep', 'response': 'old answer'},
    )
    return conversation_id


def retry(conversation_id, stage):
    with TestClient(main.app) as client:
        response = client.post(
            f'/api/conversations/{conversation_id}/retry/stage{stage}/stream',
            json={'message_index': 1},
        )
    assert response.status_code == 200
    return [
        json.loads(line.removeprefix('data: '))
        for line in response.text.splitlines()
        if line.startswith('data: ')
    ]


@pytest.mark.parametrize('skipped', [True, False])
def test_skips_keep_progress_but_only_failures_are_stored(
    conversation, monkeypatch, skipped,
):
    async def query(model, *args, **kwargs):
        if model == 'b/refused:free':
            return {
                'ok': False,
                'skipped': skipped,
                'error': {
                    'status': 429 if skipped else 500,
                    'message': 'unavailable',
                    'detail': '',
                },
            }
        return {
            'ok': True,
            'content': (
                'Response 1:\nCorrectness: 8/10\n'
                'FINAL RANKING:\n1. Response 1'
            ),
            'usage': {},
        }

    monkeypatch.setattr(council, 'query_model_result', query)
    events = retry(conversation, 1)
    message = storage.get_conversation(conversation)['messages'][1]

    for stage in (1, 2):
        failed = next(
            event for event in events
            if event['type'] == f'stage{stage}_model_failed'
        )
        assert failed['data']['model'] == 'b/refused:free'
        assert bool(failed['data'].get('skipped')) is skipped
        progress = [
            event for event in events if event['type'] in (
                f'stage{stage}_model_complete',
                f'stage{stage}_model_failed',
            )
        ]
        assert len(progress) == 2
        completion = next(
            event for event in events
            if event['type'] == f'stage{stage}_complete'
        )
        expected = [] if skipped else ['b/refused:free']
        assert [item['model'] for item in completion['failures']] == expected
        assert [
            item['model'] for item in message[f'stage{stage}_failures']
        ] == expected
    assert any(event['type'] == 'complete' for event in events)
    assert message['stage3']['response']
    assert message['streaming'] is False


def test_all_judges_skipped_is_visible_stage_error(conversation, monkeypatch):
    async def query(*args, **kwargs):
        return {
            'ok': False,
            'skipped': True,
            'error': {'status': 429, 'message': 'cooling down'},
        }

    monkeypatch.setattr(council, 'query_model_result', query)
    events = retry(conversation, 2)
    error = next(event for event in events if event['type'] == 'stage2_error')
    assert error['message'] == 'All models failed to respond in Stage 2'
    assert error['failures'] == []
    assert not any(event['type'] == 'stage2_complete' for event in events)
    message = storage.get_conversation(conversation)['messages'][1]
    assert message['error']['stage'] == 2
    assert message['stage2_failures'] == []
    assert message['stage3'] is None
    assert message['streaming'] is False


def test_empty_final_failure_list_replaces_interim_list(
    conversation, monkeypatch,
):
    async def rankings(*args, **kwargs):
        yield 'init', {'total_models': 1}
        yield 'model_failed', {
            'model': 'a/keep',
            'error': {'message': 'interim failure'},
        }
        yield 'all_complete', {
            'results': [],
            'label_to_model': {},
            'failures': [],
        }

    monkeypatch.setattr(main, 'stage2_collect_rankings_streaming', rankings)
    events = retry(conversation, 2)
    error = next(event for event in events if event['type'] == 'stage2_error')
    assert error['failures'] == []
    message = storage.get_conversation(conversation)['messages'][1]
    assert message['stage2_failures'] == []
