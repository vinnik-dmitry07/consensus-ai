import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { detectLoop } from '../src/engine/browser/loopGuard.js';
import { arxivMonth, chronologyGroup, orderBlocks } from './a8Blocks.js';
import {
  armCosts,
  bankCounts,
  confirmsCap,
  gitState,
  interleave,
  loopReview,
  pilotForecast,
  pilotItems,
  prepareFor,
  policyFrom,
  probeOutcome,
  probePlan,
  reconcileBudget,
  SOURCE_FILES,
  stageCounters,
  streamTexts,
  testOrder,
} from './a8.js';
import { capsFrom, contextProblems, maxCommonCap, profileDocument, v5Policy } from './a8Profile.js';
import { applyGoldOverrides, interpretV5, lenientRows, renderA8Report, renderV5Report, secondaryFamily } from './a8Report.js';
import { createCampaignBudget } from './budget.js';

// Route limits as the a8-open-v4 snapshot records them.
const ROUTES = [
  { id: 'deepseek/deepseek-v4.1-flash-1017', maxCompletion: 943718, context: 1048576 },
  { id: 'z-ai/glm-5.3-flash', maxCompletion: 131072, context: 1048576 },
  { id: 'tencent/hy4-preview', maxCompletion: 131072, context: 262144 },
  { id: 'stepfun/step-5-preview', maxCompletion: 32768, context: 262144 },
  { id: 'minimax/minimax-m3.1-flash', maxCompletion: 943718, context: 1048576 },
];

function item(id, block, split = 'test') {
  return { id, block, split };
}

function row(id, block, correct, extra = {}) {
  const arms = {};
  for (const [arm, value] of Object.entries(correct)) arms[arm] = { correct: value, status: 'graded', extracted: value ? 'G' : 'W' };
  return { id, block, status: 'complete', arms, ...extra };
}

describe('v5 caps and context', () => {
  it('takes the largest cap every shortlist route can carry', () => {
    expect(maxCommonCap(ROUTES)).toBe(32768);
    expect(contextProblems(ROUTES[3], 32768)).toEqual([]);
    expect(contextProblems(ROUTES[3], 40000).join(' ')).toMatch(/allows 32768/);
    expect(contextProblems({ id: 'x', maxCompletion: null, context: 100000 }, 32768).join(' ')).toMatch(/S8 synthesis needs/);
    expect(() => maxCommonCap([{ id: 'x', maxCompletion: null, context: null }])).toThrow(/No route states/);
  });

  it('keeps the sample cap equal to the Stage 1 cap', () => {
    const caps = capsFrom({ stage1: 32768, stage2: 32768, stage3: 32768 });
    expect(caps).toEqual({ stage1: 32768, sample: 32768, stage2: 32768, stage3: 32768 });
    expect(() => capsFrom({ sample: 1000 })).toThrow(/sample cap/);
  });

  it('passes the client-only options only for a campaign that sets them', () => {
    const route = { id: 'stepfun/step-5-preview', provider: { order: ['f'] }, context: 262144 };
    const caps = capsFrom({ stage1: 32768, stage2: 32768, stage3: 32768 });
    const extended = profileDocument(caps, v5Policy());
    const prepared = prepareFor(policyFrom({ routes: [route] }, extended))(route.id, 'stage2', {});
    expect(prepared.loopGuard).toEqual(extended.loopGuard);
    expect(prepared.evalAnnotations).toBe(true);
    expect(prepared.contextTokens).toBe(262144);
    const legacy = prepareFor(policyFrom({ routes: [route] }, profileDocument()))(route.id, 'stage2', {});
    expect(legacy.loopGuard).toBeUndefined();
    expect(legacy.evalAnnotations).toBeUndefined();
    expect(legacy.contextTokens).toBeUndefined();
    expect(profileDocument().loopGuard).toBeNull();
  });
});

describe('v5 scheduling', () => {
  it('interleaves any blocks, ends on unknown or empty ones, and keeps every item once', () => {
    const items = [
      ...Array.from({ length: 5 }, (_, index) => item(`a${index}`, 'aime')),
      ...Array.from({ length: 2 }, (_, index) => item(`r${index}`, 'rgym')),
      ...Array.from({ length: 3 }, (_, index) => item(`z${index}`, 'mystery')),
    ];
    const order = interleave(items);
    expect(order).toHaveLength(items.length);
    expect(new Set(order.map((entry) => entry.id)).size).toBe(items.length);
    expect(order.slice(0, 3).map((entry) => entry.block)).toEqual(['aime', 'rgym', 'mystery']);
    expect(interleave([])).toEqual([]);
    expect(orderBlocks(['mystery', 'rgym', 'aime'])).toEqual(['aime', 'rgym', 'mystery']);
  });

  it('runs every primary block before the legacy ones, and keeps old campaigns on one interleave', () => {
    const items = [
      ...Array.from({ length: 4 }, (_, index) => item(`a${index}`, 'aime')),
      ...Array.from({ length: 3 }, (_, index) => item(`r${index}`, 'rgym')),
      ...Array.from({ length: 2 }, (_, index) => item(`h${index}`, 'hmmt')),
      ...Array.from({ length: 2 }, (_, index) => item(`g${index}`, 'gpqa')),
    ];
    const order = testOrder(items, ['rgym', 'hmmt']);
    expect(order).toHaveLength(items.length);
    expect(new Set(order.map((entry) => entry.id)).size).toBe(items.length);
    expect(order.slice(0, 5).every((entry) => ['rgym', 'hmmt'].includes(entry.block))).toBe(true);
    expect(order.slice(5).every((entry) => ['aime', 'gpqa'].includes(entry.block))).toBe(true);
    expect(order.slice(0, 5)).toEqual(interleave(items.filter((entry) => ['rgym', 'hmmt'].includes(entry.block))));
    expect(testOrder(items, [])).toEqual(interleave(items));
    expect(testOrder(items, undefined)).toEqual(interleave(items));
  });

  it('picks pilot questions per block in seeded order, before any answer', () => {
    const items = [
      ...Array.from({ length: 8 }, (_, index) => item(`dev:aime:${index}`, 'aime', 'dev')),
      ...Array.from({ length: 4 }, (_, index) => item(`dev:rgym:${index}`, 'rgym', 'dev')),
      item('test:amc:1', 'amc'),
    ];
    const two = pilotItems(items, 2);
    expect(two.map((entry) => entry.block)).toEqual(['aime', 'aime', 'rgym', 'rgym']);
    const four = pilotItems(items, 4);
    expect(four.slice(0, 2)).toEqual(two.slice(0, 2));
    expect(four).toHaveLength(8);
    expect(bankCounts(items).blocks.amc).toEqual({ dev: 0, smoke: 0, test: 1 });
  });

  it('forecasts per block with held reserves at full value and gates on the high case', () => {
    const budget = createCampaignBudget({ maxUsd: 10, maxPosts: 100, prices: { m: { prompt: '0.000001', completion: '0.000001' } } });
    const spend = [['dev:aime:1', 0.3], ['dev:aime:2', 0.5], ['dev:gpqa:1', 0.1]];
    for (const [id, cost] of spend) {
      budget.admit({ attemptId: `${id}|council|stage1|1|m|h#1`, model: 'm', promptTokens: 10, maxTokens: 10 });
      budget.settle({ attemptId: `${id}|council|stage1|1|m|h#1`, usage: { prompt_tokens: 1, completion_tokens: 1, cost } });
    }
    budget.admit({ attemptId: 'dev:aime:2|council|stage2|1|m|h#1', model: 'm', promptTokens: 10, maxTokens: 10 });
    budget.settle({ attemptId: 'dev:aime:2|council|stage2|1|m|h#1', incomplete: true });
    // Ten AIME questions at about $0.5 each do not fit what $6 leaves.
    const campaign = {
      maxUsd: 6,
      maxPosts: 100,
      forecastQuantile: 0.9,
      counts: { blocks: { aime: { test: 10 }, gpqa: { test: 4 }, amc: { test: 2 } } },
    };
    const items = [item('dev:aime:1', 'aime', 'dev'), item('dev:aime:2', 'aime', 'dev'), item('dev:gpqa:1', 'gpqa', 'dev')];
    const forecast = pilotForecast({ campaign, budget, items, order: items.map((entry) => entry.id) });
    const aime = forecast.blocks.find((entry) => entry.block === 'aime');
    expect(aime.meanPosts).toBe(1.5);
    expect(aime.highUsd).toBeGreaterThan(0.5);
    expect(forecast.blocks.find((entry) => entry.block === 'amc').proxy).toBe('dearest choice block');
    expect(forecast.highUsd).toBeGreaterThan(forecast.mainUsd);
    expect(forecast.gate).toBe('fail');
    expect(pilotForecast({ campaign: { ...campaign, maxUsd: 10 }, budget, items, order: items.map((entry) => entry.id) }).gate).toBe('pass');
    // The dev phase posts on the same question ids; those calls are not pilot cost.
    budget.admit({ attemptId: 'dev:aime:1|dev|stage1|1|m|h#1', model: 'm', promptTokens: 10, maxTokens: 10 });
    budget.settle({ attemptId: 'dev:aime:1|dev|stage1|1|m|h#1', usage: { prompt_tokens: 1, completion_tokens: 1, cost: 2 } });
    const again = pilotForecast({ campaign, budget, items, order: items.map((entry) => entry.id) });
    const aimeAgain = again.blocks.find((entry) => entry.block === 'aime');
    expect(aimeAgain.meanPosts).toBe(1.5);
    expect(aimeAgain.meanUsd).toBe(aime.meanUsd);
  });
});

describe('v5 method hash', () => {
  it('hashes every local module a8.js loads, directly or not', () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const seen = new Set();
    const stack = [path.join(root, 'a8.js')];
    while (stack.length) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:import|export)[^;]*?from\s+['"](\.[^'"]+)['"]/g)) {
        stack.push(path.resolve(path.dirname(file), match[1]));
      }
      for (const match of source.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
        stack.push(path.resolve(path.dirname(file), match[1]));
      }
    }
    const closure = [...seen].map((file) => path.relative(root, file).split(path.sep).join('/')).sort();
    expect([...SOURCE_FILES].sort()).toEqual(closure);
  });

  it('reads the commit and the hashed files that differ from it', () => {
    const state = gitState(['a8.js']);
    if (state.head == null) return;
    expect(state.head).toMatch(/^[0-9a-f]{40}$/);
    expect(Array.isArray(state.dirty)).toBe(true);
    // Paths come back whole, from the repository root.
    for (const file of state.dirty) expect(file).toMatch(/^frontend\/eval\/a8\.js$/);
  });
});

describe('v5 loop review', () => {
  const sse = (deltas) => `${deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}`).join('\n\n')}\n\ndata: [DONE]\n`;

  it('rebuilds the reasoning channel and the content of a saved stream', () => {
    const body = sse([{ reasoning: 'Let ', reasoning_details: [{ type: 'reasoning.text', text: 'Let ' }] }, { reasoning: 'x = 1.' }, { content: 'ANSWER: 1' }]);
    expect(streamTexts(body)).toEqual({ channel: 'reasoning', reasoning: 'Let x = 1.', content: 'ANSWER: 1' });
    const details = sse([{ reasoning_details: [{ type: 'reasoning.text', text: 'only details' }] }]);
    expect(streamTexts(details)).toMatchObject({ channel: 'details', reasoning: 'only details' });
    expect(streamTexts('')).toEqual({ channel: null, reasoning: '', content: '' });
  });

  it('lists every loop stop with where it fired and what the slot kept', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'a8-loops-'));
    try {
      const config = { tailChars: 100, historyChars: 400, shingleChars: 10, stride: 2, threshold: 0.8, checkEvery: 50, consecutive: 2 };
      const unique = Array.from({ length: 40 }, (_, index) => `step ${index} gives ${index * 7}. `).join('');
      const looping = `${unique}${'So we check the sum again. '.repeat(40)}`;
      mkdirSync(path.join(dir, 'bodies'), { recursive: true });
      writeFileSync(path.join(dir, 'bodies', '000001.txt'), sse([{ reasoning: looping }]), 'utf8');
      writeFileSync(path.join(dir, 'bodies', '000002.txt'), sse([{ reasoning: unique }]), 'utf8');
      const key = 'dev:aime:1|council|stage2|1|m/one|h';
      const events = [
        { kind: 'http', phase: 'finished', key, attemptId: `${key}#1`, model: 'm/one', cancelReason: 'loop', bodyFile: '000001.txt' },
        { kind: 'http', phase: 'finished', key: 'other', attemptId: 'other#1', model: 'm/one', cancelReason: 'loop', bodyFile: '000002.txt' },
        { kind: 'http', phase: 'finished', key, attemptId: `${key}#2`, model: 'm/one', cancelReason: null },
        { kind: 'slot', key, slot: { state: 'completed', meta: { questionId: 'dev:aime:1', branch: 'council', stage: 'stage2', model: 'm/one' }, result: { ok: true } } },
      ];
      writeFileSync(path.join(dir, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
      const rows = loopReview(dir, config);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        questionId: 'dev:aime:1',
        stage: 'stage2',
        channel: 'reasoning',
        reproduced: true,
        outcome: 'retried and finished',
      });
      expect(rows[0].position).toBe(detectLoop(looping, config).position);
      expect(rows[0].excerpt.endsWith(looping.slice(0, rows[0].position).slice(-50))).toBe(true);
      expect(rows[1]).toMatchObject({ reproduced: false, outcome: 'pending' });
      expect(loopReview(path.join(dir, 'missing'), config)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('v5 probe rounds', () => {
  const preflightDoc = { candidates: ['a/one', 'b/two'], reserves: ['c/three'] };
  const confirmed = { model: 'a/one', http: 200, usageKnown: true, finishReason: 'length', status: 'graded' };
  const transient = { model: 'b/two', http: 502, usageKnown: false, finishReason: null, status: 'no_answer' };

  it('confirms a cap only on a finished stream with usage', () => {
    expect(confirmsCap(confirmed)).toBe(true);
    expect(confirmsCap({ ...confirmed, usageKnown: false })).toBe(false);
    expect(confirmsCap({ ...confirmed, finishReason: 'error' })).toBe(false);
    expect(confirmsCap({ ...confirmed, http: 400 })).toBe(false);
  });

  it('is not done while a route is unconfirmed, and retries only that route as a new attempt', () => {
    const first = probePlan(null, [], preflightDoc);
    expect(first).toMatchObject({ round: 1, attempt: 0, active: ['a/one', 'b/two'], retry: null });
    const rows = [{ ...confirmed, round: 1 }, { ...transient, round: 1 }];
    const outcome = probeOutcome(rows, first.active, true);
    expect(outcome).toMatchObject({ allConfirmed: false, done: false, capConfirmed: { 'a/one': true, 'b/two': false } });
    const second = probePlan({ done: false, round: 1, active: first.active }, rows, preflightDoc);
    expect(second).toMatchObject({ round: 2, attempt: 1, retry: ['b/two'], reserves: ['c/three'] });
    const after = probeOutcome([...rows, { ...transient, http: 200, usageKnown: true, finishReason: 'stop', round: 2 }], second.active, true);
    expect(after).toMatchObject({ allConfirmed: true, done: true });
    // A campaign that does not require confirmation finishes either way.
    expect(probeOutcome(rows, first.active, false).done).toBe(true);
  });
});

describe('v5 accounting', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env.OR_KEY;
  });

  it('splits test spend by method with the shared first answer in both', () => {
    const reservations = {
      'test:q|council|stage1|1|b/one|h#1': { cost: 1 },
      'test:q|council|stage1|1|c/two|h#1': { cost: 2 },
      'test:q|council|stage2|1|c/two|h#1': { cost: 4 },
      'test:q|A8|stage3|1|b/one|h#1': { cost: 8, unresolved: false },
      'test:q|replicates|sample|2|b/one|h#1': { usd: 16, unresolved: true, cost: null },
      'test:q|S8|stage3|1|b/one|h#1': { cost: 32 },
      'dev:q|dev|stage1|1|b/one|h#1': { cost: 64 },
    };
    expect(armCosts(reservations, 'b/one')).toEqual({ test: 63, A8: 15, S8: 49, heldA8: 0, heldS8: 16 });
  });

  it('counts cap hits, loop stops, kept loops, and context refusals per stage', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'a8-count-'));
    dirs.push(dir);
    const meta = (stage, branch = 'council') => ({ questionId: 'q', branch, stage, sample: 1, model: 'm', requestHash: stage });
    const events = [
      { kind: 'slot', key: 'k1', slot: { key: 'k1', meta: meta('stage2'), state: 'completed', result: { ok: true, finishReason: 'length' } } },
      { kind: 'slot', key: 'k2', slot: { key: 'k2', meta: meta('stage2'), state: 'completed', result: { ok: true, loopCut: true, finishReason: 'loop' } } },
      { kind: 'http', phase: 'finished', key: 'k2', cancelReason: 'loop' },
      { kind: 'http', phase: 'finished', key: 'k2', cancelReason: 'loop' },
      { kind: 'slot', key: 'k3', slot: { key: 'k3', meta: meta('stage3', 'A8'), state: 'failed', result: { ok: false, error: { kind: 'context' } } } },
    ];
    const file = path.join(dir, 'events.jsonl');
    writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n'));
    expect(stageCounters(file)).toEqual({
      judges: { calls: 2, cap: 1, loopStops: 2, loopCut: 1, context: 0, failed: 0 },
      'A8 synthesis': { calls: 1, cap: 0, loopStops: 0, loopCut: 0, context: 1, failed: 1 },
    });
  });

  it('settles a held reserve from its generation record and skips what it cannot price', async () => {
    process.env.OR_KEY = 'sk-or-test-not-real';
    const dir = mkdtempSync(path.join(tmpdir(), 'a8-reconcile-'));
    dirs.push(dir);
    const journal = path.join(dir, 'events.jsonl');
    writeFileSync(journal, [
      { kind: 'http', phase: 'finished', attemptId: 'q|a|s|1|m|h#1', generationId: 'gen-1' },
      { kind: 'http', phase: 'finished', attemptId: 'q|a|s|1|m|h#2', generationId: 'gen-2' },
    ].map((event) => JSON.stringify(event)).join('\n'));
    const budget = createCampaignBudget({ maxUsd: 10, maxPosts: 10, prices: { m: { prompt: '0.000001', completion: '0.000001' } } });
    for (const id of ['q|a|s|1|m|h#1', 'q|a|s|1|m|h#2', 'q|a|s|1|m|h#3']) {
      budget.admit({ attemptId: id, model: 'm', promptTokens: 1000, maxTokens: 1000 });
      budget.settle({ attemptId: id, incomplete: true });
    }
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url);
      if (url.includes('gen-1')) return { status: 200, body: { data: { total_cost: 0.0003 } } };
      return { status: 404, body: null };
    };
    const summary = await reconcileBudget({ dir }, budget, { journals: [journal], fetchImpl, log() {} });
    expect(summary).toEqual({ unresolved: 3, lookedUp: 2, settled: 1, withoutId: 1 });
    expect(asked).toHaveLength(2);
    expect(budget.state.settledUsd).toBeCloseTo(0.0003, 12);
    expect(budget.unresolvedAttempts().map((entry) => entry.attemptId)).toEqual(['q|a|s|1|m|h#2', 'q|a|s|1|m|h#3']);
    const again = await reconcileBudget({ dir }, budget, { journals: [journal], fetchImpl, log() {} });
    expect(again.settled).toBe(0);
    expect(budget.state.settledUsd).toBeCloseTo(0.0003, 12);
  });
});

describe('v5 chronology', () => {
  const listings = ['2026-08-26', '2026-10-08', '2026-10-17'];

  it('reads one direction against the chosen models', () => {
    expect(chronologyGroup({ generated: true }, listings)).toBe('A');
    expect(chronologyGroup({ materialDate: '2026-11-05' }, listings)).toBe('A');
    expect(chronologyGroup({ materialDate: '2026-09' }, listings)).toBe('B');
    expect(chronologyGroup({ materialDate: '2026-08' }, listings)).toBe('C');
    expect(chronologyGroup({ materialDate: '2026-02' }, listings)).toBe('C');
    expect(chronologyGroup({ materialDate: null }, listings)).toBe('Unknown');
    expect(chronologyGroup({ materialDate: '2026-11' }, ['2026-08-26', null])).toBe('Unknown');
  });

  it('dates an ArXivMath question by its paper id', () => {
    expect(arxivMonth('2609.04659')).toBe('2026-09');
    expect(arxivMonth('2608.00234v2')).toBe('2026-08');
    expect(arxivMonth('math/0601001')).toBeNull();
    expect(arxivMonth(undefined)).toBeNull();
  });
});

describe('v5 report', () => {
  it('rescores stored answers against a corrected gold without new calls', () => {
    const rows = [{
      id: 'test:amc:1',
      block: 'amc',
      status: 'complete',
      arms: {
        A8: { correct: 0, status: 'graded', extracted: 'C' },
        S8: { correct: 1, status: 'graded', extracted: 'B' },
        B8: { correct: 0, status: 'parse_error', extracted: null },
      },
      diagnostics: { councilAnswers: ['C', 'B', null], leader: { correct: 1, status: 'graded', extracted: 'B' }, oracle: 1 },
    }];
    const { rows: fixed, applied } = applyGoldOverrides(rows, { 'test:amc:1': 'C' });
    expect(applied).toEqual(['test:amc:1']);
    expect(fixed[0].arms.A8.correct).toBe(1);
    expect(fixed[0].arms.S8.correct).toBe(0);
    expect(fixed[0].arms.B8.correct).toBe(0);
    expect(fixed[0].diagnostics.leader.correct).toBe(0);
    expect(fixed[0].diagnostics.rescue).toBe(1);
    expect(rows[0].arms.A8.correct).toBe(0);
  });

  it('never reads p >= 0.05 as equality and gives no claim on a partial test', () => {
    const base = { n: 100, delta: 0.01, p: 0.6, interval: { low: -0.04, high: 0.06, degenerate: false } };
    expect(interpretV5(base, 100, true).join(' ')).toMatch(/not evidence that the two methods are equal/);
    expect(interpretV5(base, 100, true).join(' ')).toMatch(/do not decide the sign/);
    expect(interpretV5({ ...base, delta: -0.08, p: 0.01, interval: { low: -0.12, high: -0.03 } }, 100, true)[0]).toMatch(/S8 is ahead/);
    expect(interpretV5(base, 120, true)[0]).toMatch(/interim/);
  });

  it('builds the primary set, the Holm family, and the chronology table', () => {
    const rows = [
      row('test:rgym:1', 'rgym', { A8: 1, S8: 0, P8: 1, B8: 0 }, { set: 'primary', group: 'A' }),
      row('test:arxiv:1', 'arxiv', { A8: 1, S8: 1, P8: 0, B8: 1 }, { set: 'primary', group: 'B' }),
      row('test:hmmt:1', 'hmmt', { A8: 0, S8: 1, P8: 0, B8: 0 }, { set: 'primary', group: 'C' }),
      row('test:aime:1', 'aime', { A8: 1, S8: 1, P8: 1, B8: 1 }, { set: 'legacy', group: 'C' }),
    ];
    const family = profileDocument(capsFrom({}), v5Policy()).secondaryFamily;
    const results = secondaryFamily(rows, family);
    expect(results.map((entry) => entry.name)).toEqual([
      'A8 - S8, group A',
      'A8 - S8, groups B and C',
      'A8 - S8, legacy blocks',
      'A8 - P8',
      'S8 - P8',
    ]);
    expect(results.map((entry) => entry.n)).toEqual([1, 2, 1, 3, 3]);
    // A family recorded with a single `group` still reads.
    expect(secondaryFamily(rows, [{ name: 'B', left: 'A8', right: 'S8', set: 'primary', group: 'B' }])[0].n).toBe(1);
    expect(results.every((entry) => entry.holmP >= entry.p)).toBe(true);
    const text = renderV5Report({
      rows,
      planned: 4,
      plannedPrimary: 3,
      complete: true,
      primaryBlocks: ['rgym', 'arxiv', 'hmmt'],
      family,
      listings: { 'b/one': '2026-10-08' },
      coverage: { 'arxivmath-0926': { block: 'arxiv', total: 53, eligible: 25, excluded: { unsupported_answer: 28 } } },
      counters: { judges: { calls: 3, cap: 1, loopStops: 1, loopCut: 0, context: 0, failed: 0 } },
      tailApplied: { stage1: 1, samples: 0, stage2: 1 },
      spend: { settledUsd: 1, unresolvedUsd: 0.5, posts: 40, audit: { usage: 1.2 } },
      armCost: { test: 1, A8: 0.6, S8: 0.7, heldA8: 0.1, heldS8: 0 },
      maxUsd: 100,
      maxPosts: 6000,
      caps: capsFrom({ stage1: 32768, stage2: 32768, stage3: 32768 }),
      loopGuard: {},
      tailRule: { chars: 8000 },
    });
    expect(text).toContain('Completed pairs: 3');
    expect(text).toContain('| A8 - S8, legacy blocks | 1 |');
    expect(text).toContain('| A | 1 | reasoning-gym |');
    expect(text).toContain('| arxivmath-0926 | ArXivMath | 53 | 25 | unsupported_answer 28 |');
    expect(text).toContain('Tail rule applied: Stage 1 answers 1, B samples 0, judges 1.');
    expect(text).toContain('one cap of 32768 tokens');
    expect(text).not.toMatch(/equivalent/);
    expect(text).toContain('this is not evidence that the two methods are equal');
  });

  it('adds the lenient reading and the adapted-items sensitivity line as diagnostics', () => {
    const strictMiss = { correct: 0, status: 'no_answer', reason: 'no_answer', extracted: null, text: '**ANSWER: 7**' };
    const rows = [
      {
        ...row('test:rgym:1', 'rgym', { S8: 1, P8: 1, B8: 0 }, { set: 'primary', group: 'A' }),
        arms: {
          A8: strictMiss,
          S8: { correct: 1, status: 'graded', extracted: '7', text: 'ANSWER: 7' },
          P8: { correct: 1, status: 'graded', extracted: '7' },
          B8: { correct: 0, status: 'graded', extracted: '8', text: 'ANSWER: 8' },
        },
      },
      row('test:amc:1', 'amc', { A8: 1, S8: 0, P8: 0, B8: 0 }, { set: 'primary', group: 'A', adapted: true }),
      row('test:arxiv:1', 'arxiv', { A8: 1, S8: 1, P8: 1, B8: 1 }, { set: 'primary', group: 'C' }),
    ];
    const tasks = new Map([['test:rgym:1', { id: 'test:rgym:1', kind: 'number', goldCanon: '7', choiceCount: 0 }]]);
    const lenient = lenientRows(rows, tasks);
    expect(lenient[0].arms.A8).toMatchObject({ correct: 1, lenient: true, text: '**ANSWER: 7**' });
    expect(lenient[0].arms.P8).toBe(rows[0].arms.P8);
    expect(lenient[0].arms.S8.correct).toBe(1);
    expect(lenient[1]).toBe(rows[1]);
    const text = renderV5Report({
      rows,
      lenientRows: lenient,
      lenientRules: 'lenient-v1',
      planned: 3,
      plannedPrimary: 3,
      complete: true,
      primaryBlocks: ['rgym', 'amc', 'arxiv'],
      family: profileDocument(capsFrom({}), v5Policy()).secondaryFamily,
      listings: {},
    });
    expect(text).toContain('Sensitivity: without the 1 AMC questions whose figure was dropped or written out as text, A8 − S8 is -50.0 pp on 2.');
    expect(text).toContain('## Lenient reading (diagnostic)');
    expect(text).toContain('| A8 | 66.7% | 100.0% | 1 |');
    expect(text).toContain('Group A holds only generated puzzles and AMC');
  });

  it('keeps the legacy table for three blocks', () => {
    const rows = [row('a', 'aime', { A8: 1, S8: 0, B8: 0 }), row('g', 'gpqa', { A8: 0, S8: 1, B8: 1 }), row('m', 'mmlu', { A8: 1, S8: 1, B8: 1 })];
    const text = renderA8Report({ rows, planned: 3, complete: true });
    expect(text).toContain('| Arm | Pooled | Macro | AIME | GPQA | MMLU-Pro |');
    expect(text).toContain('mean of the 3 blocks');
  });
});
