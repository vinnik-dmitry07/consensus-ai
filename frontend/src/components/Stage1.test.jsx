import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import ChatInterface from './ChatInterface';
import Stage1 from './Stage1';

const stage1Source = readFileSync(new URL('./Stage1.jsx', import.meta.url), 'utf8');
const SENTINEL = 'PROVIDER_JSON_SENTINEL';

function renderStage(props) {
  return renderToStaticMarkup(<Stage1 {...props} />);
}

function answer(model, response) {
  return { model, response };
}

describe('Stage1 answers', () => {
  it('renders only non-empty answers, in order, with the latest one open', () => {
    const html = renderStage({
      isRunning: true,
      progress: { total: 4, completed: 2 },
      responses: [
        answer('openai/gpt', '  first answer  '),
        { model: 'blank/model', response: '   ' },
        { model: 'bad/model', response: { text: 'nope' } },
        answer('openai/gpt', 'second answer'),
      ],
      failures: [{
        model: 'nvidia/nemotron-3-super-120b-a12b:free',
        error: {
          message: 'Model not found (404)',
          detail: `{"id":"${SENTINEL}"}`,
        },
      }],
    });

    expect(html).toContain('gpt #1');
    expect(html).toContain('gpt #2');
    expect(html).not.toContain('blank/model');
    expect(html).not.toContain('(failed)');
    expect(html).toContain('second answer');
    expect(html).not.toContain('first answer');
    expect(html).toContain('class="tab active"');
    expect(html).toContain('2/4 responses');
    expect(html).toContain('width:50%');
    expect(html).toContain('Failed: nemotron-3-super-120b-a12b:free — Model not found (404)');
    expect(html).not.toContain(SENTINEL);
    expect(stage1Source).not.toContain('127.0.0.1:7417');
    expect(stage1Source).not.toContain('error.detail');
  });

  it('hides the spinner after a generic error and still shows answers and notes', () => {
    const html = renderStage({
      isRunning: false,
      progress: { total: 2, completed: 2 },
      responses: [answer('liquid/lfm', 'kept answer')],
      failures: [{ model: 'openai/gpt', error: { message: '' } }],
      skipped: [{ model: 'google/gemma', error: { message: 'Temporarily rate-limited upstream' } }],
    });

    expect(html).toContain('kept answer');
    expect(html).toContain('Failed: gpt — Request failed');
    expect(html).toContain('Skipped: gemma — Temporarily rate-limited upstream');
    expect(html).not.toContain('progress-spinner');
    expect(html).not.toContain('progress-bar');
    expect(html).not.toContain('responses');
  });

  it('shows notes without tabs for an all-failed or all-skipped run, including total 0', () => {
    const failed = renderStage({
      isRunning: false,
      responses: [],
      failures: [{ model: 'openai/gpt', error: { message: 'Model not found (404)' } }],
      skipped: [],
    });
    expect(failed).toContain('No successful responses');
    expect(failed).toContain('Failed: gpt — Model not found (404)');
    expect(failed).not.toContain('class="tab');

    const skipped = renderStage({
      isRunning: true,
      progress: { total: 0, completed: 0 },
      responses: [],
      failures: [],
      skipped: [{
        model: 'thinkingmachines/inkling:free',
        error: { message: 'Only available on agentic harnesses', detail: SENTINEL },
      }],
    });
    expect(skipped).toContain('Waiting for first response...');
    expect(skipped).toContain('0 responses');
    expect(skipped).toContain('width:0%');
    expect(skipped).toContain('Skipped: inkling:free — Only available on agentic harnesses');
    expect(skipped).not.toContain('NaN');
    expect(skipped).not.toContain('Infinity');
    expect(skipped).not.toContain(SENTINEL);
  });

  it('keeps known skip reasons and replaces unsafe failure text', () => {
    const html = renderStage({
      isRunning: false,
      responses: [],
      failures: [
        { model: 'a/pay', error: { message: '402: cannot afford reserved tokens' } },
        { model: 'a/http', error: { message: `HTTP 500: {"secret":"${SENTINEL}"}` } },
        { model: 'a/json', error: { message: `{"secret":"${SENTINEL}"}`, detail: SENTINEL } },
        { model: 'a/status', error: { message: 'Request failed', status: 403 } },
      ],
      skipped: [
        { model: 'b/harness', error: { message: 'Only available on agentic harnesses' } },
        { model: 'b/rate', error: { message: 'Temporarily rate-limited upstream' } },
        { model: 'b/cool', error: { message: 'Cooling down after an upstream rate limit' } },
        { model: 'b/block', error: { message: 'OpenRouter will not serve this model' } },
        { model: 'b/plain', error: { message: 'Skipped' } },
        { model: 'b/unknown', error: { message: `{"reason":"${SENTINEL}"}` } },
        { model: 'b/empty', error: { message: '   ' } },
      ],
    });

    expect(html).toContain('Failed: pay — 402: cannot afford reserved tokens');
    expect(html).toContain('Failed: http — HTTP 500');
    expect(html).toContain('Failed: json — Request failed');
    expect(html).toContain('Failed: status — Request failed');
    expect(html).toContain('Skipped: harness — Only available on agentic harnesses');
    expect(html).toContain('Skipped: rate — Temporarily rate-limited upstream');
    expect(html).toContain('Skipped: cool — Cooling down after an upstream rate limit');
    expect(html).toContain('Skipped: block — OpenRouter will not serve this model');
    expect(html).toContain('Skipped: plain');
    expect(html).not.toContain('Skipped: plain — Skipped');
    expect(html).toContain('Skipped: unknown');
    expect(html).toContain('Skipped: empty');
    expect(html).not.toContain(SENTINEL);
    expect(html.match(/agentic harnesses/g)).toHaveLength(1);
  });

  it('shows a saved skip list and treats a missing list as empty', () => {
    const saved = renderStage({
      isRunning: false,
      responses: [answer('poolside/laguna', 'stored answer')],
      skipped: [{
        model: 'xingchen-agi/xing4.0-29b-a4b:free',
        error: { message: 'Temporarily rate-limited upstream' },
      }],
    });
    expect(saved).toContain('stored answer');
    expect(saved).toContain('Skipped: xing4.0-29b-a4b:free — Temporarily rate-limited upstream');

    const legacy = renderStage({
      isRunning: false,
      responses: [answer('poolside/laguna', 'legacy answer')],
    });
    expect(legacy).toContain('legacy answer');
    expect(legacy).not.toContain('Skipped:');
  });

  it('renders markdown for the open answer and a copy control', () => {
    const html = renderStage({
      responses: [answer('liquid/lfm', 'Keep **this** claim')],
    });
    expect(html).toContain('<strong>this</strong>');
    expect(html).toContain('aria-label="Copy response"');
    expect(html).not.toContain('stage1-notes');
  });
});

describe('saved Stage 1 history in the chat', () => {
  it('shows stored skips after the message is opened and ignores a missing field', () => {
    const savedHtml = renderToStaticMarkup(
      <ChatInterface
        conversation={{
          id: 'saved-chat',
          messages: [
            { role: 'user', content: 'Question' },
            {
              role: 'assistant',
              stage1: [answer('poolside/laguna-s-2.1', 'saved body')],
              stage1_skipped: [{
                model: 'google/gemma-4-31b-it:free',
                error: { message: 'Temporarily rate-limited upstream', detail: SENTINEL },
              }],
              loading: { stage1: false },
            },
          ],
        }}
        onSendMessage={() => {}}
        onRetryStage={() => {}}
        isLoading={false}
      />,
    );
    expect(savedHtml).toContain('saved body');
    expect(savedHtml).toContain('Skipped: gemma-4-31b-it:free — Temporarily rate-limited upstream');
    expect(savedHtml).not.toContain(SENTINEL);
    expect(savedHtml).not.toContain('progress-spinner');

    const legacyHtml = renderToStaticMarkup(
      <ChatInterface
        conversation={{
          id: 'legacy-chat',
          messages: [
            { role: 'user', content: 'Question' },
            {
              role: 'assistant',
              stage1: [answer('poolside/laguna-s-2.1', 'legacy body')],
              loading: { stage1: false },
            },
          ],
        }}
        onSendMessage={() => {}}
        onRetryStage={() => {}}
        isLoading={false}
      />,
    );
    expect(legacyHtml).toContain('legacy body');
    expect(legacyHtml).not.toContain('Skipped:');
  });

  it('does not open Stage 1 for an empty interrupted message', () => {
    const html = renderToStaticMarkup(
      <ChatInterface
        conversation={{
          id: 'empty-chat',
          messages: [
            { role: 'user', content: 'Question' },
            {
              role: 'assistant',
              stage1: [],
              streaming: true,
              loading: { stage1: false },
            },
          ],
        }}
        onSendMessage={() => {}}
        onRetryStage={() => {}}
        isLoading={false}
      />,
    );
    expect(html).toContain('No responses collected yet');
    expect(html).not.toContain('No successful responses');
    expect(html).not.toContain('Stage 1: Individual Responses');
  });
});

function chatHtml(assistant) {
  return renderToStaticMarkup(
    <ChatInterface
      conversation={{
        id: 'chat',
        messages: [
          { role: 'user', content: 'Question' },
          { role: 'assistant', ...assistant },
        ],
      }}
      onSendMessage={() => {}}
      onRetryStage={() => {}}
      isLoading={false}
    />,
  );
}

describe('interrupted Stage 1', () => {
  it('keeps notes and Resume without the empty caption', () => {
    const html = chatHtml({
      stage1: [],
      streaming: true,
      loading: { stage1: false },
      stage1_skipped: [{
        model: 'google/gemma',
        error: { message: 'Temporarily unavailable (cooldown)' },
      }],
    });
    expect(html).toContain('Resume from Stage 1');
    expect(html).toContain('Skipped: gemma — Temporarily unavailable (cooldown)');
    expect(html).not.toContain('No responses collected yet');
  });

  it('counts usable answers and ignores a blank sample', () => {
    const html = chatHtml({
      stage1: [
        answer('a/one', 'yes'),
        answer('b/two', '   '),
      ],
      streaming: true,
      loading: { stage1: false },
    });
    expect(html).toContain('1 response(s) collected');
    expect(html).not.toContain('2 response');
  });

  it('does not open Stage 1 for whitespace only', () => {
    const html = chatHtml({
      stage1: [answer('a/one', '   ')],
      streaming: true,
      loading: { stage1: false },
    });
    expect(html).toContain('No responses collected yet');
    expect(html).not.toContain('Stage 1: Individual Responses');
  });

  it('shows a failure note without the empty caption', () => {
    const html = chatHtml({
      stage1: [],
      streaming: true,
      loading: { stage1: false },
      stage1_failures: [{
        model: 'openai/missing',
        error: { message: 'idle', detail: SENTINEL },
      }],
    });
    expect(html).toContain('Resume from Stage 1');
    expect(html).toContain('Failed: missing — Request failed');
    expect(html).not.toContain('No responses collected yet');
    expect(html).not.toContain(SENTINEL);
    expect(html).not.toContain('idle');
  });
});

describe('stopped Stage 1 and Stage 2 notes', () => {
  it('hides the spinner after a stop and keeps the partial answer', () => {
    const html = renderStage({
      responses: [answer('a/one', 'partial answer')],
      progress: { total: 2, completed: 1, results: [answer('a/one', 'partial answer')] },
      isRunning: false,
      failures: [{ model: 'b/two', error: { message: 'first-response' } }],
    });
    expect(html).toContain('partial answer');
    expect(html).toContain('Failed: two — Request failed');
    expect(html).not.toContain('progress-spinner');
    expect(html).not.toContain('first-response');
  });

  it('does not print provider bodies or timeout tokens on Stage 2 notes', () => {
    const html = chatHtml({
      stage2_skipped: [{
        model: 'google/gemma',
        error: {
          message: `Temporarily rate-limited upstream ${SENTINEL}`,
          detail: SENTINEL,
        },
      }],
      stage2_failures: [
        { model: 'openai/gpt', error: { message: 'total', detail: SENTINEL } },
        { model: 'meta/llama', error: { message: `HTTP 503 ${SENTINEL}` } },
      ],
    });
    expect(html).toContain('Some judges were skipped');
    expect(html).toContain('gemma: Skipped');
    expect(html).toContain('gpt: Request failed');
    expect(html).toContain('llama: HTTP 503');
    expect(html).not.toContain('gpt: total');
    expect(html).not.toContain(SENTINEL);
  });
});
