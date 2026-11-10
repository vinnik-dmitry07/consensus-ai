import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { settings } from '../src/engine/browser/settings.js';
import { createCampaignBudget } from './budget.js';
import { STAGE, cellKey, orderCells, prepareProbe, voteOf } from './finishProbe.js';
import {
  criterion1Bounded, criterion4Bounded, decideV3, evaluateBounded, questionMeanAtLeast, shareBounded,
} from './finishProbeCriteria.js';
import {
  ANALYSIS_END, ANALYSIS_START, DEEPSEEK, HY4, PROBE, README_END, README_START, REFUSAL_LIMIT, STAGE1, STEPFUN,
  V3_CAPS, V3BudgetStop, armSources, budgetedFetch, countStates, handRecount, outcomeOf, placeBlock, precisionRank, probeBody,
  probeGenerated, providerOf, routeCandidates, runStage, stage1Status, stageCells, v3Form, v3StateOf,
} from './finishProbeV3.js';
import { createSession } from './runtime.js';
import { installTransport } from './transport.js';

const TASK_IDS = Array.from({ length: 80 }, (_, index) => `test:x:${index}`);
const TASKS = new Map(TASK_IDS.map((id) => [id, { id, kind: 'number', stem: `What is ${id}?`, goldCanon: '5', choiceCount: 0 }]));
const TEXT = `${'long reasoning '.repeat(400)}so the answer looks like 5`;

function source(model, index, role = `council:${model}`, kind = 'input') {
  const questionId = TASK_IDS[index];
  return { id: `${questionId}|${role}`, questionId, kind, role, sample: 11, model, text: TEXT };
}

const outcome = (v3, correct = 0, extra = {}) => ({ v3, correct, accepted: v3 === 'accepted', extracted: v3 === 'accepted' ? (correct ? '5' : '6') : null, ...extra });

// Each item its own question unless told otherwise.
function items(n, questionOf = (index) => `q${index}`) {
  return Array.from({ length: n }, (_, index) => ({ id: `t${index}`, questionId: questionOf(index), model: 'm' }));
}

describe('finish probe v3: criteria with bounds', () => {
  it('passes criterion 4 at N = 115 with 19 against 9', () => {
    const list = items(115);
    const f = (item) => outcome('accepted', Number(item.id.slice(1)) < 19 ? 1 : 0);
    const c = (item) => outcome('accepted', Number(item.id.slice(1)) < 9 ? 1 : 0);
    const row = criterion4Bounded(list, f, c);
    expect(row).toMatchObject({ n: 115, needDifference: 10, fCorrect: 19, cCorrect: 9, differenceLow: 10, differenceHigh: 10, verdict: 'pass' });
  });

  it('needs 10 texts of 107 and 9 of 94', () => {
    const run = (n, diff) => {
      const list = items(n);
      return criterion4Bounded(list, (item) => outcome('accepted', Number(item.id.slice(1)) < diff ? 1 : 0), () => outcome('rejected')).verdict;
    };
    expect(run(107, 9)).toBe('fail');
    expect(run(107, 10)).toBe('pass');
    expect(run(94, 8)).toBe('fail');
    expect(run(94, 9)).toBe('pass');
  });

  it('fails criterion 4 when it holds on texts and not on the mean over questions', () => {
    // 12 wins all in one question of 13 texts; 102 other questions with nothing.
    const list = items(115, (index) => (index < 13 ? 'big' : `q${index}`));
    const f = (item) => outcome('accepted', Number(item.id.slice(1)) < 12 ? 1 : 0);
    const row = criterion4Bounded(list, f, () => outcome('rejected'));
    expect(row.differenceLow).toBe(12);
    expect(row.questionMeanLow).toBeLessThan(2 / 23);
    expect(row.verdict).toBe('fail');
  });

  it('reads the mean over questions exactly', () => {
    const list = items(23);
    expect(questionMeanAtLeast(list, (item) => (item.id === 't0' || item.id === 't1' ? 1 : 0), 2, 23)).toBe(true);
    expect(questionMeanAtLeast(list, (item) => (item.id === 't0' ? 1 : 0), 2, 23)).toBe(false);
    expect(questionMeanAtLeast([], () => 1, 1, 2)).toBe(false);
  });

  it('does not pass an empty label group', () => {
    expect(shareBounded([], () => outcome('accepted', 1), 8, 10).verdict).toBe('fail');
    const criteria = evaluateBounded({ inputs: items(3), outcome: () => outcome('accepted', 1), labels: new Map(), models: ['m'] });
    expect(criteria.c2.verdict).toBe('fail');
    expect(criteria.c3.verdict).toBe('fail');
  });

  it('gives pass, fail, or not evaluable from the bounds of criterion 1', () => {
    const list = items(80);
    const make = (accepted, rejected) => (item) => {
      const at = Number(item.id.slice(1));
      if (at < accepted) return outcome('accepted', 1);
      if (at < accepted + rejected) return outcome('rejected');
      return outcome('unknown');
    };
    expect(criterion1Bounded(list, make(72, 8)).verdict).toBe('pass');
    expect(criterion1Bounded(list, make(71, 9)).verdict).toBe('fail');
    expect(criterion1Bounded(list, make(71, 8)).verdict).toBe('not_evaluable');
    expect(criterion1Bounded(list, make(71, 8))).toMatchObject({ accepted: 71, rejected: 8, unconfirmed: 1 });
  });

  it('follows the decision table', () => {
    const v = (c1, c2, c3, c4) => ({ c1: { verdict: c1 }, c2: { verdict: c2 }, c3: { verdict: c3 }, c4: { verdict: c4 } });
    expect(decideV3(v('fail', 'pass', 'not_evaluable', 'pass')).code).toBe('threshold_not_reached');
    expect(decideV3(v('pass', 'not_evaluable', 'pass', 'pass')).code).toBe('incomplete');
    expect(decideV3(v('pass', 'pass', 'pass', 'fail')).code).toBe('text_benefit_not_shown');
    expect(decideV3(v('pass', 'pass', 'pass', 'not_evaluable')).code).toBe('incomplete');
    expect(decideV3(v('pass', 'pass', 'pass', 'pass'), []).code).toBe('nothing_to_recommend');
    expect(decideV3(v('pass', 'pass', 'pass', 'pass'), ['B8'])).toEqual({ code: 'confirm_on_new_questions', arms: ['B8'] });
  });
});

describe('finish probe v3: cell states', () => {
  const meta = { questionId: 'test:x:0', branch: 'finish-F', stage: STAGE, sample: 11, model: STEPFUN };

  it('tells the five states apart', () => {
    expect(v3StateOf(null).v3).toBe('pending');
    expect(v3StateOf({ meta, state: 'completed', result: { ok: true, content: 'ANSWER: 5' } }).v3).toBe('completed');
    expect(v3StateOf({ meta, state: 'unknown', cutAttempts: 1 })).toEqual({ v3: 'unknown', reason: 'cut_post' });
    expect(v3StateOf({ meta, state: 'skipped', cutAttempts: 1, limitedAttempts: 1 }).v3).toBe('unknown');
    expect(v3StateOf({ meta, state: 'skipped', limitedAttempts: REFUSAL_LIMIT - 1 })).toEqual({ v3: 'pending', reason: 'refused_waiting' });
    expect(v3StateOf({ meta, state: 'skipped', limitedAttempts: REFUSAL_LIMIT })).toEqual({ v3: 'unmeasured', reason: 'refusals_used_up' });
    const gone = { meta, state: 'failed', usage: null, result: { ok: false, error: { status: 404, detail: 'No endpoints found for x.' } }, httpStatus: 404 };
    expect(v3StateOf(gone)).toEqual({ v3: 'unmeasured', reason: 'route_unavailable' });
    expect(v3StateOf({ meta, state: 'failed', httpStatus: null, result: { ok: false, error: { message: 'fetch failed' } } }).v3).toBe('unknown');
    expect(v3StateOf({ meta, state: 'failed', httpStatus: 200, responseSeen: true, usage: { completion_tokens: 40 }, result: { ok: false, error: { message: 'provider error' } } })).toEqual({ v3: 'rejected', reason: 'failed' });
    expect(v3StateOf({ meta, state: 'failed', httpStatus: 400, responseSeen: true, usage: null, result: { ok: false, error: { status: 400 } } })).toEqual({ v3: 'unmeasured', reason: 'refused_before_generation' });
    expect(v3StateOf({ meta, state: 'failed', httpStatus: 200, result: { ok: false, error: { kind: 'total' } } })).toEqual({ v3: 'rejected', reason: 'deadline' });
  });

  it('reads an accepted answer and a cut one', () => {
    const task = TASKS.get('test:x:0');
    expect(outcomeOf(task, { meta, state: 'completed', result: { ok: true, content: 'ANSWER: 5', finishReason: 'stop' } })).toMatchObject({ v3: 'accepted', extracted: '5', correct: 1 });
    const cut = outcomeOf(task, { meta, state: 'completed', result: { ok: true, content: 'thinking', finishReason: 'length' } });
    expect(cut).toMatchObject({ v3: 'rejected', reason: 'cut' });
    expect(v3Form(cut)).toBe('cut at the cap');
  });

  it('stops stage 1 at nine confirmed failures and when a pass cannot be shown', () => {
    const base = { n: 80, accepted: 0, rejected: 0, unknown: 0, unmeasured: 0, pending: 80 };
    expect(stage1Status({ ...base, rejected: 9, pending: 71 }).status).toBe('fail');
    expect(stage1Status({ ...base, rejected: 8, pending: 72 }).status).toBe('running');
    // Unknown POSTs are not failures, but they cannot become accepted either.
    expect(stage1Status({ ...base, rejected: 3, unknown: 6, pending: 71 }).status).toBe('insufficient');
    expect(stage1Status({ ...base, accepted: 60, rejected: 8, unmeasured: 9, pending: 3 }).status).toBe('insufficient');
    expect(stage1Status({ ...base, accepted: 72, rejected: 8, pending: 0 }).status).toBe('pass');
    expect(STAGE1).toEqual({ model: STEPFUN, n: 80, need: 72, stopAt: 9 });
  });
});

describe('finish probe v3: the runner', () => {
  const dirs = [];
  let session = null;
  let restore = () => {};

  beforeEach(() => {
    settings.apiKey = 'sk-user-test';
  });

  afterEach(() => {
    session?.uninstall();
    restore();
    session = null;
    restore = () => {};
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const PRICE = { prompt: '0.000001', completion: '0.000001' };

  function open(dir, respond, { maxUsd = 10 } = {}) {
    const budget = createCampaignBudget({ maxUsd, maxPosts: 500, prices: { [STEPFUN]: PRICE, [DEEPSEEK]: PRICE } });
    const routes = Object.fromEntries([STEPFUN, DEEPSEEK].map((id) => [id, { id, provider: { order: ['host'], allow_fallbacks: false, require_parameters: true }, temperature: 0.7, topP: 1, reasoning: { effort: 'low' } }]));
    session = createSession({ runDir: dir, budget, log() {}, retryLimit: 1, retainRoster: true, retryAfterCooldown: true, maxInFlight: 6, maxInFlightPerModel: 6, prepareOptions: prepareProbe(routes, (model) => V3_CAPS[model]) });
    session.install();
    const posts = [];
    restore = installTransport({
      nativeFetch: async (_url, init) => {
        const body = JSON.parse(init.body || '{}');
        posts.push(body);
        return respond(body, posts.length);
      },
      allowModels: new Set([STEPFUN, DEEPSEEK]),
      allowPaid: true,
      rejectFree: true,
      budget,
      onHttp: session.onHttp,
      onCooldown: session.onCooldown,
    });
    return posts;
  }

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const answer = (content, finish = 'stop', cost = 0.0001) => () => json({ id: 'gen-1', choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost } });
  const tempDir = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finish-v3-'));
    dirs.push(dir);
    return dir;
  };

  it('sends 8192 to StepFun and 2048 to DeepSeek in one batch', async () => {
    const posts = open(tempDir(), answer('ANSWER: 5'));
    const cells = orderCells([source(STEPFUN, 0), source(DEEPSEEK, 1)], 'seed', ['F']);
    expect(await runStage({ cells, tasks: TASKS, session })).toMatchObject({ end: 'done' });
    const caps = Object.fromEntries(posts.map((body) => [body.model, body.max_tokens]));
    expect(caps).toEqual({ [STEPFUN]: 8192, [DEEPSEEK]: 2048 });
  });

  it('stops StepFun after the batch that reaches nine confirmed failures', async () => {
    const posts = open(tempDir(), answer('still working', 'length'));
    const sources = TASK_IDS.map((_, index) => source(STEPFUN, index));
    const cells = stageCells(1, sources, 'seed');
    expect(cells).toHaveLength(80);
    const status = () => {
      const index = new Map(session.slots().map((slot) => [cellKey(slot.meta), slot]));
      return stage1Status(countStates(cells, (id) => {
        const cell = cells.find((entry) => entry.id === id);
        return outcomeOf(TASKS.get(cell.questionId), index.get(cellKey(cell)));
      }));
    };
    const out = await runStage({ cells, tasks: TASKS, session, stop: () => (['fail', 'insufficient'].includes(status().status) ? status().status : null) });
    expect(out.end).toBe('fail');
    expect(posts).toHaveLength(12);
    expect(status()).toMatchObject({ rejected: 12, pending: 68, status: 'fail' });
  });

  it('never sends again a POST without an outcome, and does not count it as a failure', async () => {
    const dir = tempDir();
    const cells = orderCells([source(STEPFUN, 0), source(STEPFUN, 1)], 'seed', ['F']);
    const [cut] = cells;
    const meta = { questionId: cut.questionId, branch: cut.branch, stage: STAGE, sample: cut.sample, model: cut.model, requestHash: 'h' };
    const key = `${cellKey(meta)}|h`;
    mkdirSync(path.join(dir, 'bodies'), { recursive: true });
    const journal = path.join(dir, 'events.jsonl');
    appendFileSync(journal, `${JSON.stringify({ kind: 'slot', key, slot: { key, meta, state: 'running', httpAttempts: 1 } })}\n`);
    appendFileSync(journal, `${JSON.stringify({ kind: 'http', phase: 'reserved', key, model: STEPFUN })}\n`);
    const posts = open(dir, answer('ANSWER: 5'));
    await runStage({ cells, tasks: TASKS, session });
    expect(posts).toHaveLength(1);
    const index = new Map(session.slots().map((slot) => [cellKey(slot.meta), slot]));
    const counts = countStates(cells, (id) => {
      const cell = cells.find((entry) => entry.id === id);
      return outcomeOf(TASKS.get(cell.questionId), index.get(cellKey(cell)));
    });
    expect(counts).toMatchObject({ accepted: 1, unknown: 1, rejected: 0 });
  });

  it('sends no fourth POST after three refusals before generation, also after a restart', async () => {
    const dir = tempDir();
    const refusal = () => json({ error: { message: 'Provider returned error', code: 429, metadata: { raw: 'stepfun is temporarily rate-limited upstream' } } }, 429);
    let posts = open(dir, refusal);
    const cells = orderCells([source(STEPFUN, 0)], 'seed', ['F']);
    const sleep = async () => session.cooldowns.clear();
    const out = await runStage({ cells, tasks: TASKS, session, sleep });
    expect(out.end).toBe('done');
    expect(posts).toHaveLength(REFUSAL_LIMIT);
    const slot = session.slots().find((entry) => cellKey(entry.meta) === cellKey(cells[0]));
    expect(v3StateOf(slot)).toEqual({ v3: 'unmeasured', reason: 'refusals_used_up' });
    session.uninstall();
    restore();
    posts = open(dir, answer('ANSWER: 5'));
    session.cooldowns.clear();
    await runStage({ cells, tasks: TASKS, session, sleep });
    expect(posts).toHaveLength(0);
  });

  it('sends no POST once parallel reserves have used the budget', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    // One reserve fits, two do not; the first call then costs more than is left.
    const posts = open(tempDir(), async (_body, count) => {
      if (count === 1) await gate;
      return answer('ANSWER: 5', 'stop', 0.05)();
    }, { maxUsd: 0.02 });
    const cells = orderCells([source(STEPFUN, 0), source(STEPFUN, 1)], 'seed', ['F']);
    const running = runStage({ cells, tasks: TASKS, session });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const out = await running;
    expect(posts).toHaveLength(1);
    expect(out.end).toBe('budget');
  });
});

describe('finish probe v3: the hy4 route', () => {
  const route = {
    id: HY4, tag: 'cohere', providerName: 'Cohere', temperature: 0.7, topP: 1,
    pricing: { prompt: '0.000000834', completion: '0.000002501' },
    provider: { order: ['cohere'], allow_fallbacks: false, max_price: { prompt: 0.834, completion: 2.501 } },
  };
  const params = ['reasoning', 'max_tokens', 'temperature', 'top_p'];
  const price = { prompt: '0.000000834', completion: '0.000002501' };
  const endpoint = (tag, quantization, extra = {}) => ({ tag, provider_name: tag.split('/')[0], quantization, context_length: 262144, max_completion_tokens: 64000, pricing: price, supported_parameters: params, ...extra });
  const needs = { needPrompt: 140000, cap: 2048 };
  const listed = [
    endpoint('tencent/fp8', 'fp8', { supported_parameters: ['reasoning', 'max_tokens', 'temperature'] }),
    endpoint('deepinfra/fp4', 'fp4'),
    endpoint('novita/fp8', 'fp8'),
    endpoint('gmicloud/bf16', 'bf16'),
    endpoint('pricey/bf16', 'bf16', { pricing: { prompt: '0.000001', completion: '0.000003' } }),
    endpoint('small/bf16', 'bf16', { context_length: 100000 }),
    endpoint('mystery/x', 'unknown'),
    endpoint('atlas-cloud/fp8', 'fp8'),
  ];

  it('orders the fitting hosts by declared precision, then tag, unknown last', () => {
    const found = routeCandidates(listed, route, needs);
    expect(found.pinnedListed).toBe(false);
    expect(found.candidates.map((row) => row.tag)).toEqual(['gmicloud/bf16', 'atlas-cloud/fp8', 'novita/fp8', 'deepinfra/fp4', 'mystery/x']);
    const problems = Object.fromEntries(found.rows.filter((row) => row.problems.length).map((row) => [row.tag, row.problems]));
    expect(problems).toEqual({ 'tencent/fp8': ['parameters: top_p'], 'pricey/bf16': ['price'], 'small/bf16': ['context'] });
    expect(precisionRank('BF16')).toBe(16);
    expect(precisionRank(null)).toBe(-1);
  });

  it('does not depend on the order of the list or on any answer', () => {
    const reversed = routeCandidates([...listed].reverse(), route, needs);
    expect(reversed.candidates.map((row) => row.tag)).toEqual(routeCandidates(listed, route, needs).candidates.map((row) => row.tag));
  });

  it('takes the pinned provider first when it is listed again', () => {
    const found = routeCandidates([...listed, endpoint('cohere', 'unknown')], route, needs);
    expect(found.pinnedListed).toBe(true);
    expect(found.candidates[0]).toMatchObject({ tag: 'cohere', pinnedRoute: true });
    expect(providerOf(route, found.candidates[0])).toEqual(route.provider);
  });

  it('probes with the exact tag, no fallback, and the pinned price ceiling', () => {
    const [first] = routeCandidates(listed, route, needs).candidates;
    const body = probeBody(route, first, { effort: 'none' });
    expect(body.provider).toEqual({ order: ['gmicloud/bf16'], allow_fallbacks: false, max_price: route.provider.max_price, require_parameters: true });
    expect(body).toMatchObject({ model: HY4, max_tokens: PROBE.maxTokens, temperature: 0.7, top_p: 1, reasoning: { effort: 'none' } });
    expect(probeGenerated(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { completion_tokens: 16 } })).toBe(true);
    expect(probeGenerated(404, { error: { message: 'No endpoints found' } })).toBe(false);
    expect(probeGenerated(200, { choices: [] })).toBe(false);
  });
});

describe('finish probe v3: calls outside the session', () => {
  const PRICE = { prompt: '0.000001', completion: '0.000001' };

  it('reserves each POST in the one budget and settles it with the reported cost', async () => {
    const events = [];
    const budget = createCampaignBudget({ maxUsd: 1, maxPosts: 10, prices: { 'a/b': PRICE }, onEvent: (event) => events.push(event) });
    const send = budgetedFetch({ budget, prefix: 'label', stamp: 1, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }], usage: { cost: 0.002 } }), { status: 200 }) });
    const response = await send('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'a/b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }) });
    expect((await response.json()).usage.cost).toBe(0.002);
    expect(budget.state).toMatchObject({ posts: 1 });
    expect(budget.state.settledUsd).toBeCloseTo(0.002, 10);
    expect(events.map((event) => event.kind)).toEqual(['reserve', 'settle']);
    expect(events[0].attemptId).toBe('label|a/b|1|1');
    const refused = budgetedFetch({ budget, prefix: 'route-probe', stamp: 2, fetchImpl: async () => new Response('{"error":{"message":"No endpoints found"}}', { status: 404 }) });
    await refused('u', { method: 'POST', body: JSON.stringify({ model: 'a/b', messages: [], max_tokens: 16 }) });
    expect(budget.state.unresolvedUsd).toBe(0);
    const silent = budgetedFetch({ budget, prefix: 'analysis', stamp: 3, fetchImpl: async () => new Response('oops', { status: 502 }) });
    await silent('u', { method: 'POST', body: JSON.stringify({ model: 'a/b', messages: [], max_tokens: 16 }) });
    expect(budget.state.unresolvedUsd).toBeGreaterThan(0);
  });

  it('refuses a POST the budget cannot hold', async () => {
    const budget = createCampaignBudget({ maxUsd: 0.00001, maxPosts: 10, prices: { 'a/b': PRICE } });
    let sent = 0;
    const send = budgetedFetch({ budget, prefix: 'label', stamp: 1, fetchImpl: async () => { sent += 1; return new Response('{}'); } });
    await expect(send('u', { method: 'POST', body: JSON.stringify({ model: 'a/b', messages: [{ role: 'user', content: 'x'.repeat(100) }], max_tokens: 1000 }) })).rejects.toBeInstanceOf(V3BudgetStop);
    expect(sent).toBe(0);
  });
});

describe('finish probe v3: recount of the arms', () => {
  const B = 'b/one';
  const models = [B, 'c/two', 'd/three'];
  const graded = (value, gold = '5') => ({ status: 'graded', extracted: value, correct: value === gold ? 1 : 0 });
  const none = { status: 'no_answer', extracted: null, correct: 0 };
  const ctx = (extra = {}) => ({ gold: '5', councilModels: models, bModel: B, leaderRole: null, a8Cut: false, s8Cut: false, ...extra });
  // Row r1: B's first answer is cut; the real votes stand. Row r2: every vote
  // is empty but B's, so the shared first answer decides B8, P8, and V5.
  const rows = [
    { id: 'r1', block: 'main', arms: { A8: graded('5'), S8: graded('5'), P8: graded('7'), B8: none }, diagnostics: { councilAnswers: [null, '7', '7'], replicateAnswers: [null, '5', '5', '7', '5'], replicateVote: graded('5'), leader: graded('5') } },
    { id: 'r2', block: 'main', arms: { A8: graded('5'), S8: graded('5'), P8: none, B8: none }, diagnostics: { councilAnswers: [null, null, null], replicateAnswers: [null, null, null, null, null], replicateVote: none, leader: graded('5') } },
  ];
  const ctxMap = new Map(rows.map((row) => [row.id, ctx()]));
  const sources = rows.map((row) => ({ id: `${row.id}|council:${B}`, questionId: row.id, kind: 'input', role: `council:${B}`, model: B }));

  it('fills only cut slots, updates the shared first answer of B everywhere, and loses nothing', () => {
    const outcomes = new Map(sources.map((item) => [`${item.id}|F`, outcome('accepted', 1)]));
    const recount = handRecount({ rows, ctx: ctxMap, sources, outcome: (id) => outcomes.get(id), primaryBlocks: ['main'] });
    const fill = recount.fill.overFallback;
    expect(fill.B8).toMatchObject({ wins: 2, losses: 0 });
    expect(fill.P8).toMatchObject({ wins: 1, losses: 0, unchanged: 1 });
    expect(fill.V5).toMatchObject({ wins: 1, losses: 0, unchanged: 1 });
    for (const arm of ['B8', 'P8', 'V5', 'A8', 'S8']) expect(recount.fill.all[arm].losses).toBe(0);
    expect(recount.winArms).toEqual(['B8', 'P8', 'V5']);
    expect(armSources(rows[0], ctx(), 'fill', new Set(sources.map((item) => item.id)))).toMatchObject({ B8: [sources[0].id], P8: [], V5: [] });
  });

  it('breaks a tie of the real votes by the stored rule, so a filled cell does not move it', () => {
    const tied = voteOf('r3', [null, '5', '7']);
    expect(tied.status).toBe('graded');
    const row = { id: 'r3', block: 'main', arms: { A8: graded('5'), S8: graded('5'), P8: graded(tied.extracted), B8: none }, diagnostics: { councilAnswers: [null, '5', '7'], replicateAnswers: [null, '5', '5', '5', '5'], replicateVote: graded('5'), leader: graded('5') } };
    const item = { id: `r3|council:${B}`, questionId: 'r3', kind: 'input', role: `council:${B}`, model: B };
    const outcomes = new Map([[`${item.id}|F`, outcome('accepted', 0)]]);
    const recount = handRecount({ rows: [row], ctx: new Map([['r3', ctx()]]), sources: [item], outcome: (id) => outcomes.get(id), primaryBlocks: ['main'] });
    expect(recount.fill.all.P8).toMatchObject({ unchanged: 1, wins: 0, losses: 0 });
    expect(recount.fill.all.B8).toMatchObject({ unchanged: 1 });
  });

  it('leaves an arm undetermined while its cell has no outcome', () => {
    const outcomes = new Map([[`${sources[1].id}|F`, outcome('unknown')]]);
    const recount = handRecount({ rows, ctx: ctxMap, sources, outcome: (id) => outcomes.get(id), primaryBlocks: ['main'] });
    expect(recount.fill.all.B8).toMatchObject({ undetermined: 2, wins: 0 });
    expect(recount.fill.all.P8).toMatchObject({ unchanged: 1, undetermined: 1 });
    expect(recount.original.correct.P8).toBe(0);
    expect(recount.winArms).toEqual([]);
  });
});

describe('finish probe v3: README and protocol', () => {
  it('places the block after the v2 analysis and replaces it in place', () => {
    const readme = 'head\n<!-- finish-probe-v2-analysis:end -->\ntail\n';
    const once = placeBlock(readme, README_START, README_END, 'one', '<!-- finish-probe-v2-analysis:end -->');
    expect(once).toBe(`head\n<!-- finish-probe-v2-analysis:end -->\n\n${README_START}\n\none\n\n${README_END}\ntail\n`);
    const twice = placeBlock(once, README_START, README_END, 'two', '<!-- finish-probe-v2-analysis:end -->');
    expect(twice).toContain('two');
    expect(twice).not.toContain('one');
    const analysed = placeBlock(twice, ANALYSIS_START, ANALYSIS_END, 'text', README_END);
    expect(analysed.indexOf(ANALYSIS_START)).toBeGreaterThan(analysed.indexOf(README_END));
  });

  it('has a protocol that states the frozen rules', () => {
    const text = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'finish-probe-v3-protocol.md'), 'utf8');
    for (const part of ['8192', '72 of 80', 'nine', '$10', '500 POSTs', 'allow_fallbacks', 'openai/gpt-6.1-sol', 'google/gemini-4-argon']) expect(text).toContain(part);
  });
});
