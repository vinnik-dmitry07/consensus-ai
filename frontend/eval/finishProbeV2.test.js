import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { settings } from '../src/engine/browser/settings.js';
import { createCampaignBudget } from './budget.js';
import {
  STAGE, cellKey, evaluateCriteria, orderCells, prepareProbe, runCells,
} from './finishProbe.js';
import {
  EXCERPT_NOTE, FULL_NOTE, LABEL_EFFORT, LABEL_MAX_TOKENS, LABEL_TRIES, LabelBudgetStop,
  budgetTotals, createLabelGuard, journalledPost, labelMessages, labelOne, labelSpend, mergedSlots, openRouterPost,
  origins, parseLabel, remainingCells, renderReadmeBlock, runLabelPass, settleFailed, stageIndex, v2Limits,
} from './finishProbeV2.js';
import { createSession, readSlotJournal } from './runtime.js';
import { installTransport } from './transport.js';

const MODEL = 'alpha/one';
const TASK = { id: 'test:x:1', kind: 'number', stem: 'What is 3/4 + 0?', goldCanon: '3/4', choiceCount: 0 };
const TEXT = `${'long reasoning '.repeat(2000)}so the answer looks like 3/4`;
const SOURCE = { id: `${TASK.id}|council:${MODEL}`, questionId: TASK.id, kind: 'input', sample: 11, model: MODEL, text: TEXT };
const TASKS = new Map([[TASK.id, TASK]]);

function slotFor(cell, state, extra = {}) {
  const meta = { questionId: cell.questionId, branch: cell.branch, stage: STAGE, sample: cell.sample, model: cell.model, requestHash: 'h' };
  return { key: `${cellKey(meta)}|h`, meta, state, result: state === 'completed' ? { ok: true, content: 'ANSWER: 3/4', finishReason: 'stop' } : null, ...extra };
}

function writeJournal(dir, slots) {
  mkdirSync(path.join(dir, 'bodies'), { recursive: true });
  for (const slot of slots) appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ kind: 'slot', key: slot.key, slot })}\n`);
}

describe('finish probe v2: carrying v1 over', () => {
  const cells = orderCells([SOURCE], 'seed', ['F', 'T', 'C']);
  const [first, second, third] = cells;

  it('sends again everything v1 did not finish, and nothing it did', () => {
    const v1 = stageIndex([
      slotFor(first, 'completed'),
      slotFor(second, 'running', { cutAttempts: 1, httpAttempts: 1 }),
      slotFor(third, 'fatal', { fatal: 'already settled' }),
    ]);
    expect(remainingCells(cells, v1).map((cell) => cell.id)).toEqual([second.id, third.id]);
    expect(remainingCells(cells, new Map()).length).toBe(3);
  });

  it('takes v1 for finished cells and v2 for the rest, and refuses an overlap', () => {
    const v1 = stageIndex([slotFor(first, 'completed'), slotFor(second, 'running', { cutAttempts: 1 })]);
    const v2 = stageIndex([slotFor(second, 'completed', { tag: 'v2' })]);
    const merged = mergedSlots(cells, v1, v2);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(v1.get(cellKey(first)));
    expect(merged[1].tag).toBe('v2');
    expect(origins(cells, v1, v2)).toEqual({ cells: 3, v1Done: 1, v2: { done: 1, pending: 1 }, resent: [{ cell: second.id, v2: 'done' }] });
    expect(() => mergedSlots(cells, v1, stageIndex([slotFor(first, 'completed')]))).toThrow(/v1 had finished/);
  });

  it('keeps the approved limits across v1 and v2', () => {
    expect(v2Limits({ settledUsd: 1.8342, heldUsd: 0.1357, posts: 151 })).toEqual({ maxUsd: 8.0301, maxPosts: 349 });
    expect(() => v2Limits({ settledUsd: 9.5, heldUsd: 0.5, posts: 10 })).toThrow(/used up/);
    expect(() => v2Limits({ settledUsd: 1, heldUsd: 0, posts: 500 })).toThrow(/used up/);
  });

  it('reads settled money, held money, and POSTs from a budget journal', () => {
    const events = [];
    const budget = createCampaignBudget({ maxUsd: 10, maxPosts: 10, prices: { [MODEL]: { prompt: '0.000001', completion: '0.000002' } }, onEvent: (event) => events.push(event) });
    budget.admit({ attemptId: 'a', model: MODEL, promptTokens: 100, maxTokens: 100 });
    budget.settle({ attemptId: 'a', usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0002 } });
    budget.admit({ attemptId: 'b', model: MODEL, promptTokens: 100, maxTokens: 100 });
    const totals = budgetTotals(events);
    expect(totals.posts).toBe(2);
    expect(totals.settledUsd).toBeCloseTo(budget.state.settledUsd, 10);
    expect(totals.heldUsd).toBeCloseTo(budget.state.unresolvedUsd, 10);
    expect(totals.heldUsd).toBeGreaterThan(0);
  });

  it('counts a call that ended in an error as no answer, not as incomplete', () => {
    const inputs = [{ ...SOURCE, id: 's1' }];
    const raw = new Map([['s1|F', { state: 'failed', accepted: false, correct: 0, extracted: null, reason: 'failed' }], ['s1|C', { state: 'done', accepted: false, correct: 0, reason: 'cut' }]]);
    const before = evaluateCriteria({ inputs, outcome: (id) => raw.get(id), labels: new Map(), models: [MODEL] });
    const settled = settleFailed(raw);
    const after = evaluateCriteria({ inputs, outcome: (id) => settled.get(id), labels: new Map(), models: [MODEL] });
    expect(before.c1.models[MODEL].verdict).toBe('undetermined');
    expect(after.c1.models[MODEL]).toMatchObject({ accepted: 0, incomplete: 0, verdict: 'fail' });
    expect(settled.get('s1|F')).toMatchObject({ state: 'done', accepted: false, reason: 'failed' });
    expect(settled.get('s1|C')).toBe(raw.get('s1|C'));
  });
});

describe('finish probe v2: calls', () => {
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

  function open(dir, respond) {
    const budget = createCampaignBudget({ maxUsd: 10, maxPosts: 100, prices: { [MODEL]: { prompt: '0.000001', completion: '0.000001' } } });
    const routes = { [MODEL]: { id: MODEL, provider: { order: ['host'], allow_fallbacks: false, require_parameters: true }, temperature: 0.7, topP: 1, reasoning: { effort: 'low' } } };
    session = createSession({ runDir: dir, budget, log() {}, retryLimit: 1, retainRoster: true, retryAfterCooldown: true, maxInFlight: 3, maxInFlightPerModel: 3, prepareOptions: prepareProbe(routes, () => 2048) });
    session.install();
    const posts = [];
    restore = installTransport({
      nativeFetch: async (_url, init) => {
        posts.push(JSON.parse(init.body || '{}'));
        return respond();
      },
      allowModels: new Set([MODEL]),
      allowPaid: true,
      rejectFree: true,
      budget,
      onHttp: session.onHttp,
      onCooldown: session.onCooldown,
    });
    return posts;
  }

  const reply = () => new Response(JSON.stringify({
    id: 'gen-1',
    choices: [{ message: { content: 'ANSWER: 3/4' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('sends only what v1 left, in a journal of its own, and never twice', async () => {
    const v1Dir = mkdtempSync(path.join(tmpdir(), 'finish-v1-'));
    const v2Dir = mkdtempSync(path.join(tmpdir(), 'finish-v2-'));
    dirs.push(v1Dir, v2Dir);
    const cells = orderCells([SOURCE], 'seed', ['F', 'C']);
    writeJournal(v1Dir, [slotFor(cells[0], 'completed'), slotFor(cells[1], 'running', { cutAttempts: 1, httpAttempts: 1 })]);
    const v1 = stageIndex([...readSlotJournal(path.join(v1Dir, 'events.jsonl')).values()]);
    const remaining = remainingCells(cells, v1);
    expect(remaining.map((cell) => cell.id)).toEqual([cells[1].id]);
    let posts = open(v2Dir, reply);
    expect(await runCells({ cells: remaining, tasks: TASKS, session })).toEqual({ done: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0].messages[0].content).toContain(cells[1].condition === 'C' ? 'Give your best answer now' : 'Unfinished reasoning:');
    session.uninstall();
    restore();
    posts = open(v2Dir, reply);
    await runCells({ cells: remaining, tasks: TASKS, session });
    expect(posts).toHaveLength(0);
    const v2 = stageIndex(session.slots());
    expect(mergedSlots(cells, v1, v2).map((slot) => slot.state)).toEqual(['completed', 'completed']);
  });
});

describe('finish probe v2: labels', () => {
  it('builds the request without the gold, and with the full text only on request', () => {
    const excerpt = labelMessages(SOURCE, TASK, false);
    const other = labelMessages(SOURCE, { ...TASK, goldCanon: '7' }, false);
    expect(other).toEqual(excerpt);
    expect(excerpt[0].content).toContain(EXCERPT_NOTE);
    expect(excerpt[0].content).toContain(`CELL: ${SOURCE.id}`);
    expect(excerpt[0].content).not.toContain('3/4 + 0?\n\n=== FULL TEXT');
    expect(excerpt[0].content.length).toBeLessThan(TEXT.length);
    const full = labelMessages(SOURCE, TASK, true);
    expect(full[0].content).toContain(FULL_NOTE);
    expect(full[0].content).toContain(TEXT);
  });

  it('reads only a valid label for the right text', () => {
    const cell = SOURCE.id;
    expect(parseLabel(JSON.stringify({ cell, status: 'accepted', values: [896], earlier: [] }), cell)).toEqual({ ok: true, label: { cell, status: 'accepted', values: ['896'], earlier: [] } });
    expect(parseLabel(`\`\`\`json\n${JSON.stringify({ cell, status: 'leading', values: ['1', '2'], earlier: ['3'] })}\n\`\`\``, cell).label).toMatchObject({ status: 'leading', values: ['1', '2'], earlier: ['3'] });
    expect(parseLabel('{"need_full_text": true}', cell)).toEqual({ ok: true, needFull: true });
    expect(parseLabel(JSON.stringify({ cell: 'other', status: 'none', values: [], earlier: [] }), cell).ok).toBe(false);
    expect(parseLabel(JSON.stringify({ cell, status: 'accepted', values: ['1', '2'], earlier: [] }), cell).ok).toBe(false);
    expect(parseLabel(JSON.stringify({ cell, status: 'none', values: ['1'], earlier: [] }), cell).ok).toBe(false);
    expect(parseLabel(JSON.stringify({ cell, status: 'leading', values: ['1', '2', '3', '4'], earlier: [] }), cell).ok).toBe(false);
    expect(parseLabel(JSON.stringify({ cell, status: 'sure', values: [], earlier: [] }), cell).ok).toBe(false);
    expect(parseLabel('no json here', cell).ok).toBe(false);
  });

  it('sends the full text once on request and stops after the allowed tries', async () => {
    const asks = [];
    const label = JSON.stringify({ cell: SOURCE.id, status: 'accepted', values: ['3/4'], earlier: ['1/2'] });
    const replies = ['{"need_full_text": true}', label];
    const got = await labelOne({ item: SOURCE, task: TASK, model: 'x/y', post: async (request) => { asks.push(request); return { ok: true, content: replies.shift() }; } });
    expect(got).toEqual({ cell: SOURCE.id, status: 'accepted', values: ['3/4'], earlier: ['1/2'], mode: 'full' });
    expect(asks.map((ask) => ask.full)).toEqual([false, true]);
    expect(asks[1].messages[0].content).toContain(TEXT);
    const bad = [];
    const none = await labelOne({ item: SOURCE, task: TASK, model: 'x/y', post: async (request) => { bad.push(request); return { ok: true, content: '{"need_full_text": true}' }; } });
    expect(none).toBeNull();
    expect(bad.map((ask) => ask.full)).toEqual([false, ...Array(LABEL_TRIES).fill(true)]);
    const failing = [];
    expect(await labelOne({ item: SOURCE, task: TASK, model: 'x/y', post: async (request) => { failing.push(request); return { ok: false, status: 500 }; } })).toBeNull();
    expect(failing).toHaveLength(LABEL_TRIES);
  });

  it('posts the label payload and reads cost, errors, and drops', async () => {
    const seen = [];
    const ok = openRouterPost({ key: 'k', fetchImpl: async (url, init) => { seen.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return new Response(JSON.stringify({ id: 'g', choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { cost: 0.01 } }), { status: 200 }); } });
    const reply = await ok({ model: 'openai/x', messages: [{ role: 'user', content: 'hi' }] });
    expect(reply).toMatchObject({ ok: true, content: '{}', cost: 0.01, generationId: 'g' });
    expect(seen[0].body).toMatchObject({ model: 'openai/x', reasoning: { effort: LABEL_EFFORT }, max_tokens: LABEL_MAX_TOKENS, response_format: { type: 'json_object' }, usage: { include: true } });
    expect(seen[0].url).toContain('/chat/completions');
    const http = openRouterPost({ key: 'k', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 429 }) });
    expect(await http({ model: 'a/b', messages: [] })).toMatchObject({ ok: false, status: 429, error: 'busy', cost: 0 });
    const drop = openRouterPost({ key: 'k', fetchImpl: async () => { throw new Error('socket hang up'); } });
    expect(await drop({ model: 'a/b', messages: [] })).toMatchObject({ ok: false, network: true, cost: null });
  });

  it('stops at the label budget, journals each call, and resumes from the journal', async () => {
    const items = [1, 2, 3, 4].map((n) => ({ ...SOURCE, id: `${TASK.id}|sample:${n}` }));
    const events = [];
    const journal = (event) => events.push(event);
    const price = { prompt: 0, completion: 0.0001 / LABEL_MAX_TOKENS };
    const guard = createLabelGuard({ limitUsd: 0.00025 });
    const post = journalledPost({
      post: async (request) => ({ ok: true, content: JSON.stringify({ cell: request.cell, status: 'none', values: [], earlier: [] }), cost: null }),
      guard, priceOf: () => price, pass: 'A', journal,
    });
    const first = await runLabelPass({ pass: 'A', model: 'x/y', items, tasks: TASKS, post, journal, concurrency: 1 });
    expect(first.stopped).toBe(true);
    expect(first.labels).toHaveLength(2);
    expect(first.missing).toHaveLength(2);
    expect(guard.state.unknown).toBe(2);
    const spend = labelSpend(events);
    expect(spend).toMatchObject({ calls: 2, unknown: 2, knownUsd: 0 });
    expect(spend.worstUnknownUsd).toBeCloseTo(0.0002, 10);
    const done = new Map(events.filter((event) => event.kind === 'label').map((event) => [event.cell, event.label]));
    const asked = [];
    const second = await runLabelPass({
      pass: 'A', model: 'x/y', items, tasks: TASKS, done, journal,
      post: async (request) => { asked.push(request.cell); return { ok: true, content: JSON.stringify({ cell: request.cell, status: 'none', values: [], earlier: [] }) }; },
    });
    expect(second.missing).toEqual([]);
    expect(asked.sort()).toEqual(first.missing.sort());
    expect(() => { throw new LabelBudgetStop('x'); }).toThrow(LabelBudgetStop);
  });
});

describe('finish probe v2: README note', () => {
  it('states the decision and the numbers from the report', () => {
    const verdict = (value) => ({ n: 3, correct: 1, need: 3, questionMean: 0.5, incomplete: 0, verdict: value });
    const tally = { n: 115, correct: 20, wrong: 10, empty: 85, incomplete: 0 };
    const result = {
      criteria: {
        c1: { models: { [MODEL]: { n: 80, accepted: 30, incomplete: 0, verdict: 'fail' } }, verdict: 'fail' },
        c2: verdict('fail'), c3: verdict('fail'),
        c4: { fRate: 0.2, cRate: 0.05, questionMeanDifference: 0.15, margin: 10 / 115, verdict: 'pass' },
        decision: 'no change: at least one of criteria 1-3 failed',
      },
      conditions: { F: { all: tally }, T: { all: tally }, C: { all: tally } },
      sensitivity: { c2: verdict('fail'), c3: verdict('fail'), c4: { verdict: 'pass' } },
      leaveOneOut: [],
    };
    const meta = {
      origin: { cells: 363, v1Done: 112 }, labelModels: { A: 'openai/a', B: 'google/b' }, groups: { firm: 20, none: 31 }, groupsDiffer: 3,
      budget: { settledUsd: 5, unresolvedUsd: 0.1, posts: 400 }, labels: { knownUsd: 2 }, keyDelta: 7.2,
    };
    const text = renderReadmeBlock(result, meta);
    expect(text).toContain('не выполнен хотя бы один из критериев 1–3');
    expect(text).toContain('openai/a');
    expect(text).toContain('| F | 115 | 20 | 10 | 85 | 0 |');
    expect(text).toContain('112 из 363');
    expect(text).not.toMatch(/undefined|NaN/);
  });
});

describe('finish probe v2: files', () => {
  it('names its protocol, which says v1 is not changed', () => {
    const text = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'finish-probe-v2-protocol.md'), 'utf8');
    expect(text).toContain('v1 is closed');
    expect(text).toContain('openai/gpt-6.1-sol');
    expect(text).toContain('google/gemini-4-argon');
  });
});
