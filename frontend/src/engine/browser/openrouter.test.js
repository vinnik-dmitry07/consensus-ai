import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserEngine } from './engine.js';
import {
  CatalogueUnavailable,
  CATALOGUE_FAILURE_COOLDOWN_MS,
  clearModelsCache,
  HEADER_WAIT_SECONDS,
  IDLE_WAIT_SECONDS,
  STREAM_TOTAL_SECONDS,
  FREE_TIER_API_KEY,
  getCredits,
  getKeyInfo,
  getModelsPricing,
  hasVisibleContent,
  modelFamily,
  OPENROUTER_MAX_TOKENS,
  OPENROUTER_MAX_TOKENS_HIGH,
  parseHttpError,
  parseRetryAfter,
  extendFreeCooldown,
  FREE_MAX_STARTS_PER_MINUTE,
  FREE_MINUTE_MS,
  FREE_START_GAP_MS,
  queryModelResult,
  resetFreeQueueForTests,
  resolveMaxTokens,
  unknownCatalogueIds,
} from './openrouter.js';
import { clearModelCooldowns, modelIsCooling, readBlockedIds } from './roster.js';
import { settings } from './settings.js';

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('model family', () => {
  it('treats the same vendor as one family', () => {
    expect(modelFamily('anthropic/claude-opus-4.1')).toBe(
      modelFamily('anthropic/claude-sonnet-4.5'),
    );
  });

  it('collapses reasoning variants and the alias prefix', () => {
    expect(modelFamily('~openai/gpt-sol-latest-reasoning-high')).toBe(
      modelFamily('openai/gpt-sol-latest'),
    );
  });

  it('keeps different vendors apart', () => {
    expect(modelFamily('google/gemini-pro-latest')).not.toBe(
      modelFamily('x-ai/grok-latest'),
    );
  });

  it('falls back to the id when there is no author', () => {
    expect(modelFamily('some-local-model')).toBe('some-local-model');
  });
});

describe('parseRetryAfter', () => {
  it('honours a seconds value', () => {
    expect(parseRetryAfter('7', 99)).toBe(7);
  });

  it('accepts an HTTP date without throwing', () => {
    const value = parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', 4);
    expect(value).toBeGreaterThanOrEqual(0);
  });

  it('falls back when the header is garbage', () => {
    expect(parseRetryAfter('soon', 4)).toBe(4);
  });

  it('falls back when the header is missing', () => {
    expect(parseRetryAfter(null, 8)).toBe(8);
  });

  it('clamps an absurd wait', () => {
    expect(parseRetryAfter('86400', 2)).toBe(60);
  });
});

describe('parseHttpError', () => {
  it('uses the reserved-tokens message for 402', async () => {
    const response = jsonResponse(402, {
      error: {
        message: 'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 2194.',
      },
    });
    const error = await parseHttpError(response);
    expect(error.status).toBe(402);
    expect(error.message).toBe('402: cannot afford reserved tokens');
    expect(error.detail).toContain('fewer max_tokens');
  });

  it('names a 404', async () => {
    const error = await parseHttpError(jsonResponse(404, {
      error: { message: 'No endpoints found' },
    }));
    expect(error.message).toBe('Model not found (404)');
    expect(error.detail).toBe('No endpoints found');
  });

  it('keeps a non-json body', async () => {
    const response = new Response('upstream exploded', { status: 500 });
    const error = await parseHttpError(response);
    expect(error.status).toBe(500);
    expect(error.message).toContain('upstream exploded');
  });

  it('keeps the provider raw text in the detail', async () => {
    const error = await parseHttpError(jsonResponse(429, {
      error: {
        message: 'Provider returned error',
        metadata: { raw: 'temporarily rate-limited upstream' },
      },
    }));
    expect(error.detail).toContain('Provider returned error');
    expect(error.detail).toContain('temporarily rate-limited upstream');
  });

  it('stringifies a non-string provider raw body', async () => {
    const error = await parseHttpError(jsonResponse(429, {
      error: {
        message: 'upstream',
        metadata: { raw: { error: 'temporarily rate-limited upstream' } },
      },
    }));
    expect(error.detail).toContain('temporarily rate-limited upstream');
  });
});

describe('resolveMaxTokens', () => {
  it('defaults to 16k', () => {
    expect(resolveMaxTokens('~openai/gpt-latest')).toBe(OPENROUTER_MAX_TOKENS);
  });

  it('uses 32k for reasoning-high', () => {
    expect(resolveMaxTokens('~anthropic/claude-fable-latest-reasoning-high')).toBe(
      OPENROUTER_MAX_TOKENS_HIGH,
    );
  });

  it('lets an override win', () => {
    expect(resolveMaxTokens('any-reasoning-high', 4096)).toBe(4096);
  });
});

describe('hasVisibleContent', () => {
  it('rejects empty and non-text payloads', () => {
    expect(hasVisibleContent('')).toBe(false);
    expect(hasVisibleContent('   ')).toBe(false);
    expect(hasVisibleContent(null)).toBe(false);
    expect(hasVisibleContent([])).toBe(false);
    expect(hasVisibleContent({ text: 'x' })).toBe(false);
  });

  it('accepts text', () => {
    expect(hasVisibleContent('hello')).toBe(true);
  });
});

function useFreeClock() {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
      'performance',
    ],
  });
}

function assertFreeSchedule(starts) {
  starts.forEach((start, index) => {
    if (index > 0) {
      expect(start - starts[index - 1]).toBeGreaterThanOrEqual(FREE_START_GAP_MS);
    }
    const inWindow = starts.filter(
      (time) => time > start - FREE_MINUTE_MS && time <= start,
    );
    expect(inWindow.length).toBeLessThanOrEqual(FREE_MAX_STARTS_PER_MINUTE);
  });
}

describe('queryModelResult', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns a structured 402 error', async () => {
    settings.apiKey = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(402, {
      error: { message: 'This request requires more credits' },
    })));
    const result = await queryModelResult('~x-ai/grok-latest', [
      { role: 'user', content: 'q' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe('402: cannot afford reserved tokens');
  });

  it('treats empty content as failure', async () => {
    settings.apiKey = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      choices: [{ message: { content: '' } }],
      usage: {},
    })));
    const result = await queryModelResult('~openai/gpt-latest', [
      { role: 'user', content: 'q' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe('Empty model response');
  });

  it('assembles a streamed completion', async () => {
    settings.apiKey = 'sk-test';
    const sse = [
      ': OPENROUTER PROCESSING',
      '',
      'data: {"choices":[{"delta":{"content":"KRAS "}}]}',
      '',
      'data: {"choices":[{"delta":{"reasoning":"ignored once content exists"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"autophagy"}}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';
    const fetchMock = vi.fn(async () => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await queryModelResult('nvidia/nemotron-3-ultra-550b-a55b:free', [
      { role: 'user', content: 'q' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('KRAS autophagy');
    expect(result.usage.total_tokens).toBe(6);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('uses streamed reasoning when the answer content is blank', async () => {
    settings.apiKey = 'sk-test';
    const sse = [
      'data: {"choices":[{"delta":{"reasoning":"the visible answer"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    const result = await queryModelResult('openai/gpt-4.1', [
      { role: 'user', content: 'q' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('the visible answer');
  });

  it('sends xhigh effort for an Anthropic reasoning-high model', async () => {
    settings.apiKey = 'sk-test';
    const fetchMock = vi.fn(async () => jsonResponse(200, {
      choices: [{ message: { content: 'yes' } }],
      usage: {},
    }));
    vi.stubGlobal('fetch', fetchMock);
    await queryModelResult('~anthropic/claude-opus-latest-reasoning-high', [
      { role: 'user', content: 'q' },
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('~anthropic/claude-opus-latest');
    expect(body.reasoning).toEqual({ effort: 'xhigh' });
    expect(body.max_tokens).toBe(OPENROUTER_MAX_TOKENS_HIGH);
    expect(fetchMock.mock.calls[0][1].headers['X-Title']).toBe('consensus.ai');
  });

  it('leaves phi-4-reasoning-plus unchanged and sends no reasoning field', async () => {
    settings.apiKey = 'sk-test';
    const fetchMock = vi.fn(async () => jsonResponse(200, {
      choices: [{ message: { content: 'yes' } }],
      usage: {},
    }));
    vi.stubGlobal('fetch', fetchMock);
    await queryModelResult('microsoft/phi-4-reasoning-plus', [
      { role: 'user', content: 'q' },
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('microsoft/phi-4-reasoning-plus');
    expect(body.reasoning).toBeUndefined();
    expect(body.max_tokens).toBe(OPENROUTER_MAX_TOKENS);
  });

  it('treats a 200 without choices as an empty response', async () => {
    settings.apiKey = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { usage: {} })));
    const result = await queryModelResult('openai/gpt-real', [
      { role: 'user', content: 'q' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe('Empty model response');
  });

  it('uses visible reasoning when content is empty', async () => {
    settings.apiKey = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      choices: [{ message: { content: '', reasoning: 'the visible answer' } }],
      usage: {},
    })));
    const result = await queryModelResult('nvidia/nemotron-3-ultra-550b-a55b:free', [
      { role: 'user', content: 'q' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('the visible answer');
  });

  it('uses reasoning_details when content and reasoning are blank', async () => {
    settings.apiKey = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      choices: [{
        message: {
          content: null,
          reasoning_details: [{ text: 'from details' }],
        },
      }],
      usage: {},
    })));
    const result = await queryModelResult('openai/gpt-4.1', [
      { role: 'user', content: 'q' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('from details');
  });

  it('does not retry a harness-only 403 and remembers the id', async () => {
    settings.apiKey = 'sk-test';
    settings.councilModels = [
      'thinkingmachines/inkling:free',
      'google/gemma-4-31b-it:free',
    ];
    settings.chairmanModel = 'google/gemma-4-31b-it:free';
    const fetchMock = vi.fn(async () => jsonResponse(403, {
      error: {
        message: 'thinkingmachines/inkling:free is only available on agentic harnesses.',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const first = await queryModelResult('thinkingmachines/inkling:free', [
      { role: 'user', content: 'q' },
    ]);
    resetFreeQueueForTests();
    const second = await queryModelResult('thinkingmachines/inkling:free', [
      { role: 'user', content: 'q' },
    ]);
    expect(first.ok).toBe(false);
    expect(first.skipped).toBe(true);
    expect(first.error.message).toBe('Only available on agentic harnesses');
    expect(second.skipped).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readBlockedIds().has('thinkingmachines/inkling:free')).toBe(true);
    expect(settings.councilModels).not.toContain('thinkingmachines/inkling:free');
    expect(settings.councilModels).toContain('google/gemma-4-31b-it:free');
  });

  it('cools an upstream-limited model without retrying', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(429, {
          error: {
            message: 'Provider returned error',
            metadata: {
              raw: 'google/gemma-4-31b-it:free is temporarily rate-limited upstream.',
            },
          },
        });
      }
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }));
    const messages = [{ role: 'user', content: 'q' }];
    const first = await queryModelResult('google/gemma-4-31b-it:free', messages);
    const second = await queryModelResult('google/gemma-4-31b-it:free-reasoning-high', messages);
    expect(first.skipped).toBe(true);
    expect(first.error.message).toBe('Temporarily rate-limited upstream');
    expect(second.skipped).toBe(true);
    expect(second.error.message).toBe('Temporarily unavailable (cooldown)');
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    const third = await queryModelResult('google/gemma-4-31b-it:free', messages);
    expect(third.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('still retries when provider text wraps free-models-per-min', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(429, {
          error: {
            message: 'Provider returned error',
            metadata: { raw: 'Rate limit exceeded: free-models-per-min' },
          },
        }, { 'Retry-After': '10' });
      }
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }));
    const pending = queryModelResult('a/one:free', [{ role: 'user', content: 'q' }]);
    await vi.advanceTimersByTimeAsync(10000);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(modelIsCooling('a/one:free')).toBe(false);
  });

  it('cools a generic provider 429 without calling it an upstream limit', async () => {
    useFreeClock();
    clearModelCooldowns();
    settings.apiKey = 'sk-test';
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(429, {
          error: { message: 'Provider returned error' },
        });
      }
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }));
    const messages = [{ role: 'user', content: 'q' }];
    const first = await queryModelResult('vendor/generic:free', messages);
    const second = await queryModelResult('vendor/generic:free', messages);
    expect(first.skipped).toBe(true);
    expect(first.error.message).toBe('Provider returned an error');
    expect(second.skipped).toBe(true);
    expect(second.error.message).toBe('Temporarily unavailable (cooldown)');
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    const third = await queryModelResult('vendor/generic:free', messages);
    expect(third.ok).toBe(true);
    expect(calls).toBe(2);
    clearModelCooldowns();
  });

  it('starts free calls at least 3 seconds apart', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    const starts = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      starts.push(performance.now());
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }));
    const pending = Promise.all([
      queryModelResult('a/one:free', [{ role: 'user', content: 'q' }]),
      queryModelResult('b/two:free', [{ role: 'user', content: 'q' }]),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(3000);
  });

  it('waits out free-models-per-min and then succeeds', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(429, {
          error: { message: 'Rate limit exceeded: free-models-per-min' },
        });
      }
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }));
    const pending = queryModelResult('google/gemma-4-31b-it:free', [
      { role: 'user', content: 'q' },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(59999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.content).toBe('ok');
    expect(calls).toBe(2);
  });

  it('does not queue a paid call behind a free call', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    let releaseFree;
    const held = new Promise((resolve) => {
      releaseFree = resolve;
    });
    const order = [];
    vi.stubGlobal('fetch', vi.fn((_url, init) => {
      const body = JSON.parse(init.body);
      order.push(body.model);
      if (String(body.model).endsWith(':free')) {
        return held.then(() => jsonResponse(200, {
          choices: [{ message: { content: 'ok' } }],
        }));
      }
      return Promise.resolve(jsonResponse(200, {
        choices: [{ message: { content: 'paid' } }],
      }));
    }));
    const free = queryModelResult('google/gemma-4-31b-it:free', [
      { role: 'user', content: 'q' },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    const paid = queryModelResult('openai/gpt-4.1', [
      { role: 'user', content: 'q' },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['google/gemma-4-31b-it:free', 'openai/gpt-4.1']);
    releaseFree();
    await free;
    await paid;
  });

  it('keeps 18 free starts inside the minute window', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    const starts = [];
    const messages = [{ role: 'user', content: 'q' }];
    vi.stubGlobal('fetch', vi.fn(async () => {
      starts.push(performance.now());
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }));
    const pending = Promise.all(
      Array.from({ length: 18 }, (_, index) => queryModelResult(`m${index}/x:free`, messages)),
    );
    await vi.advanceTimersByTimeAsync(63000);
    await pending;
    expect(starts).toEqual([
      0, 3000, 6000, 9000, 12000, 15000, 18000, 21000,
      24000, 27000, 30000, 33000, 36000, 39000, 42000, 45000,
      60000, 63000,
    ]);
    assertFreeSchedule(starts);
  });

  it('keeps the gap and the window across a long run, then starts immediately after idle', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    const starts = [];
    const messages = [{ role: 'user', content: 'q' }];
    vi.stubGlobal('fetch', vi.fn(async () => {
      starts.push(performance.now());
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }));
    for (let index = 0; index < 34; index += 1) {
      const pending = queryModelResult(`m${index}/x:free`, messages);
      await vi.advanceTimersByTimeAsync(60000);
      await pending;
    }
    assertFreeSchedule(starts);
    expect(starts.length).toBe(34);
    await vi.advanceTimersByTimeAsync(61000);
    const idleAt = performance.now();
    const idle = queryModelResult('idle/x:free', messages);
    await vi.advanceTimersByTimeAsync(0);
    await idle;
    expect(starts.at(-1)).toBe(idleAt);
    assertFreeSchedule(starts);
  });

  it('re-reads a cooldown that grew while a free retry was waiting', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    const starts = [];
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      starts.push(performance.now());
      if (calls === 1) {
        return jsonResponse(429, {
          error: { message: 'Rate limit exceeded: free-models-per-min' },
        }, { 'Retry-After': '10' });
      }
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }));
    const pending = queryModelResult('a/one:free', [{ role: 'user', content: 'q' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    extendFreeCooldown(25);
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(15000);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(starts).toEqual([0, 25000]);
  });

  it('does not make a paid call wait for a full free window', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    const freeStarts = [];
    const paidStarts = [];
    const messages = [{ role: 'user', content: 'q' }];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const model = JSON.parse(init.body).model;
      if (String(model).endsWith(':free')) freeStarts.push(performance.now());
      else paidStarts.push(performance.now());
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }));
    const filling = Promise.all(
      Array.from({ length: 16 }, (_, index) => queryModelResult(`m${index}/x:free`, messages)),
    );
    await vi.advanceTimersByTimeAsync(45000);
    await filling;
    expect(freeStarts).toHaveLength(16);
    const paidAt = performance.now();
    const paid = queryModelResult('openai/gpt-4.1', messages);
    await vi.advanceTimersByTimeAsync(0);
    await paid;
    expect(paidStarts).toEqual([paidAt]);
    expect(freeStarts).toHaveLength(16);
    const nextFree = queryModelResult('next/x:free', messages);
    await vi.advanceTimersByTimeAsync(14999);
    expect(freeStarts).toHaveLength(16);
    await vi.advanceTimersByTimeAsync(1);
    await nextFree;
    expect(freeStarts.at(-1)).toBe(60000);
  });

  it('does not record a free start cancelled before dispatch', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    const starts = [];
    const messages = [{ role: 'user', content: 'q' }];
    vi.stubGlobal('fetch', vi.fn(async () => {
      starts.push(performance.now());
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }));
    const first = queryModelResult('a/one:free', messages);
    const controller = new AbortController();
    const second = queryModelResult('b/two:free', messages, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0]);
    controller.abort();
    const cancelled = await second;
    expect(cancelled.ok).toBe(false);
    expect(cancelled.error.message).toBe('aborted');
    expect(starts).toEqual([0]);
    await first;
    const third = queryModelResult('c/three:free', messages);
    await vi.advanceTimersByTimeAsync(3000);
    await third;
    expect(starts).toEqual([0, 3000]);
  });

  it('keeps a start that was cancelled after dispatch and still serves the next call', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    const starts = [];
    const messages = [{ role: 'user', content: 'q' }];
    vi.stubGlobal('fetch', vi.fn((_url, init) => {
      starts.push(performance.now());
      if (starts.length === 1) {
        return new Promise((_resolve, reject) => {
          const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (init.signal.aborted) {
            fail();
            return;
          }
          init.signal.addEventListener('abort', fail, { once: true });
        });
      }
      return Promise.resolve(jsonResponse(200, {
        choices: [{ message: { content: 'ok' } }],
      }));
    }));
    const controller = new AbortController();
    const first = queryModelResult('a/one:free', messages, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0]);
    controller.abort();
    const cancelled = await first;
    expect(cancelled.error.message).toBe('aborted');
    expect(starts).toEqual([0]);
    const second = queryModelResult('b/two:free', messages);
    await vi.advanceTimersByTimeAsync(2999);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    const result = await second;
    expect(result.ok).toBe(true);
    expect(starts).toEqual([0, 3000]);
  });

  it('releases the free queue after a transport error', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    const starts = [];
    const messages = [{ role: 'user', content: 'q' }];
    vi.stubGlobal('fetch', vi.fn(async () => {
      starts.push(performance.now());
      if (starts.length === 1) throw new Error('network down');
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }));
    const first = await queryModelResult('a/one:free', messages);
    expect(first.ok).toBe(false);
    expect(first.error.message).toBe('network down');
    const second = queryModelResult('b/two:free', messages);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await second;
    expect(result.ok).toBe(true);
    expect(starts).toEqual([0, 3000]);
  });

  it('holds the next free start after the final free-models-per-min 429', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    const starts = [];
    let calls = 0;
    const messages = [{ role: 'user', content: 'q' }];
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      starts.push(performance.now());
      if (calls <= 5) {
        return jsonResponse(429, {
          error: { message: 'Rate limit exceeded: free-models-per-min' },
        }, { 'Retry-After': '10' });
      }
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    }));
    const failed = queryModelResult('a/one:free', messages);
    await vi.advanceTimersByTimeAsync(40000);
    const result = await failed;
    expect(result.ok).toBe(false);
    expect(starts).toEqual([0, 10000, 20000, 30000, 40000]);
    const next = queryModelResult('b/two:free', messages);
    await vi.advanceTimersByTimeAsync(9999);
    expect(starts).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    const followed = await next;
    expect(followed.ok).toBe(true);
    expect(starts.at(-1)).toBe(50000);
  });
});

describe('catalogue validation', () => {
  afterEach(() => {
    clearModelsCache();
    vi.unstubAllGlobals();
  });

  it('raises when pricing is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: [] })));
    await expect(unknownCatalogueIds(['~openai/gpt-sol-latest'])).rejects.toBeInstanceOf(
      CatalogueUnavailable,
    );
  });

  it('rejects an unknown council id and leaves settings alone', async () => {
    settings.councilModels = ['openai/gpt-real'];
    settings.chairmanModel = 'openai/gpt-real';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      data: [{ id: 'openai/gpt-real', name: 'Real', pricing: {}, description: '' }],
    })));
    await expect(browserEngine.updateSettings({
      council_models: ['openai/missing'],
    })).rejects.toThrow(/Unknown models/);
    expect(settings.councilModels).not.toContain('openai/missing');
  });

  it('accepts a known chairman id', async () => {
    settings.councilModels = ['openai/gpt-real'];
    settings.chairmanModel = 'openai/gpt-real';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      data: [{ id: 'openai/gpt-real', name: 'Real', pricing: {}, description: '' }],
    })));
    const updated = await browserEngine.updateSettings({
      chairman_model: 'openai/gpt-real',
    });
    expect(updated.chairman_model).toBe('openai/gpt-real');
  });

  it('rejects every change when the catalogue is unavailable', async () => {
    const before = [...settings.councilModels];
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: [] })));
    await expect(browserEngine.updateSettings({ n_samples: 2 })).rejects.toThrow(
      /catalogue unavailable/i,
    );
    expect(settings.councilModels).toEqual(before);
    expect(settings.nSamples).toBe(3);
  });
});

describe('getModelsPricing', () => {
  afterEach(() => {
    clearModelsCache();
    vi.unstubAllGlobals();
  });

  it('cools down after an empty catalogue until an explicit refresh', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
      .mockResolvedValueOnce(jsonResponse(200, {
        data: [{ id: 'test/alpha-100b:free', name: 'Alpha', pricing: {}, description: '' }],
      }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getModelsPricing()).toEqual({});
    expect(await getModelsPricing()).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const refreshed = await getModelsPricing({ refresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed['test/alpha-100b:free'].name).toBe('Alpha');
  });

  it('cools down after a catalogue error and lets the next read wait it out', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce(jsonResponse(200, {
          data: [{ id: 'test/alpha-100b:free', name: 'Alpha', pricing: {}, description: '' }],
        }));
      vi.stubGlobal('fetch', fetchMock);
      expect(await getModelsPricing()).toEqual({});
      expect(await getModelsPricing()).toEqual({});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(CATALOGUE_FAILURE_COOLDOWN_MS);
      const later = await getModelsPricing();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(later['test/alpha-100b:free'].name).toBe('Alpha');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a late catalogue response after the cache generation changes', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => gate)
      .mockResolvedValueOnce(jsonResponse(200, {
        data: [{ id: 'test/fresh:free', name: 'Fresh', pricing: {}, description: '' }],
      }));
    vi.stubGlobal('fetch', fetchMock);
    const stale = getModelsPricing();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    clearModelsCache();
    const fresh = await getModelsPricing();
    expect(fresh['test/fresh:free'].name).toBe('Fresh');
    release(jsonResponse(200, {
      data: [{ id: 'test/stale:free', name: 'Stale', pricing: {}, description: '' }],
    }));
    await stale;
    const cached = await getModelsPricing();
    expect(cached['test/fresh:free'].name).toBe('Fresh');
    expect(cached['test/stale:free']).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('credits', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes key limit fields', async () => {
    settings.apiKey = 'sk-test-key-value';
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/credits')) {
        return jsonResponse(200, { data: { total_credits: 10, total_usage: 3 } });
      }
      return jsonResponse(200, {
        data: { limit: 5, limit_remaining: 1.25, limit_reset: 'daily' },
      });
    }));
    const body = await browserEngine.getCredits();
    expect(body.remaining).toBe(7);
    expect(body.limit_remaining).toBe(1.25);
    expect(body.limit_reset).toBe('daily');
  });

  it('keeps credits when the key lookup fails', async () => {
    settings.apiKey = 'sk-test-key-value';
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/credits')) {
        return jsonResponse(200, { data: { total_credits: 4, total_usage: 1 } });
      }
      return new Response('nope', { status: 500 });
    }));
    const body = await browserEngine.getCredits();
    expect(body.remaining).toBe(3);
    expect(body.limit_remaining).toBeUndefined();
  });

  it('does not call credits or key info without a personal key', async () => {
    settings.clearApiKey();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await getCredits()).toBeNull();
    expect(await getKeyInfo()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('sends the personal key on credits and key info', async () => {
    settings.apiKey = 'sk-user-test';
    const fetchMock = vi.fn(async () => jsonResponse(200, { data: { total_credits: 1, total_usage: 0 } }));
    vi.stubGlobal('fetch', fetchMock);
    await getCredits();
    await getKeyInfo();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(usesBearer(call[1], 'sk-user-test')).toBe(true);
      expect(usesBearer(call[1], FREE_TIER_API_KEY)).toBe(false);
    }
  });
});

function usesBearer(init, key) {
  return init?.headers?.Authorization === `Bearer ${key}`;
}

function okCompletion(content = 'ok') {
  return jsonResponse(200, { choices: [{ message: { content } }], usage: {} });
}

describe('completion key routing', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetFreeQueueForTests();
  });

  it.each([
    'vendor/model:free',
    'vendor/model:free-reasoning',
    'vendor/model:free-reasoning-high',
  ])('sends the free key for %s with or without a personal key', async (model) => {
    resetFreeQueueForTests();
    for (const personal of [null, 'sk-user-test']) {
      resetFreeQueueForTests();
      if (personal) settings.apiKey = personal;
      else settings.clearApiKey();
      const fetchMock = vi.fn(async () => okCompletion());
      vi.stubGlobal('fetch', fetchMock);
      const result = await queryModelResult(model, [{ role: 'user', content: 'q' }]);
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0][1];
      expect(usesBearer(init, FREE_TIER_API_KEY)).toBe(true);
      if (personal) expect(usesBearer(init, personal)).toBe(false);
      expect(JSON.parse(init.body).model.endsWith(':free')).toBe(true);
    }
  });

  it('sends only the personal key for a paid id, alias, or :free-extra', async () => {
    settings.apiKey = 'sk-user-test';
    for (const model of ['openai/gpt-4.1', '~openai/gpt-sol-latest', 'vendor/name:free-extra']) {
      const fetchMock = vi.fn(async () => okCompletion());
      vi.stubGlobal('fetch', fetchMock);
      const result = await queryModelResult(model, [{ role: 'user', content: 'q' }]);
      expect(result.ok).toBe(true);
      const init = fetchMock.mock.calls[0][1];
      expect(usesBearer(init, 'sk-user-test')).toBe(true);
      expect(usesBearer(init, FREE_TIER_API_KEY)).toBe(false);
    }
  });

  it('does not post a paid model when the personal key is missing', async () => {
    settings.clearApiKey();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await queryModelResult('openai/gpt-4.1', [{ role: 'user', content: 'q' }]);
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe('No API key configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries a free 429 only with the free key', async () => {
    useFreeClock();
    resetFreeQueueForTests();
    settings.apiKey = 'sk-user-test';
    const bearers = [];
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      calls += 1;
      bearers.push(usesBearer(init, FREE_TIER_API_KEY));
      if (calls === 1) {
        return jsonResponse(429, {
          error: { message: 'Rate limit exceeded: free-models-per-min' },
        });
      }
      return okCompletion();
    }));
    const pending = queryModelResult('a/one:free', [{ role: 'user', content: 'q' }]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60000);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(bearers.length).toBeGreaterThan(1);
    expect(bearers.every(Boolean)).toBe(true);
  });

  it('does not switch a paid failure onto the free key', async () => {
    settings.apiKey = 'sk-user-test';
    const fetchMock = vi.fn(async () => jsonResponse(402, {
      error: { message: 'This request requires more credits' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await queryModelResult('openai/gpt-4.1', [{ role: 'user', content: 'q' }]);
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(usesBearer(fetchMock.mock.calls[0][1], 'sk-user-test')).toBe(true);
    expect(usesBearer(fetchMock.mock.calls[0][1], FREE_TIER_API_KEY)).toBe(false);
  });

  it('does not post when a paid model has no personal key and then fails', async () => {
    settings.clearApiKey();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await queryModelResult('~x-ai/grok-latest', [{ role: 'user', content: 'q' }]);
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const encoder = new TextEncoder();
const userMessage = [{ role: 'user', content: 'q' }];

function sseResponse(text) {
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function hangingFetch() {
  let aborted = false;
  const fetchMock = vi.fn((_url, init) => new Promise((resolve, reject) => {
    const fail = () => {
      aborted = true;
      reject(init.signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    if (init.signal?.aborted) {
      fail();
      return;
    }
    init.signal.addEventListener('abort', fail, { once: true });
  }));
  return {
    fetchMock,
    aborted: () => aborted,
  };
}

function streamResponse(chunks, { contentType = 'text/event-stream', signal, gapMs = 0 } = {}) {
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (signal?.aborted) {
        controller.error(signal.reason || new DOMException('Aborted', 'AbortError'));
        return undefined;
      }
      if (index >= chunks.length) {
        controller.close();
        return undefined;
      }
      const send = () => {
        const piece = chunks[index];
        index += 1;
        if (piece) controller.enqueue(encoder.encode(piece));
      };
      if (gapMs > 0 && index > 0) {
        return new Promise((resolve) => {
          setTimeout(() => {
            send();
            resolve();
          }, gapMs);
        });
      }
      send();
      return undefined;
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType },
  });
}

describe('completion stream contract', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetFreeQueueForTests();
  });

  it('returns when [DONE] arrives and does not wait for the socket to close', async () => {
    settings.apiKey = 'sk-test';
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{"content":"yes"}}]}\n\ndata: [DONE]\n\n',
        ));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    const result = await queryModelResult('openai/gpt-4.1', userMessage);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('yes');
  });

  it('fails when an error frame follows visible text', async () => {
    settings.apiKey = 'sk-test';
    const sse = [
      'data: {"choices":[{"delta":{"content":"partial"}}]}',
      '',
      'data: {"error":{"message":"overloaded","code":503}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(sse)));
    const result = await queryModelResult('openai/gpt-4.1', userMessage);
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('provider');
    expect(result.error.status).toBe(503);
    expect(result.error.detail).toContain('overloaded');
    expect(result.content).toBeUndefined();
  });

  it('fails on EOF before [DONE] even when text arrived', async () => {
    settings.apiKey = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(
      'data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n',
    )));
    const result = await queryModelResult('openai/gpt-4.1', userMessage);
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('protocol');
    expect(result.content).toBeUndefined();
  });

  it('does not dispatch an unfinished [DONE] event at EOF', async () => {
    settings.apiKey = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]',
    )));
    const result = await queryModelResult('openai/gpt-4.1', userMessage);
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('protocol');
  });

  it('reassembles events split across CRLF, CR, and comments', async () => {
    settings.apiKey = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      'data: {"choi',
      'ces":[{"delta":{"content":"A"}}]}\r\n\r\n',
      ': keep-alive\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"B"}}]}\r\r',
      'data: [DONE]\n\n',
    ])));
    const result = await queryModelResult('openai/gpt-4.1', userMessage);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('AB');
  });

  it('rejects a data line that is neither [DONE] nor JSON', async () => {
    settings.apiKey = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('data: not-json\n\n')));
    const result = await queryModelResult('openai/gpt-4.1', userMessage);
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('protocol');
  });

  it('keeps reading after finish_reason stop so the final usage survives', async () => {
    settings.apiKey = 'sk-test';
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(sse)));
    const result = await queryModelResult('openai/gpt-4.1', userMessage);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('Hi');
    expect(result.usage.total_tokens).toBe(2);
  });

  it('accepts finish_reason length when [DONE] follows', async () => {
    settings.apiKey = 'sk-test';
    const sse = [
      'data: {"choices":[{"delta":{"content":"cut"},"finish_reason":"length"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(sse)));
    const result = await queryModelResult('openai/gpt-4.1', userMessage);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('cut');
  });

  it('fails on finish_reason error, content_filter, and tool calls', async () => {
    settings.apiKey = 'sk-test';
    const cases = [
      ['data: {"choices":[{"delta":{"content":"x"},"finish_reason":"error"}]}\n\n', 'provider'],
      ['data: {"choices":[{"delta":{"content":"x"},"finish_reason":"content_filter"}]}\n\n', 'provider'],
      ['data: {"choices":[{"delta":{"tool_calls":[{"id":"1"}]}}]}\n\n', 'protocol'],
    ];
    for (const [sse, kind] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => sseResponse(sse)));
      const result = await queryModelResult('openai/gpt-4.1', userMessage);
      expect(result.ok).toBe(false);
      expect(result.error.kind).toBe(kind);
      expect(result.content).toBeUndefined();
    }
  });

  it('keeps reasoning channels separate and merges detail fragments', async () => {
    settings.apiKey = 'sk-test';
    const separated = [
      'data: {"choices":[{"delta":{"reasoning":"think","reasoning_content":"other"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(separated)));
    const reasoning = await queryModelResult('openai/gpt-4.1', userMessage);
    expect(reasoning.ok).toBe(true);
    expect(reasoning.content).toBe('think');

    const details = [
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","index":0,"text":"hel"}]}}]}',
      '',
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","index":0,"text":"lo"}]}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(details)));
    const merged = await queryModelResult('openai/gpt-4.1', userMessage);
    expect(merged.ok).toBe(true);
    expect(merged.content).toBe('hello');

    const encrypted = [
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.encrypted","id":"1","data":"abc"}]}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(encrypted)));
    const hidden = await queryModelResult('openai/gpt-4.1', userMessage);
    expect(hidden.ok).toBe(false);
    expect(hidden.error.message).toBe('Empty model response');
  });

  it('does not append a message snapshot after deltas', async () => {
    settings.apiKey = 'sk-test';
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      '',
      'data: {"choices":[{"message":{"content":"Hi"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(sse)));
    const result = await queryModelResult('openai/gpt-4.1', userMessage);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('Hi');
  });

  it('uses a message snapshot when the stream never sent a delta', async () => {
    settings.apiKey = 'sk-test';
    const sse = [
      'data: {"choices":[{"message":{"content":"Hi"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(sse)));
    const result = await queryModelResult('openai/gpt-4.1', userMessage);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('Hi');
  });

  it('aborts the header wait and does not start a pre-aborted request', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    const hung = hangingFetch();
    vi.stubGlobal('fetch', hung.fetchMock);
    const pending = queryModelResult('openai/gpt-4.1', userMessage);
    await vi.advanceTimersByTimeAsync((HEADER_WAIT_SECONDS * 1000) - 1000);
    expect(hung.aborted()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('first-response');
    expect(hung.aborted()).toBe(true);

    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const skipped = await queryModelResult('openai/gpt-4.1', userMessage, {
      signal: controller.signal,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(skipped.error.kind).toBe('aborted');
  });

  it('aborts an idle JSON body and accepts one that keeps sending bytes', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    const idle = hangingFetchBody('{');
    vi.stubGlobal('fetch', idle.fetchMock);
    const stalled = queryModelResult('openai/gpt-4.1', userMessage);
    await vi.advanceTimersByTimeAsync((IDLE_WAIT_SECONDS * 1000) - 1000);
    expect(idle.aborted()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const failed = await stalled;
    expect(failed.ok).toBe(false);
    expect(failed.error.kind).toBe('idle');

    vi.stubGlobal('fetch', vi.fn(async (_url, init) => streamResponse(
      ['{"cho', 'ices":[{"message":{"content":"ye', 's"}}]}'],
      { contentType: 'application/json', signal: init.signal, gapMs: 90_000 },
    )));
    const slow = queryModelResult('openai/gpt-4.1', userMessage);
    await vi.advanceTimersByTimeAsync(180_000);
    const parsed = await slow;
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toBe('yes');
  });

  it('stops a live stream at the attempt ceiling', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    let aborted = false;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      let timer;
      const body = new ReadableStream({
        start(controller) {
          const send = () => {
            controller.enqueue(encoder.encode(': ping\n\n'));
            timer = setTimeout(send, 30_000);
          };
          init.signal.addEventListener('abort', () => {
            aborted = true;
            clearTimeout(timer);
            try {
              controller.error(init.signal.reason);
            } catch {
              // The body is already closed.
            }
          }, { once: true });
          send();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }));
    const pending = queryModelResult('openai/gpt-4.1', userMessage);
    await vi.advanceTimersByTimeAsync((STREAM_TOTAL_SECONDS * 1000) - 1000);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('total');
    expect(aborted).toBe(true);
  });

  it('keeps an explicit 30s timeout as the attempt ceiling', async () => {
    useFreeClock();
    settings.apiKey = 'sk-test';
    const hung = hangingFetch();
    vi.stubGlobal('fetch', hung.fetchMock);
    const pending = queryModelResult('openai/gpt-title', userMessage, { timeout: 30 });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(hung.aborted()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('first-response');
    expect(hung.aborted()).toBe(true);
  });

  it('cancels an in-flight read and releases the free queue', async () => {
    useFreeClock();
    const messages = userMessage;
    const starts = [];
    vi.stubGlobal('fetch', vi.fn((_url, init) => {
      starts.push(performance.now());
      if (starts.length === 1) {
        return new Promise((resolve, reject) => {
          const fail = () => reject(init.signal.reason || new DOMException('Aborted', 'AbortError'));
          if (init.signal.aborted) {
            fail();
            return;
          }
          init.signal.addEventListener('abort', fail, { once: true });
        });
      }
      return Promise.resolve(jsonResponse(200, {
        choices: [{ message: { content: 'ok' } }],
      }));
    }));
    const controller = new AbortController();
    const first = queryModelResult('a/one:free', messages, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const cancelled = await first;
    expect(cancelled.error.kind).toBe('aborted');
    const second = queryModelResult('b/two:free', messages);
    await vi.advanceTimersByTimeAsync(FREE_START_GAP_MS);
    const followed = await second;
    expect(followed.ok).toBe(true);
    expect(starts).toHaveLength(2);
  });
});

function hangingFetchBody(firstChunk) {
  let aborted = false;
  const fetchMock = vi.fn(async (_url, init) => {
    const body = new ReadableStream({
      start(controller) {
        if (firstChunk) controller.enqueue(encoder.encode(firstChunk));
        init.signal.addEventListener('abort', () => {
          aborted = true;
          try {
            controller.error(init.signal.reason);
          } catch {
            // The body is already closed.
          }
        }, { once: true });
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return {
    fetchMock,
    aborted: () => aborted,
  };
}
