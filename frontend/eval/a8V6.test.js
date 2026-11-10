import { describe, expect, it } from 'vitest';

import { gateVerdict, legacyDevComparison } from './a8Gate.js';
import { needsFor, repinPlan, repinnedRoute } from './a8Repin.js';

const HY4 = 'tencent/hy4-preview';
const route = (id, tag, extra = {}) => ({
  id, tag, providerName: tag, context: 262144, maxCompletion: 131072,
  pricing: { prompt: '0.000001', completion: '0.000003' },
  provider: { order: [tag], allow_fallbacks: false, max_price: { prompt: 1, completion: 3 } },
  ...extra,
});
const snapshot = {
  candidates: ['a/one', HY4, 's/step'],
  routes: [route('a/one', 'ionstream'), route(HY4, 'cohere'), route('s/step', 'featherless/fp4', { maxCompletion: 32768 })],
};
const endpoint = (tag, extra = {}) => ({
  tag, provider_name: tag, quantization: 'fp8', context_length: 262144, max_completion_tokens: 100000,
  pricing: { prompt: '0.000001', completion: '0.000003' },
  supported_parameters: ['max_tokens', 'temperature', 'top_p', 'reasoning'],
  ...extra,
});
const listings = (hy4) => ({
  'a/one': { status: 200, endpoints: [endpoint('ionstream')] },
  [HY4]: { status: 200, endpoints: hy4 },
  's/step': { status: 200, endpoints: [endpoint('featherless/fp4')] },
});

describe('a8 repin', () => {
  it('needs the S8 prompt and the cap in context', () => {
    expect(needsFor(32768)).toEqual({ needPrompt: 5 * 32768 + 8000, cap: 32768 });
  });

  it('picks the fitting host of larger precision, then tag, and pins it without fallback', () => {
    const plan = repinPlan({
      snapshot,
      listings: listings([
        endpoint('novita/fp8'),
        endpoint('gmicloud/bf16', { quantization: 'bf16' }),
        endpoint('tencent/fp8', { supported_parameters: ['max_tokens', 'temperature'] }),
        endpoint('small/fp16', { quantization: 'fp16', context_length: 131072 }),
        endpoint('dear/bf16', { quantization: 'bf16', pricing: { prompt: '0.000002', completion: '0.000003' } }),
      ]),
    });
    expect(plan.problems).toEqual([]);
    expect(plan.cap).toBe(32768);
    expect(plan.chosen.tag).toBe('gmicloud/bf16');
    expect(plan.checks[HY4].candidates).toEqual(['gmicloud/bf16', 'novita/fp8']);
    const hy4 = plan.routes.find((row) => row.id === HY4);
    expect(hy4.provider).toEqual({ order: ['gmicloud/bf16'], allow_fallbacks: false, max_price: { prompt: 1, completion: 3 } });
    expect(hy4.pricing).toEqual(snapshot.routes[1].pricing);
    expect(plan.routes.find((row) => row.id === 'a/one')).toBe(snapshot.routes[0]);
  });

  it('keeps the pinned host when it is listed again', () => {
    const plan = repinPlan({ snapshot, listings: listings([endpoint('gmicloud/bf16', { quantization: 'bf16' }), endpoint('cohere')]) });
    expect(plan.chosen).toMatchObject({ tag: 'cohere', pinnedRoute: true });
    expect(plan.routes).toBe(snapshot.routes);
  });

  it('stops when another candidate lost its pinned host or nothing fits', () => {
    const lost = listings([endpoint('gmicloud/bf16')]);
    lost['a/one'] = { status: 200, endpoints: [endpoint('other')] };
    expect(repinPlan({ snapshot, listings: lost }).problems).toEqual(['a/one: the pinned endpoint ionstream is not listed']);
    expect(repinPlan({ snapshot, listings: listings([endpoint('tiny', { context_length: 100000 })]) }).problems).toEqual([`${HY4}: no endpoint fits the rule`]);
  });

  it('copies the endpoint limits into the route', () => {
    const out = repinnedRoute(snapshot.routes[1], endpoint('gmicloud/bf16', { quantization: 'bf16', context_length: 262144, max_completion_tokens: 235929 }));
    expect(out).toMatchObject({ tag: 'gmicloud/bf16', quantization: 'bf16', context: 262144, maxCompletion: 235929, supports: { temperature: true, top_p: true, reasoning: true, max_tokens: true } });
  });
});

describe('a8 gate', () => {
  const selection = { council: ['m1', 'm2', 'm3'] };
  const dev = (id, statuses) => ({ id, block: 'arxiv', status: 'complete', answers: statuses.map((status, index) => ({ id: `m${index + 1}`, status, correct: 0 })) });
  const pilot = (id, a8, s8) => ({ id, block: 'arxiv', status: 'complete', arms: { A8: { status: a8 }, S8: { status: s8 } } });
  const forecast = { gate: 'pass', primary: { baseUsd: 40, stressUsd: 60 }, remainingUsd: 80 };
  const key = { status: 200, limitRemaining: 45 };

  it('passes with two parsed dev answers, a passed money gate, and enough key', () => {
    const out = gateVerdict({ selection, devRows: [dev('d1', ['graded', 'parse_error', 'parse_error']), dev('d2', ['graded', 'parse_error', 'parse_error'])], pilotRows: [], forecast, key });
    expect(out.verdict).toBe('pass');
    expect(out.conditions.measurable).toMatchObject({ devAnswers: 6, devParsed: 2 });
    expect(out.conditions.key).toMatchObject({ addForBaseUsd: 0, addForStressUsd: 15 });
  });

  it('accepts one parsed pilot synthesis instead of the dev answers', () => {
    const out = gateVerdict({ selection, devRows: [dev('d1', ['parse_error', 'parse_error', 'parse_error'])], pilotRows: [pilot('p1', 'parse_error', 'graded')], forecast, key });
    expect(out.conditions.measurable.holds).toBe(true);
  });

  it('stops when the block is not measurable, the money gate failed, or the key is short', () => {
    const none = dev('d1', ['parse_error', 'parse_error', 'graded']);
    none.answers.push({ id: 'outside', status: 'graded' });
    const out = gateVerdict({ selection, devRows: [none], pilotRows: [pilot('p1', 'parse_error', 'parse_error')], forecast: { ...forecast, gate: 'fail' }, key: { status: 200, limitRemaining: 30 } });
    expect(out.verdict).toBe('stop');
    expect(out.failed).toEqual(['money', 'measurable', 'key']);
    expect(out.conditions.key.addForBaseUsd).toBe(10);
  });

  it('compares the legacy dev answers both runs share', () => {
    const row = (id, block, correct) => ({ id, block, status: 'complete', answers: [{ id: 'm1', correct }] });
    const out = legacyDevComparison([row('a', 'aime', 1), row('b', 'gpqa', 0), row('c', 'arxiv', 1)], [row('a', 'aime', 0), row('b', 'gpqa', 0)]);
    expect(out).toEqual({ questions: 2, models: [{ id: 'm1', now: 1, before: 0 }] });
  });
});
