import { describe, expect, it } from 'vitest';

import {
  chooseEndpoint,
  intelligenceIndex,
  paidCatalogueReason,
  promptTokenCeiling,
  quoteReservation,
  routePolicy,
  selectFromDev,
  selectPaidShortlist,
  usageCost,
} from './paid.js';

function row(id, score, extra = {}) {
  return {
    id,
    name: id,
    context_length: 131072,
    pricing: { prompt: '0.000002', completion: '0.000008' },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    top_provider: { max_completion_tokens: 16384 },
    supported_parameters: ['max_tokens', 'temperature', 'top_p'],
    hugging_face_id: extra.hugging_face_id || `org/${id}`,
    benchmarks: score == null ? {} : { artificial_analysis: { intelligence_index: score } },
    ...extra,
  };
}

describe('paid shortlist', () => {
  it('drops a free-only id such as Xingchen and does not treat a missing score as zero', () => {
    const models = [
      row('xingchen-agi/xing4.0-29b-a4b:free', 90),
      row('vendor/safety-guard', 80),
      row('openrouter/auto', 99),
      row('alpha/strong', 50),
      row('beta/mid', 40),
      row('gamma/low', 30),
      row('delta/unknown', null, { benchmarks: {} }),
      row('alpha/weaker', 10),
    ];
    expect(paidCatalogueReason(models[0])).toBe('free-only');
    expect(paidCatalogueReason(row('anthropic/claude', 1, { hugging_face_id: '' }))).toBe('open-weight-unverified');
    expect(intelligenceIndex(models[6])).toBeNull();
    const selected = selectPaidShortlist(models, { limit: 3, reserveLimit: 1 });
    expect(selected.candidates.map((item) => item.id)).toEqual([
      'alpha/strong',
      'beta/mid',
      'gamma/low',
    ]);
    expect(selected.reserves.map((item) => item.id)).toEqual(['delta/unknown']);
    expect(selected.candidates.every((item) => item.score > 0)).toBe(true);
  });

  it('keeps server weekly order and one developer', () => {
    const models = [
      row('beta/popular', 1),
      row('beta/later', 99),
      row('alpha/second', 100),
    ];
    expect(selectPaidShortlist(models, { limit: 2, reserveLimit: 0 }).candidates.map((item) => item.id))
      .toEqual(['beta/popular', 'alpha/second']);
  });

  it('does not let two correct answers outrank a full dev denominator', () => {
    const choice = selectFromDev([
      { id: 'a/partial', expected: 24, attempts: 2, correct: 2, successes: 2, latencyMs: 1 },
      { id: 'b/full', expected: 24, attempts: 24, correct: 21, successes: 24, latencyMs: 5 },
      { id: 'c/other', expected: 24, attempts: 24, correct: 10, successes: 24, latencyMs: 5 },
    ]);
    expect(choice.b.id).toBe('b/full');
  });

  it('quotes per-token prices and the long-context tier without treating a missing price as zero', () => {
    const pricing = {
      prompt: '0.000001',
      completion: '0.000002',
      input_cache_write: '0.000003',
      overrides: [{ min_prompt_tokens: 1000, prompt: '0.000004', completion: '0.000005' }],
    };
    const small = quoteReservation({ pricing, promptTokens: 10, maxTokens: 4 });
    expect(small.usd).toBeCloseTo((10 * 0.000003) + (4 * 0.000002));
    expect(small.promptPerMillion).toBeCloseTo(1);
    const large = quoteReservation({ pricing, promptTokens: 1000, maxTokens: 4 });
    expect(large.promptPerToken).toBeCloseTo(0.000004);
    expect(large.completionPerToken).toBeCloseTo(0.000005);
    expect(quoteReservation({ pricing: {}, promptTokens: 10, maxTokens: 4 })).toBeNull();
    expect(usageCost(pricing, { cost: 0.01 })).toBe(0.01);
    expect(usageCost(pricing, { prompt_tokens: 10, completion_tokens: 4 })).toBeCloseTo((10 * 0.000003) + (4 * 0.000002));
    const raisedCompletion = quoteReservation({
      pricing: {
        prompt: '0.000004',
        completion: '0.000002',
        overrides: [{ min_prompt_tokens: 10, prompt: '0.000001', completion: '0.000009' }],
      },
      promptTokens: 10,
      maxTokens: 1,
    });
    expect(raisedCompletion.promptPerToken).toBeCloseTo(0.000004);
    expect(raisedCompletion.completionPerToken).toBeCloseTo(0.000009);
    expect(quoteReservation({
      pricing: { prompt: '0.000001', completion: '0.000001', input_cache_write: 'nope' },
      promptTokens: 1,
      maxTokens: 1,
    })).toBeNull();
  });

  it('keeps one status-0 route and records its exact tag', () => {
    const { endpoint } = chooseEndpoint([
      { tag: 'paid-down', status: -2, context_length: 131072, max_completion_tokens: 8192, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['max_tokens'] },
      { tag: 'zeta', status: 0, context_length: 131072, max_completion_tokens: 8192, pricing: { prompt: '0.000002', completion: '0.000004' }, supported_parameters: ['max_tokens', 'temperature'] },
      { tag: 'alpha', status: 0, context_length: 131072, max_completion_tokens: 8192, pricing: { prompt: '0.000002', completion: '0.000003' }, supported_parameters: ['max_tokens', 'temperature', 'top_p'] },
    ]);
    const preferred = chooseEndpoint([
      { tag: 'vendor/flex', status: 0, context_length: 131072, max_completion_tokens: 8192, pricing: { prompt: '0.000001', completion: '0.000001' }, supported_parameters: ['max_tokens'], quantization: 'unknown' },
      { tag: 'vendor/mxfp4', status: 0, context_length: 131072, max_completion_tokens: 8192, pricing: { prompt: '0.000001', completion: '0.000001' }, supported_parameters: ['max_tokens'], quantization: 'mxfp4' },
      { tag: 'vendor', status: 0, context_length: 131072, max_completion_tokens: 8192, pricing: { prompt: '0.000002', completion: '0.000004' }, supported_parameters: ['max_tokens'] },
    ]);
    expect(preferred.endpoint.tag).toBe('vendor');
    expect(endpoint.tag).toBe('alpha');
    const policy = routePolicy({ id: 'alpha/model', vendor: 'alpha', score: 12 }, endpoint);
    expect(policy.provider.order).toEqual(['alpha']);
    expect(policy.provider.allow_fallbacks).toBe(false);
    expect(policy.provider.max_price.prompt).toBeCloseTo(2);
    expect(policy.temperature).toBe(0.7);
    expect(policy.topP).toBe(1);
    expect(policy.reasoning).toBeNull();
  });

  it('does not prefer a zero-price endpoint over a paid one', () => {
    const choice = chooseEndpoint([
      {
        tag: 'free-endpoint',
        status: 0,
        context_length: 131072,
        max_completion_tokens: 8192,
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: ['max_tokens'],
      },
      {
        tag: 'paid-endpoint',
        status: 0,
        context_length: 131072,
        max_completion_tokens: 8192,
        pricing: { prompt: '0.000002', completion: '0.000004' },
        supported_parameters: ['max_tokens'],
      },
    ]);
    expect(choice.endpoint.tag).toBe('paid-endpoint');
    expect(choice.rejected.some((item) => item.reason === 'zero-price')).toBe(true);
  });

  it('ranks dev by strict accuracy, then completion, then id when cost is incomplete', () => {
    const choice = selectFromDev([
      { id: 'b/one', vendor: 'b', attempts: 4, correct: 2, successes: 4, costComplete: false, costUsd: 0 },
      { id: 'a/one', vendor: 'a', attempts: 4, correct: 2, successes: 3, costComplete: false, costUsd: 9 },
      { id: 'c/one', vendor: 'c', attempts: 4, correct: 1, successes: 4, costComplete: true, costUsd: 1 },
    ]);
    expect(choice.council.map((item) => item.id)).toEqual(['b/one', 'a/one', 'c/one']);
    expect(choice.h.id).toBe(choice.b.id);
  });
});

describe('prompt ceiling', () => {
  it('counts characters plus framing instead of characters divided by four', () => {
    const messages = [{ role: 'user', content: 'abcd' }];
    expect(promptTokenCeiling(messages)).toBe(JSON.stringify(messages).length + 16);
  });
});
