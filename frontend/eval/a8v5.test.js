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
  durablePauseCure,
  extendedReplay,
  gitState,
  keyResidual,
  reconcileByKeyResidual,
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
  runStages,
  stageCounters,
  streamTexts,
  testOrder,
  testStages,
} from './a8.js';
import { rgymCheck } from './a8Prepare.js';
import { questionWaits } from './a8Variants.js';
import { sha256 } from './util.js';
import { capsFrom, contextProblems, maxCommonCap, profileDocument, v5Policy } from './a8Profile.js';
import {
  applyGoldOverrides,
  interpretV5,
  lenientRows,
  renderA8Report,
  renderV5Report,
  secondaryFamily,
  transitions,
} from './a8Report.js';
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

  it('sends no legacy question while a primary one is unfinished', async () => {
    const items = [item('p1', 'rgym'), item('p2', 'amc'), item('l1', 'aime'), item('l2', 'gpqa')];
    const order = ['p1', 'l1', 'p2', 'l2'];
    expect(testStages(order, items, ['rgym', 'amc'])).toEqual([['p1', 'p2'], ['l1', 'l2']]);
    expect(testStages(order, items, [])).toEqual([order]);
    const started = [];
    // The primary stage stops on a pause: the legacy stage never starts.
    expect(await runStages(testStages(order, items, ['rgym', 'amc']), async (ids, index) => {
      started.push(index);
      return index === 0 ? 2 : 0;
    })).toBe(2);
    expect(started).toEqual([0]);
    // A finished primary stage lets the legacy stage run; an empty stage is skipped.
    started.length = 0;
    expect(await runStages([['p1'], [], ['l1']], async (ids, index) => {
      started.push(index);
      return 0;
    })).toBe(0);
    expect(started).toEqual([0, 2]);
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

  it('forecasts per block with held reserves at full value and gates on the stress case of the primary set', () => {
    const budget = createCampaignBudget({ maxUsd: 10, maxPosts: 100, prices: { m: { prompt: '0.000001', completion: '0.000001' } } });
    const spend = [['dev:aime:1', 0.3], ['dev:aime:2', 0.5], ['dev:gpqa:1', 0.1]];
    for (const [id, cost] of spend) {
      budget.admit({ attemptId: `${id}|council|stage1|1|m|h#1`, model: 'm', promptTokens: 10, maxTokens: 10 });
      budget.settle({ attemptId: `${id}|council|stage1|1|m|h#1`, usage: { prompt_tokens: 1, completion_tokens: 1, cost } });
    }
    budget.admit({ attemptId: 'dev:aime:2|council|stage2|1|m|h#1', model: 'm', promptTokens: 10, maxTokens: 10 });
    budget.settle({ attemptId: 'dev:aime:2|council|stage2|1|m|h#1', incomplete: true });
    // AIME pilot questions cost $0.3 and $0.5 (plus a tiny held reserve), GPQA $0.1.
    // Here AIME and AMC are the primary set and GPQA the legacy one.
    const campaign = {
      maxUsd: 6,
      maxPosts: 100,
      forecastStressFactor: 1.5,
      primaryBlocks: ['aime', 'amc'],
      counts: { blocks: { aime: { test: 10 }, gpqa: { test: 4 }, amc: { test: 2 } } },
    };
    const items = [item('dev:aime:1', 'aime', 'dev'), item('dev:aime:2', 'aime', 'dev'), item('dev:gpqa:1', 'gpqa', 'dev')];
    const forecast = pilotForecast({ campaign, budget, items, order: items.map((entry) => entry.id) });
    const aime = forecast.blocks.find((entry) => entry.block === 'aime');
    expect(aime.meanPosts).toBe(1.5);
    // Stress is max(1.5 x mean, dearest question): 1.5 x 0.4 beats 0.5.
    expect(aime.stressUsd).toBeCloseTo(1.5 * aime.meanUsd, 6);
    expect(aime.stressPosts).toBe(2.25);
    const gpqa = forecast.blocks.find((entry) => entry.block === 'gpqa');
    expect(gpqa).toMatchObject({ primary: false, stressPosts: 1.5 });
    // AMC has no pilot questions and takes the largest value over all pilot blocks, AIME here, not GPQA.
    const amc = forecast.blocks.find((entry) => entry.block === 'amc');
    expect(amc.proxy).toBe('largest over the pilot blocks');
    expect(amc.stressUsd).toBe(aime.stressUsd);
    expect(forecast.primary.stressUsd).toBeCloseTo(12 * aime.stressUsd, 6);
    expect(forecast.full.stressUsd).toBeCloseTo(forecast.primary.stressUsd + 4 * gpqa.stressUsd, 6);
    expect(forecast.formula).toMatch(/max\(factor x mean, dearest pilot question\)/);
    expect(forecast.gate).toBe('fail');
    // The gate needs only the primary set: here it fits while the whole test does not.
    const roomy = pilotForecast({ campaign: { ...campaign, maxUsd: 8.3 }, budget, items, order: items.map((entry) => entry.id) });
    expect(roomy.primary.fits).toBe(true);
    expect(roomy.full.fits).toBe(false);
    expect(roomy.gate).toBe('pass');
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

describe('v5 reasoning-gym gold checks', () => {
  const row = (sourceId, question = 'What is 2 + 2?') => ({ dataset: 'rgym-aiw', sourceId, question });
  const record = (sourceId, decision, reason = null, question = 'What is 2 + 2?') => [
    `rgym-aiw:${sourceId}`,
    { dataset: 'rgym-aiw', sourceId, decision, reason, questionSha: sha256(question).slice(0, 16) },
  ];

  it('needs a check per row, on the same statement, that agrees with the hashed exclusion list', () => {
    const verify = new Map([
      record('test-ok', 'include'),
      record('test-20261106-3', 'exclude', 'ambiguous'),
      record('test-20261106-4', 'exclude', 'wrong_gold'),
      record('test-unlisted', 'exclude', 'ambiguous'),
    ]);
    expect(rgymCheck(row('test-ok'), verify)).toBeNull();
    expect(rgymCheck(row('test-20261106-3'), verify)).toBe('ambiguous');
    expect(() => rgymCheck(row('test-missing'), verify)).toThrow(/no gold check/);
    expect(() => rgymCheck(row('test-ok', 'What is 2 + 3?'), verify)).toThrow(/changed after its gold check/);
    // The list says ambiguous, the check says wrong_gold: refused.
    expect(() => rgymCheck(row('test-20261106-4'), verify)).toThrow(/exclusion list says ambiguous/);
    // Excluded by the check but missing from the hashed list: refused.
    expect(() => rgymCheck(row('test-unlisted'), verify)).toThrow(/exclusion list says include/);
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

describe('v5 cooldown waits', () => {
  it('waits only on a skip from this run of the question or a route still cooling', () => {
    const slots = [{ meta: { questionId: 'q', model: 'a/one', stage: 'stage2' }, state: 'skipped', skippedAt: 1000 }];
    const session = { slots: () => slots, cooldowns: new Map() };
    // A skip left from an earlier pass whose cooldown ended: the stage asks again.
    expect(questionWaits(session, 'q', 2000, 5000)).toBe(false);
    // Skipped during this run of the question.
    expect(questionWaits(session, 'q', 500, 5000)).toBe(true);
    // The route is still cooling.
    session.cooldowns.set('a/one', 9000);
    expect(questionWaits(session, 'q', 2000, 5000)).toBe(true);
    expect(questionWaits(session, 'other', 0, 5000)).toBe(false);
    slots[0].state = 'completed';
    expect(questionWaits(session, 'q', 0, 5000)).toBe(false);
  });
});

describe('v5 durable pauses', () => {
  const PRICES = { m: { prompt: '0.000001', completion: '0.000001' } };

  it('lifts a durable pause only with evidence, and replays the lift after a restart', () => {
    const events = [];
    const budget = createCampaignBudget({ maxUsd: 10, maxPosts: 10, prices: PRICES, onEvent: (event) => events.push(event) });
    budget.pause('auth');
    expect(budget.resumeDurable({ reason: 'key_budget', evidence: 'x' }).applied).toBe(false);
    expect(budget.state.paused).toBe(true);
    expect(budget.resumeDurable({ reason: 'auth', evidence: 'GET /api/v1/key answered 200' }).applied).toBe(true);
    expect(budget.state.paused).toBe(false);
    expect(events.map((event) => event.kind)).toEqual(['pause', 'resume']);
    // A restart replays both: the pause, then its lift.
    const again = createCampaignBudget({ maxUsd: 10, maxPosts: 10, prices: PRICES });
    again.applyJournal(events);
    expect(again.state.paused).toBe(false);
    // Without the lift the pause survives a restart, as before.
    const stuck = createCampaignBudget({ maxUsd: 10, maxPosts: 10, prices: PRICES });
    stuck.applyJournal(events.slice(0, 1));
    expect(stuck.state).toMatchObject({ paused: true, pauseReason: 'auth' });
    // A fatal stop never lifts.
    stuck.lockFatal('invariant');
    expect(stuck.resumeDurable({ reason: 'auth', evidence: 'x' }).applied).toBe(false);
  });

  it('cures a pause only when OpenRouter shows its cause gone', () => {
    const key = (data, status = 200) => ({ status, body: { data } });
    expect(durablePauseCure('auth', key({ usage: 0 }))).toMatchObject({ cured: true });
    expect(durablePauseCure('auth', key({}, 401)).cured).toBe(false);
    expect(durablePauseCure('key_budget', key({ limit_remaining: 0 })).cured).toBe(false);
    expect(durablePauseCure('key_budget', key({ limit_remaining: 12.5 }))).toMatchObject({ cured: true, evidence: 'key limit remaining 12.50' });
    expect(durablePauseCure('key_budget', key({ limit_remaining: null })).cured).toBe(true);
    const credits = (total, used) => ({ status: 200, body: { data: { total_credits: total, total_usage: used } } });
    expect(durablePauseCure('insufficient_funds', key({}), credits(50, 50)).cured).toBe(false);
    expect(durablePauseCure('insufficient_funds', key({}), credits(60, 50))).toMatchObject({ cured: true, evidence: 'account balance 10.00' });
    expect(durablePauseCure('insufficient_funds', key({}), null).cured).toBe(false);
    expect(durablePauseCure('payment_unknown', key({})).cured).toBe(false);
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
      {
        kind: 'slot',
        key: 'k1',
        slot: {
          key: 'k1', meta: meta('stage2'), state: 'completed', request: { max_tokens: 32768 }, usage: { completion_tokens: 32768 }, result: { ok: true, finishReason: 'length' },
        },
      },
      {
        kind: 'slot',
        key: 'k4',
        slot: {
          key: 'k4', meta: meta('stage2', 'A8'), state: 'completed', request: { max_tokens: 32768 }, usage: { completion_tokens: 16000 }, result: { ok: true, finishReason: 'length' },
        },
      },
      { kind: 'slot', key: 'k2', slot: { key: 'k2', meta: meta('stage2'), state: 'completed', result: { ok: true, loopCut: true, finishReason: 'loop' } } },
      { kind: 'http', phase: 'finished', key: 'k2', cancelReason: 'loop' },
      { kind: 'http', phase: 'finished', key: 'k2', cancelReason: 'loop' },
      { kind: 'http', phase: 'finished', key: 'k1', status: 402, credit: 'in_flight_budget' },
      { kind: 'http', phase: 'finished', key: 'k1', status: 402, credit: 'insufficient_funds' },
      { kind: 'slot', key: 'k3', slot: { key: 'k3', meta: meta('stage3', 'A8'), state: 'failed', result: { ok: false, error: { kind: 'context' } } } },
    ];
    const file = path.join(dir, 'events.jsonl');
    writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n'));
    const zero = { calls: 0, cap: 0, belowCap: 0, loopStops: 0, loopCut: 0, context: 0, failed: 0, creditRetries: 0 };
    expect(stageCounters(file)).toEqual({
      judges: { ...zero, calls: 3, cap: 2, belowCap: 1, loopStops: 2, loopCut: 1, creditRetries: 1 },
      'A8 synthesis': { ...zero, calls: 1, context: 1, failed: 1 },
    });
    // A replay source's loop stop on a slot this run reused counts as well;
    // one on a slot this run does not hold does not.
    const source = path.join(dir, 'source.jsonl');
    writeFileSync(source, [
      { kind: 'http', phase: 'finished', key: 'k4', cancelReason: 'loop' },
      { kind: 'http', phase: 'finished', key: 'elsewhere', cancelReason: 'loop' },
    ].map((event) => JSON.stringify(event)).join('\n'));
    expect(stageCounters(file, [source]).judges.loopStops).toBe(3);
  });

  it('prices held reserves from the key usage across the run, split by reserve', () => {
    const held = [{ attemptId: 'a#1', usd: 0.2 }, { attemptId: 'b#1', usd: 0.6 }];
    const out = keyResidual({ before: 3, after: 4, settledUsd: 0.7, held });
    expect(out.total).toBeCloseTo(0.3, 12);
    expect(out.shares[0].cost).toBeCloseTo(0.075, 12);
    expect(out.shares[1].cost).toBeCloseTo(0.225, 12);
    expect(keyResidual({ before: 3, after: 3.7, settledUsd: 0.7, held }).total).toBe(0);
    expect(() => keyResidual({ before: 3, after: 3.6, settledUsd: 0.7, held })).toThrow('missing from the run');
    expect(() => keyResidual({ before: 3, after: 5, settledUsd: 0.7, held })).toThrow('another client');
  });

  it('settles cut streams and prices every held reserve between the two first audits', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'a8-residual-'));
    dirs.push(dir);
    const runDir = path.join(dir, 'run');
    const nextDir = path.join(dir, 'next');
    mkdirSync(runDir);
    mkdirSync(nextDir);
    const write = (file, events) => writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const own = path.join(runDir, 'budget.jsonl');
    write(own, [
      { kind: 'audit', at: '2026-01-01T00:00:00.000Z', phase: 'probe', usage: 1 },
      { kind: 'reserve', attemptId: 'a#1', model: 'm', usd: 0.5 },
      { kind: 'settle', attemptId: 'a#1', cost: 0.2, unresolved: false },
      { kind: 'reserve', attemptId: 'b#1', model: 'm', usd: 0.4 },
      { kind: 'reserve', attemptId: 'c#1', model: 'm', usd: 0.1 },
      { kind: 'settle', attemptId: 'c#1', cost: null, unresolved: true },
    ]);
    const nextBudget = path.join(nextDir, 'budget.jsonl');
    write(nextBudget, [
      { kind: 'audit', at: '2026-01-01T01:00:00.000Z', phase: 'probe', usage: 1.45 },
      { kind: 'reserve', attemptId: 'x#1', model: 'm', usd: 0.3 },
    ]);
    const open = () => {
      const budget = createCampaignBudget({ maxUsd: 10, maxPosts: 10, prices: {}, onEvent: (event) => writeFileSync(own, `${JSON.stringify(event)}\n`, { flag: 'a' }) });
      budget.applyJournal(readFileSync(own, 'utf8').trim().split('\n').map((line) => JSON.parse(line)));
      return budget;
    };
    const paths = { dir: runDir, budget: own, campaign: path.join(runDir, 'campaign.json') };
    const budget = open();
    const result = await reconcileByKeyResidual(paths, budget, 'next', { log() {}, nextPaths: { budget: nextBudget } });
    expect(result.total).toBeCloseTo(0.25, 12);
    expect(budget.state.unresolvedUsd).toBeCloseTo(0, 12);
    expect(budget.state.settledUsd).toBeCloseTo(0.45, 12);
    // The journal alone gives the same ledger, and a second pass changes nothing.
    const again = open();
    expect(again.state.unresolvedUsd).toBeCloseTo(0, 12);
    expect(again.state.settledUsd).toBeCloseTo(0.45, 12);
    expect((await reconcileByKeyResidual(paths, again, 'next', { log() {}, nextPaths: { budget: nextBudget } })).total).toBe(0);
    const priced = readFileSync(own, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((event) => event.kind === 'resettle');
    expect(priced.map((event) => [event.attemptId, Number(event.cost.toFixed(12))])).toEqual([['b#1', 0.2], ['c#1', 0.05]]);
    expect(priced.every((event) => event.source.startsWith('key-residual:'))).toBe(true);
  });

  it('refuses a key residual when the run posted after the next run started', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'a8-residual-overlap-'));
    dirs.push(dir);
    const own = path.join(dir, 'own.jsonl');
    const nextBudget = path.join(dir, 'next.jsonl');
    writeFileSync(own, [
      { kind: 'audit', at: '2026-01-01T00:00:00.000Z', phase: 'probe', usage: 1 },
      { kind: 'reserve', attemptId: 'b#1', model: 'm', usd: 0.4 },
      { kind: 'audit', at: '2026-01-01T02:00:00.000Z', phase: 'test', usage: 1.3 },
    ].map((event) => JSON.stringify(event)).join('\n'));
    writeFileSync(nextBudget, JSON.stringify({ kind: 'audit', at: '2026-01-01T01:00:00.000Z', phase: 'probe', usage: 1.2 }));
    const budget = createCampaignBudget({ maxUsd: 10, maxPosts: 10, prices: {} });
    budget.applyJournal(readFileSync(own, 'utf8').split('\n').map((line) => JSON.parse(line)));
    await expect(reconcileByKeyResidual({ dir, budget: own, campaign: path.join(dir, 'c.json') }, budget, 'next', {
      log() {},
      nextPaths: { budget: nextBudget },
    })).rejects.toThrow('overlap');
  });

  it('continues a v5 campaign only from a source with the same routes, bank, blocks, caps and budget', () => {
    const profile = profileDocument(capsFrom({ stage1: 32768, stage2: 32768, stage3: 32768 }), v5Policy());
    const expected = {
      profile,
      blocks: ['rgym', 'amc', 'aime', 'gpqa', 'mmlu'],
      routesFrom: 'a8-open-v4',
      maxUsd: 100,
      maxPosts: 6000,
      digest: 'bank',
      extensionDigest: 'ext',
    };
    const source = {
      ...profile,
      routesInheritedFrom: 'a8-open-v4',
      bankDigest: 'bank',
      bankExtension: { digest: 'ext' },
      blocks: expected.blocks,
      maxUsd: 100,
      maxPosts: 6000,
    };
    const deps = (campaign) => ({
      readCampaign: () => campaign,
      readSpend: () => ({ settledUsd: 41.5, unresolvedUsd: 0.25, posts: 2900 }),
      assertSource: () => {},
    });
    const ok = extendedReplay('v5e', ['v5d'], expected, deps(source));
    expect(ok.carriedSpend).toMatchObject({ settledUsd: 41.5, unresolvedUsd: 0.25, posts: 2900 });
    expect(ok.carriedSpend.runs).toEqual([{ run: 'v5d', settledUsd: 41.5, unresolvedUsd: 0.25, posts: 2900 }]);
    for (const [field, value, message] of [
      ['blocks', ['rgym', 'aime', 'gpqa', 'mmlu'], 'blocks'],
      ['maxUsd', 120, 'maxUsd'],
      ['bankDigest', 'other', 'bank'],
      ['routesInheritedFrom', 'a8-open-v3', 'routes'],
      ['stageCaps', { stage1: 16384, stage2: 16384, stage3: 16384 }, 'stageCaps'],
      ['maxAttempts', 3, 'maxAttempts'],
    ]) {
      expect(() => extendedReplay('v5e', ['v5d'], expected, deps({ ...source, [field]: value }))).toThrow(message);
    }
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
    // Every diagnostic moves with the gold: the five-sample vote and the
    // stage-to-stage counts still add up after the correction.
    const voted = [{
      ...rows[0],
      diagnostics: { ...rows[0].diagnostics, replicateVote: { correct: 1, status: 'graded', extracted: 'B' } },
    }];
    const corrected = applyGoldOverrides(voted, { 'test:amc:1': 'C' }).rows;
    expect(corrected[0].diagnostics.replicateVote.correct).toBe(0);
    for (const [baseOf, finalOf] of [
      [(row) => row.diagnostics.leader, (row) => row.arms.A8],
      [(row) => row.diagnostics.replicateVote, (row) => row.arms.S8],
    ]) {
      const step = transitions(corrected, baseOf, finalOf);
      expect(step.final - step.base).toBeCloseTo((step.fixes - step.breaks) / step.n);
    }
    expect(transitions(corrected, (row) => row.diagnostics.leader, (row) => row.arms.A8)).toMatchObject({ fixes: 1, breaks: 0 });
  });

  it('answers direction, size, and equivalence apart, and never reads p >= 0.05 as equality', () => {
    const interval = (low, high) => ({ low, high, degenerate: false });
    const base = { n: 100, wins: 15, losses: 15, delta: 0, p: 1, interval: interval(-0.04, 0.04), interval90: interval(-0.03, 0.03) };
    const reading = interpretV5(base, 100, true).join(' | ');
    expect(reading).toMatch(/direction: not established; this is not evidence that the two methods are equal/);
    expect(reading).toMatch(/A8 ahead by more than 5 percentage points: not supported by the 95% interval/);
    expect(reading).toMatch(/S8 ahead by more than 5 percentage points: not supported by the 95% interval/);
    expect(reading).toMatch(/practical equivalence within ±5 percentage points: supported by the 90% interval \(an approximate bootstrap criterion/);
    // A bound equal to the threshold does not pass it.
    const edge = interpretV5({ ...base, interval: interval(0.05, 0.12), interval90: interval(0.05, 0.1) }, 100, true).join(' | ');
    expect(edge).toMatch(/A8 ahead by more than 5 percentage points: undecided/);
    expect(edge).toMatch(/practical equivalence within ±5 percentage points: not shown/);
    const wide = interpretV5({ ...base, interval90: interval(-0.06, 0.03) }, 100, true).join(' | ');
    expect(wide).toMatch(/practical equivalence within ±5 percentage points: not shown/);
    const s8 = interpretV5({ ...base, delta: -0.08, p: 0.01, interval: interval(-0.12, -0.06) }, 100, true);
    expect(s8[0]).toMatch(/S8 is ahead/);
    expect(s8.join(' | ')).toMatch(/S8 ahead by more than 5 percentage points: supported/);
    const degenerate = interpretV5({ ...base, interval: { low: 0, high: 0, degenerate: true } }, 100, true);
    expect(degenerate).toHaveLength(2);
    expect(degenerate[1]).toMatch(/degenerate/);
    expect(interpretV5({ ...base, wins: 4, losses: 3 }, 100, true).join(' | ')).toMatch(/only 7 discordant pairs/);
    expect(interpretV5(base, 120, true)[0]).toMatch(/interim/);
    expect(interpretV5(base, 100, false)[0]).toMatch(/interim/);
  });

  it('keeps the primary reading final when only the legacy blocks are pending, and shows the mechanisms', () => {
    const diag = (leader, vote, council, b3) => ({
      diagnostics: { leader: { status: 'graded', correct: leader }, replicateVote: { status: 'graded', correct: vote } },
      oracleCouncil: council,
      oracleB3: b3,
    });
    const rows = [
      row('test:rgym:1', 'rgym', { A8: 1, S8: 0, P8: 1, B8: 0 }, { set: 'primary', group: 'A', ...diag(0, 1, 1, 1) }),
      row('test:arxiv:1', 'arxiv', { A8: 1, S8: 1, P8: 0, B8: 1 }, { set: 'primary', group: 'C', ...diag(1, 1, 1, 1) }),
      row('test:hmmt:1', 'hmmt', { A8: 0, S8: 1, P8: 0, B8: 0 }, { set: 'primary', group: 'C', ...diag(1, 0, 1, 0) }),
      { id: 'test:aime:1', block: 'aime', status: 'pending', set: 'legacy', group: 'C' },
    ];
    const input = {
      rows,
      planned: 4,
      plannedPrimary: 3,
      plannedLegacy: 1,
      primaryComplete: true,
      legacyComplete: false,
      moneyFinal: false,
      primaryBlocks: ['rgym', 'arxiv', 'hmmt'],
      family: profileDocument(capsFrom({}), v5Policy()).secondaryFamily,
      listings: {},
      dev: { table: [{ id: 'b/one', correct: 30, expected: 40, successes: 40, accuracy: 0.75 }, { id: 'c/two', correct: 28, expected: 40, successes: 39, accuracy: 0.7 }], blocks: { aime: 8, rgym: 4 } },
    };
    const text = renderV5Report(input);
    expect(text).toContain('Primary set: 3 of 3 pairs, complete. Legacy blocks: 0 of 1, incomplete. Pending questions: 1. Cost: preliminary');
    expect(text).not.toMatch(/Reading: interim/);
    expect(text).toContain('Reading: direction: not established');
    expect(text).toContain('One corrected gold moves this difference by at most 66.7 pp.');
    expect(text).toContain('## Regression check on the legacy blocks (diagnostic)');
    expect(text).toContain('No completed legacy pairs yet.');
    expect(text).toContain('| Stage 2 leader | 66.7% |');
    expect(text).toContain('| Oracle@3, B samples 1 to 3 | 66.7% |');
    // Chairman over the leader: rgym fixed, hmmt broke; 2/3 before, 2/3 after.
    expect(text).toContain('| Chairman over the Stage 2 leader | 3 | 66.7% | 66.7% | 1 | 1 |');
    expect(text).toContain('| Self-MoA synthesis over the vote of five samples | 3 | 66.7% | 66.7% | 1 | 1 |');
    expect(text).toContain('## Without one block at a time (diagnostic)');
    expect(text).toContain('| b/one | 30 / 40 | 40 / 40 | 75.0% |');
    expect(text).toContain('Gap between the first and the second: 5.0 pp.');
    const pending = renderV5Report({ ...input, primaryComplete: false });
    expect(pending).toContain('Reading: interim');
    const step = transitions(rows.slice(0, 3), (entry) => entry.diagnostics.leader, (entry) => entry.arms.A8);
    expect(step.final - step.base).toBeCloseTo((step.fixes - step.breaks) / step.n);
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
      'A8 - P8',
      'S8 - P8',
    ]);
    expect(results.map((entry) => entry.n)).toEqual([1, 2, 3, 3]);
    // A family recorded with a single `group` still reads.
    expect(secondaryFamily(rows, [{ name: 'B', left: 'A8', right: 'S8', set: 'primary', group: 'B' }])[0].n).toBe(1);
    expect(results.every((entry) => entry.holmP >= entry.p)).toBe(true);
    // An empty group stays in the family at p = 1, so the others are corrected for four tests.
    const withoutA = secondaryFamily(rows.filter((entry) => entry.group !== 'A'), family);
    expect(withoutA).toHaveLength(4);
    expect(withoutA[0]).toMatchObject({ n: 0, p: 1, empty: true, holmP: 1 });
    const text = renderV5Report({
      rows,
      planned: 4,
      plannedPrimary: 3,
      plannedLegacy: 1,
      primaryComplete: true,
      legacyComplete: true,
      moneyFinal: true,
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
    expect(text).toContain('Primary set: 3 of 3 pairs, complete. Legacy blocks: 1 of 1, complete. Pending questions: 0. Cost: final.');
    expect(text).not.toContain('| A8 - S8, legacy blocks |');
    expect(text).toMatch(/A8 − S8: 0\.0 pp on 1\. Wins \/ losses \/ ties: 0 \/ 0 \/ 1\./);
    expect(text).toContain('| A | 1 | reasoning-gym |');
    expect(text).toContain('| arxivmath-0926 | ArXivMath | 53 | 25 | unsupported_answer 28 |');
    expect(text).toContain('Tail rule applied: Stage 1 answers 1, B samples 0, judges 1.');
    expect(text).toContain('one cap of 32768 tokens');
    expect(text).toContain('Preparation phases (probe, dev, smoke, pilot, self-test): $0.5000.');
    expect(text).toContain('this is not evidence that the two methods are equal');
    expect(text).toContain('It does not isolate the council, model diversity, the caps, or the loop guard');
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
      primaryComplete: true,
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
