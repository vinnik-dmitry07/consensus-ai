import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoopDetector, detectLoop, LOOP_GUARD_DEFAULTS, loopGuardConfig, repeatShare } from './loopGuard.js';
import { canonicalCompletionRequest, promptTokenEstimate, queryModelResult } from './openrouter.js';
import { settings } from './settings.js';

// Deterministic prose with no repeated 40-character run.
function prose(length, seed = 7) {
  const words = ['alpha', 'basis', 'cyclic', 'divisor', 'edge', 'field', 'graph', 'hull', 'ideal', 'joint',
    'kernel', 'lemma', 'module', 'norm', 'orbit', 'prime', 'quotient', 'ring', 'sum', 'torus'];
  let state = seed;
  const out = [];
  let size = 0;
  while (size < length) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const word = `${words[state % words.length]}${state % 997}`;
    out.push(word);
    size += word.length + 1;
  }
  return out.join(' ').slice(0, length);
}

function looping(length) {
  const paragraph = 'We need the count again. Let me recompute the residues mod 7 and check the pairs once more. ';
  return `${prose(3000)} ${paragraph.repeat(Math.ceil(length / paragraph.length))}`.slice(0, length);
}

function sseResponse(deltas, { usage = null } = {}) {
  const lines = [];
  for (const delta of deltas) {
    lines.push(`data: ${JSON.stringify({ id: 'gen-test', choices: [{ delta }] })}`, '');
  }
  const last = { id: 'gen-test', choices: [{ delta: {}, finish_reason: 'stop' }] };
  if (usage) last.usage = usage;
  lines.push(`data: ${JSON.stringify(last)}`, '', 'data: [DONE]', '');
  return new Response(`${lines.join('\n')}\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function chunks(text, size) {
  const out = [];
  for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size));
  return out;
}

describe('loop detector', () => {
  it('fires on a repeating tail and not on ordinary prose', () => {
    const hit = detectLoop(looping(20000));
    expect(hit).not.toBeNull();
    expect(hit.share).toBeGreaterThanOrEqual(LOOP_GUARD_DEFAULTS.threshold);
    expect(detectLoop(prose(60000))).toBeNull();
  });

  it('does not fire on a derivation that repeats short formulas with changing values', () => {
    let state = 11;
    const steps = [];
    for (let step = 0; step < 600; step += 1) {
      state = (state * 48271) % 2147483647;
      steps.push(`Step ${step}: f(${step}) = ${step * step + 3}, compare with ${state % 100003}. ${prose(40, state)}`);
    }
    expect(detectLoop(steps.join('\n'))).toBeNull();
  });

  it('needs two positive checks in a row', () => {
    const cfg = loopGuardConfig(true);
    const text = looping(20000);
    const first = cfg.tailChars + cfg.checkEvery;
    const hit = detectLoop(text);
    expect(repeatShare(text, hit.position - cfg.checkEvery, cfg)).toBeGreaterThanOrEqual(cfg.threshold);
    expect(hit.position).toBeGreaterThan(first - 1);
    expect(detectLoop(text, { consecutive: 1 }).position).toBeLessThan(hit.position);
  });

  it('gives the same decision however the text arrives', () => {
    const text = looping(30000);
    const whole = detectLoop(text);
    for (const size of [1, 7, 777, 2000, 5003]) {
      const detector = createLoopDetector(true);
      let seen = '';
      let hit = null;
      for (const part of chunks(text, size)) {
        seen += part;
        hit = detector.observe(seen) || hit;
        detector.observe(seen);
      }
      expect(hit).toEqual(whole);
    }
  });

  it('rejects a bad configuration', () => {
    expect(() => loopGuardConfig({ tailChars: 0 })).toThrow(/tailChars/);
    expect(() => loopGuardConfig({ threshold: 2 })).toThrow(/threshold/);
    expect(loopGuardConfig(null)).toBeNull();
  });
});

describe('loop guard in the engine', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const messages = [{ role: 'user', content: 'q' }];

  it('stops a looping stream and retries it once', async () => {
    settings.apiKey = 'sk-test';
    const loop = chunks(looping(24000), 400).map((reasoning) => ({ reasoning }));
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => sseResponse(loop))
      .mockImplementationOnce(async () => sseResponse([{ reasoning: prose(3000) }, { content: 'ANSWER: 4' }], {
        usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await queryModelResult('openai/gpt-4.1', messages, {
      loopGuard: true,
      evalAnnotations: true,
      maxRetries: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('ANSWER: 4');
    expect(result.loopCut).toBeUndefined();
    expect(result.contentFromReasoning).toBeUndefined();
    expect(result.providerFinishReason).toBe('stop');
  });

  it('keeps the text of the last attempt when it loops too', async () => {
    settings.apiKey = 'sk-test';
    const loop = chunks(looping(24000), 400).map((reasoning) => ({ reasoning }));
    const fetchMock = vi.fn(async () => sseResponse(loop));
    vi.stubGlobal('fetch', fetchMock);
    const result = await queryModelResult('openai/gpt-4.1', messages, {
      loopGuard: true,
      evalAnnotations: true,
      maxRetries: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.loopCut).toBe(true);
    expect(result.finishReason).toBe('loop');
    expect(result.contentFromReasoning).toBe(true);
    expect(result.loop.channel).toBe('reasoning');
    expect(result.content.length).toBeLessThan(24000);
    expect(result.content.length).toBeGreaterThanOrEqual(result.loop.position);
  });

  it('reads one reasoning channel when the provider sends the text twice', async () => {
    settings.apiKey = 'sk-test';
    const text = prose(16000);
    const deltas = chunks(text, 500).map((part) => ({
      reasoning: part,
      reasoning_details: [{ type: 'reasoning.text', index: 0, text: part }],
    }));
    deltas.push({ content: 'ANSWER: 1' });
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(deltas)));
    const result = await queryModelResult('openai/gpt-4.1', messages, { loopGuard: true, maxRetries: 2 });
    expect(result.ok).toBe(true);
    expect(result.content).toBe('ANSWER: 1');
    expect(result.loopCut).toBeUndefined();
  });

  it('leaves the product path unchanged without the option', async () => {
    settings.apiKey = 'sk-test';
    const text = looping(24000);
    const loop = chunks(text, 400).map((reasoning) => ({ reasoning }));
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(loop)));
    const result = await queryModelResult('openai/gpt-4.1', messages);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(text);
    expect(result.loopCut).toBeUndefined();
    expect(result.contentFromReasoning).toBeUndefined();
    expect(result.providerFinishReason).toBeUndefined();
  });

  it('marks content that fell back to reasoning when annotations are on', async () => {
    settings.apiKey = 'sk-test';
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([{ reasoning: 'only thinking' }])));
    const result = await queryModelResult('openai/gpt-4.1', messages, { evalAnnotations: true });
    expect(result.content).toBe('only thinking');
    expect(result.contentFromReasoning).toBe(true);
  });

  it('refuses a prompt that cannot fit the route context before any POST', async () => {
    settings.apiKey = 'sk-test';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const big = [{ role: 'user', content: 'x'.repeat(40000) }];
    const result = await queryModelResult('openai/gpt-4.1', big, { maxTokens: 8192, contextTokens: 20000 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('context');
    expect(promptTokenEstimate(big)).toBe(20000 + 64 + 1024);
  });

  it('keeps client-only options out of the request body', () => {
    const plain = canonicalCompletionRequest('openai/gpt-4.1', messages, { maxTokens: 32768 });
    const guarded = canonicalCompletionRequest('openai/gpt-4.1', messages, {
      maxTokens: 32768,
      loopGuard: true,
      evalAnnotations: true,
      contextTokens: 262144,
      timeout: 4216,
    });
    expect(guarded).toEqual(plain);
  });
});
