"""The streaming path of the backend OpenRouter client (Self-MoA calls)."""

import asyncio
import json
import unittest
from unittest.mock import patch

import httpx

from backend.config import OPENROUTER_API_URL
from backend.openrouter import query_model_result

LOOP_TEXT = 'The model keeps saying the same thing. ' * 600


def sse(deltas, finish='stop', usage=None):
    lines = []
    for delta in deltas:
        lines.append('data: ' + json.dumps({'choices': [{'delta': delta}]}))
        lines.append('')
    final = {'choices': [{'delta': {}, 'finish_reason': finish}]}
    if usage:
        final['usage'] = usage
    lines += ['data: ' + json.dumps(final), '', ': keep-alive', '', 'data: [DONE]', '']
    return lines


def chunks(text, size):
    return [text[i:i + size] for i in range(0, len(text), size)]


class FakeStream:
    def __init__(self, lines, content_type='text/event-stream', delay=0.0):
        self.status_code = 200
        self.headers = {'content-type': content_type}
        self._lines = lines
        self._delay = delay

    async def aread(self):
        return b''

    def json(self):
        return json.loads('\n'.join(self._lines))

    async def aiter_lines(self):
        for line in self._lines:
            if self._delay:
                await asyncio.sleep(self._delay)
            yield line


class FakeClient:
    """Each stream() returns the next scripted response."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.payloads = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def stream(self, method, url, headers=None, json=None):
        self.payloads.append(json)
        response = self.responses.pop(0)

        class Context:
            async def __aenter__(self):
                return response

            async def __aexit__(self, *args):
                return False

        return Context()


def run(coro):
    return asyncio.run(coro)


S8_OPTIONS = {
    'max_tokens': 32768,
    'temperature': 0.7,
    'top_p': 1,
    'stream': True,
    'loop_guard': True,
    'max_retries': 2,
    'annotate': True,
    'timeout': 120.0,
    'total_seconds': 4216,
}


class StreamTests(unittest.TestCase):
    def query(self, responses, **options):
        client = FakeClient(responses)
        with (
            patch('backend.openrouter.get_api_key', return_value='sk-test'),
            patch('backend.openrouter.httpx.AsyncClient', return_value=client),
        ):
            result = run(query_model_result(
                'openai/gpt-4.1', [{'role': 'user', 'content': 'q'}],
                **{**S8_OPTIONS, **options},
            ))
        return result, client

    def test_answer_with_usage_and_request_fields(self):
        usage = {'prompt_tokens': 3, 'completion_tokens': 9, 'total_tokens': 12}
        result, client = self.query([FakeStream(sse(
            [{'reasoning': 'think '}, {'content': 'ANSWER: '}, {'content': '4'}],
            usage=usage,
        ))])
        self.assertTrue(result['ok'])
        self.assertEqual(result['content'], 'ANSWER: 4')
        self.assertEqual(result['usage'], usage)
        self.assertEqual(result['finish_reason'], 'stop')
        self.assertNotIn('content_from_reasoning', result)
        payload = client.payloads[0]
        self.assertEqual(payload['max_tokens'], 32768)
        self.assertEqual(payload['temperature'], 0.7)
        self.assertEqual(payload['top_p'], 1)
        self.assertTrue(payload['stream'])
        self.assertEqual(payload['stream_options'], {'include_usage': True})

    def test_reasoning_cut_at_the_cap_is_marked(self):
        result, _ = self.query([FakeStream(sse([{'reasoning': 'only thinking'}], finish='length'))])
        self.assertTrue(result['ok'])
        self.assertEqual(result['content'], 'only thinking')
        self.assertTrue(result['content_from_reasoning'])
        self.assertEqual(result['finish_reason'], 'length')

    def test_loop_is_retried_once_then_kept(self):
        looping = [{'reasoning': part} for part in chunks(LOOP_TEXT, 400)]
        result, client = self.query([FakeStream(sse(looping)), FakeStream(sse(looping))])
        self.assertEqual(len(client.payloads), 2)
        self.assertTrue(result['ok'])
        self.assertTrue(result['loop_cut'])
        self.assertEqual(result['finish_reason'], 'loop')
        self.assertTrue(result['content_from_reasoning'])
        self.assertEqual(result['loop']['channel'], 'reasoning')
        self.assertLess(len(result['content']), len(LOOP_TEXT))
        self.assertGreaterEqual(len(result['content']), result['loop']['position'])

    def test_loop_then_answer(self):
        looping = [{'reasoning': part} for part in chunks(LOOP_TEXT, 400)]
        result, client = self.query([
            FakeStream(sse(looping)),
            FakeStream(sse([{'content': 'fine'}])),
        ])
        self.assertEqual(len(client.payloads), 2)
        self.assertEqual(result['content'], 'fine')
        self.assertNotIn('loop_cut', result)

    def test_no_loop_retry_when_none_left(self):
        looping = [{'reasoning': part} for part in chunks(LOOP_TEXT, 400)]
        result, client = self.query([FakeStream(sse(looping))], max_retries=1)
        self.assertEqual(len(client.payloads), 1)
        self.assertTrue(result['loop_cut'])

    def test_http_error_keeps_the_existing_handling(self):
        request = httpx.Request('POST', OPENROUTER_API_URL)
        error = httpx.Response(402, json={'error': {'message': 'Insufficient credits'}}, request=request)
        result, client = self.query([error])
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['status'], 402)
        self.assertEqual(len(client.payloads), 1)

    def test_error_inside_the_stream(self):
        lines = ['data: ' + json.dumps({'error': {'message': 'upstream broke', 'code': 502}}), '']
        result, _ = self.query([FakeStream(lines)])
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['message'], 'upstream broke')
        self.assertEqual(result['error']['status'], 502)

    def test_stream_without_done_is_a_failure(self):
        lines = ['data: ' + json.dumps({'choices': [{'delta': {'content': 'half'}}]}), '']
        result, _ = self.query([FakeStream(lines)])
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['detail'], 'Stream ended before [DONE]')

    def test_json_reply_to_a_stream_request(self):
        body = {'choices': [{'message': {'content': 'plain'}, 'finish_reason': 'stop'}], 'usage': {}}
        result, _ = self.query([FakeStream([json.dumps(body)], content_type='application/json')])
        self.assertTrue(result['ok'])
        self.assertEqual(result['content'], 'plain')
        self.assertEqual(result['finish_reason'], 'stop')

    def test_total_deadline(self):
        slow = FakeStream(sse([{'content': 'a'}] * 20), delay=0.05)
        result, _ = self.query([slow], total_seconds=0.2)
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['message'], 'total')


if __name__ == '__main__':
    unittest.main()
