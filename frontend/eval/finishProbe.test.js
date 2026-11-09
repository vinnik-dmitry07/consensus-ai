import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { settings } from '../src/engine/browser/settings.js';
import { createCampaignBudget } from './budget.js';
import {
  CONDITIONS, CONTROL_INSTRUCTION, FINISH_INSTRUCTION, STAGE, TAIL_CHARS,
  acceptFinish, cellKey, cellState, collectSources, decide, evaluateCriteria, excerpts, finishMessage, groupFrom, leaderRole,
  mergeLabels, minimalEffort, orderCells, outcomesOf, pilotSources, policyArms, prepareProbe, probeRoutes, raisedRoutes, runCells, usedSlot, voteOf,
} from './finishProbe.js';
import { createSession } from './runtime.js';
import { installTransport } from './transport.js';

const COUNCIL = ['alpha/one', 'beta/two', 'gamma/three'];
const B = COUNCIL[0];
const TASK = { id: 'test:x:1', kind: 'number', stem: 'What is 3/4 + 0?', goldCanon: '3/4', choiceCount: 0 };
const REASONING = `${'long reasoning '.repeat(1000)}so the answer looks like 3/4`;

function slot(branch, stage, sample, model, result, extra = {}) {
  return { key: `${branch}|${stage}|${sample}|${model}|${extra.hash || 'h'}`, meta: { questionId: TASK.id, branch, stage, sample, model }, state: 'completed', result, finishReason: result.finishReason ?? null, ...extra };
}

const cutResult = (content) => ({ ok: true, content, finishReason: 'length', contentFromReasoning: true });
const finished = (content) => ({ ok: true, content, finishReason: 'stop' });

function row(overrides = {}) {
  return {
    id: TASK.id,
    block: 'hmmt',
    status: 'complete',
    arms: {
      A8: { status: 'graded', extracted: '3/4', correct: 1, text: 'ANSWER: 3/4' },
      S8: { status: 'graded', extracted: '3/4', correct: 1, text: 'ANSWER: 3/4' },
      P8: { status: 'graded', extracted: '3/4', correct: 1 },
      B8: { status: 'parse_error', extracted: null, correct: 0 },
    },
    diagnostics: {
      leader: { status: 'graded', extracted: '3/4', correct: 1 },
      replicateVote: { status: 'graded', extracted: '3/4', correct: 1 },
      councilAnswers: [null, '3/4', '3/4'],
      replicateAnswers: [null, '3/4', '3/4', '3/4', '3/4'],
      replicateTexts: [REASONING, 'a', 'b', 'c', 'd'],
    },
    ...overrides,
  };
}

const CTX = { gold: '3/4', councilModels: COUNCIL, bModel: B, leaderRole: null, a8Cut: false, s8Cut: false };

describe('finish probe: sources', () => {
  it('selects only cut reasoning and finishes the shared first B answer once', () => {
    const sources = collectSources({
      rows: [row()],
      slots: [
        slot('council', 'stage1', 1, COUNCIL[0], cutResult(REASONING)),
        slot('council', 'stage1', 1, COUNCIL[1], finished('ANSWER: 3/4')),
        slot('council', 'stage1', 1, COUNCIL[2], { ok: true, content: 'word', finishReason: 'length' }),
        slot('replicates', 'sample', 2, B, finished('a')),
        slot('replicates', 'sample', 3, B, finished('b')),
        slot('replicates', 'sample', 4, B, finished('c')),
        slot('replicates', 'sample', 5, B, finished('d')),
        slot('council', 'stage2', 1, COUNCIL[1], cutResult('judge reasoning')),
        slot('A8', 'stage3', 1, B, finished('ANSWER: 3/4')),
        slot('S8', 'stage3', 1, B, finished('ANSWER: 3/4')),
      ],
      councilModels: COUNCIL,
      bModel: B,
      chairmanModel: B,
      tasks: new Map([[TASK.id, TASK]]),
    });
    expect(sources.map((source) => source.role)).toEqual([`council:${B}`]);
    expect(sources[0].text).toBe(REASONING);
  });

  it('reads the finish reason from slot metadata and finds a slot by its text', () => {
    const older = slot('replicates', 'sample', 2, B, cutResult('old'), { hash: 'old' });
    const used = slot('replicates', 'sample', 2, B, cutResult('used'), { hash: 'new' });
    expect(usedSlot([older, used], 'used')).toBe(used);
    const noReason = { ...slot('council', 'stage1', 1, COUNCIL[1], { ok: true, content: 'x', contentFromReasoning: true }), finishReason: 'length' };
    const sources = collectSources({
      rows: [row({ diagnostics: { ...row().diagnostics, replicateTexts: ['p', 'a', 'b', 'c', 'd'] } })],
      slots: [noReason],
      councilModels: [COUNCIL[1]],
      bModel: B,
      chairmanModel: B,
      tasks: new Map([[TASK.id, TASK]]),
    });
    expect(sources).toHaveLength(1);
    expect(sources[0].finishReason).toBe('length');
  });

  it('recovers the leader from Candidate #1 and refuses a tie', () => {
    const one = { role: 'council:a', text: `${'x'.repeat(600)}END-ONE` };
    const two = { role: 'council:b', text: `${'y'.repeat(600)}END-TWO` };
    const prompt = `Candidate #1 (score=0.9, correctness=n/a):\nJudge issues: none\n[marker]\n${one.text}\nCandidate #2 (score=0.1, correctness=n/a):\n${two.text}`;
    expect(leaderRole(prompt, [one, two])).toBe('council:a');
    expect(leaderRole(prompt, [{ ...two, text: one.text }, one])).toBe(null);
  });

  it('orders originals first with the conditions of a source together', () => {
    const inputs = ['a', 'b'].map((name, index) => ({ id: `q|${name}`, questionId: 'q', kind: 'input', sample: index + 1, model: B, text: 't' }));
    const synth = { id: 'q|synthesis:A8', questionId: 'q', kind: 'synthesis', sample: 21, model: B, text: 't' };
    const cells = orderCells([synth, ...inputs]);
    expect(cells).toHaveLength(7);
    expect(cells[6].sourceId).toBe(synth.id);
    expect(cells.slice(0, 3).every((cell) => cell.sourceId === cells[0].sourceId)).toBe(true);
    expect(new Set(cells.slice(0, 3).map((cell) => cell.condition))).toEqual(new Set(CONDITIONS));
  });

  it('fills the pilot from dev first and then from test in distinct questions', () => {
    const dev = [{ id: 'd|1', questionId: 'd', model: B }];
    const inputs = [1, 2, 3, 4, 5].map((n) => ({ id: `t${n}|x`, questionId: `t${n}`, model: B }));
    const chosen = pilotSources(dev, [...inputs, { id: 't1|y', questionId: 't1', model: B }], [B], 4);
    expect(chosen).toHaveLength(4);
    expect(chosen[0].id).toBe('d|1');
    expect(new Set(chosen.map((item) => item.questionId)).size).toBe(4);
  });
});

describe('finish probe: request', () => {
  it('does not depend on the gold or the labels', () => {
    for (const condition of CONDITIONS) {
      const one = finishMessage({ ...TASK, goldCanon: '3/4', group: 'firm' }, condition, REASONING);
      const two = finishMessage({ ...TASK, goldCanon: '99', group: 'none' }, condition, REASONING);
      expect(one).toBe(two);
    }
  });

  it('builds the three conditions from the fixed text', () => {
    expect(finishMessage(TASK, 'F', REASONING)).toContain(REASONING);
    expect(finishMessage(TASK, 'F', REASONING).endsWith(FINISH_INSTRUCTION)).toBe(true);
    const tail = finishMessage(TASK, 'T', 'q'.repeat(TAIL_CHARS + 50));
    expect(tail).toContain('q'.repeat(TAIL_CHARS));
    expect(tail).not.toContain('q'.repeat(TAIL_CHARS + 1));
    const control = finishMessage(TASK, 'C', REASONING);
    expect(control).not.toContain('long reasoning');
    expect(control.endsWith(CONTROL_INSTRUCTION)).toBe(true);
  });

  it('picks the lowest effort and keeps the pinned route', () => {
    expect(minimalEffort({ catalogue: { reasoning: { supported_efforts: ['high', 'medium', 'low'] } } })).toBe('low');
    expect(minimalEffort({ catalogue: { reasoning: { supported_efforts: ['high', 'low', 'none'] } } })).toBe('none');
    const route = { id: B, provider: { order: ['host'], allow_fallbacks: false }, temperature: 0.7, topP: 1, catalogue: { reasoning: { supported_efforts: ['low'] } } };
    const routes = probeRoutes([route]);
    const prepared = prepareProbe(routes, () => 2048)(B, STAGE, {});
    expect(prepared.maxTokens).toBe(2048);
    expect(prepared.reasoning).toEqual({ effort: 'low' });
    expect(prepared.provider).toEqual({ order: ['host'], allow_fallbacks: false, require_parameters: true });
    expect(prepared.evalAnnotations).toBe(true);
  });
});

describe('finish probe: calls', () => {
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

  function open(respond, runDir = null) {
    const dir = runDir || mkdtempSync(path.join(tmpdir(), 'finish-probe-'));
    if (!runDir) dirs.push(dir);
    const prices = Object.fromEntries(COUNCIL.map((id) => [id, { prompt: '0.000001', completion: '0.000001' }]));
    const budget = createCampaignBudget({ maxUsd: 10, maxPosts: 100, prices });
    const routes = Object.fromEntries(COUNCIL.map((id) => [id, { id, provider: { order: ['host'], allow_fallbacks: false, require_parameters: true }, temperature: 0.7, topP: 1, reasoning: { effort: 'low' } }]));
    session = createSession({ runDir: dir, budget, log() {}, retryLimit: 1, retainRoster: true, retryAfterCooldown: true, maxInFlight: 3, maxInFlightPerModel: 3, prepareOptions: prepareProbe(routes, () => 2048) });
    session.install();
    const posts = [];
    restore = installTransport({
      nativeFetch: async (_url, init) => {
        const body = JSON.parse(init.body || '{}');
        posts.push(body);
        return respond(body);
      },
      allowModels: new Set(COUNCIL),
      allowPaid: true,
      rejectFree: true,
      budget,
      onHttp: session.onHttp,
      onCooldown: session.onCooldown,
    });
    return { dir, posts };
  }

  const reply = (message, finish = 'stop') => new Response(JSON.stringify({
    id: 'gen-1',
    choices: [{ message, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const source = { id: `${TASK.id}|council:${B}`, questionId: TASK.id, kind: 'input', sample: 11, model: B, text: REASONING };
  const tasks = new Map([[TASK.id, TASK]]);

  it('sends the pinned payload and accepts a visible final line', async () => {
    const { posts } = open(() => reply({ content: 'ANSWER: 3/4' }));
    const cells = orderCells([source], 'seed', ['F']);
    const states = await runCells({ cells, tasks, session });
    expect(states).toEqual({ done: 1 });
    expect(posts[0].max_tokens).toBe(2048);
    expect(posts[0].reasoning).toEqual({ effort: 'low' });
    expect(posts[0].provider.require_parameters).toBe(true);
    expect(posts[0].messages[0].content).toContain('Unfinished reasoning:');
    const outcome = outcomesOf(cells, tasks, session.slots()).get(cells[0].id);
    expect(outcome).toMatchObject({ accepted: true, extracted: '3/4', correct: 1, reason: 'accepted' });
  });

  it('gives no answer for a repeated cut or for text from reasoning', async () => {
    const { posts } = open((body) => {
      const isC = !body.messages[0].content.includes('Unfinished reasoning:');
      if (isC) return reply({ content: '', reasoning: 'thinking\nANSWER: 3/4' }, 'stop');
      return reply({ content: 'ANSWER: 3/4' }, 'length');
    });
    const cells = orderCells([source], 'seed', ['F', 'C']);
    await runCells({ cells, tasks, session });
    expect(posts).toHaveLength(2);
    const outcomes = outcomesOf(cells, tasks, session.slots());
    const reasons = cells.map((cell) => outcomes.get(cell.id).reason);
    expect(reasons.sort()).toEqual(['cut', 'from_reasoning']);
    expect([...outcomes.values()].every((row) => !row.accepted && row.correct === 0)).toBe(true);
  });

  it('does not send a finished cell again after a restart', async () => {
    const { dir, posts } = open(() => reply({ content: 'ANSWER: 3/4' }));
    const cells = orderCells([source], 'seed', ['F']);
    await runCells({ cells, tasks, session });
    session.uninstall();
    restore();
    const second = open(() => reply({ content: 'ANSWER: 9' }), dir);
    await runCells({ cells, tasks, session });
    expect(posts).toHaveLength(1);
    expect(second.posts).toHaveLength(0);
  });

  it('never resends a cell whose POST left no outcome', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finish-probe-'));
    dirs.push(dir);
    const cells = orderCells([source], 'seed', ['F']);
    const meta = { questionId: TASK.id, branch: cells[0].branch, stage: STAGE, sample: cells[0].sample, model: B, requestHash: 'h' };
    mkdirSync(path.join(dir, 'bodies'), { recursive: true });
    appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ kind: 'slot', key: 'k', slot: { key: 'k', meta, state: 'running', result: null } })}\n${JSON.stringify({ kind: 'http', phase: 'reserved', key: 'k', model: B })}\n`);
    const { posts } = open(() => reply({ content: 'ANSWER: 3/4' }), dir);
    const states = await runCells({ cells, tasks, session });
    expect(states).toEqual({ unknown: 1 });
    expect(posts).toHaveLength(0);
    expect(cellKey(meta)).toBe(cellKey(cells[0]));
  });

  it('keeps a refused cell pending and asks again after the cooldown', async () => {
    let refuse = true;
    const { posts } = open(() => {
      if (refuse) return new Response(JSON.stringify({ error: { code: 429, message: 'Provider returned error', metadata: { raw: 'x is temporarily rate-limited upstream' } } }), { status: 429, headers: { 'content-type': 'application/json' } });
      return reply({ content: 'ANSWER: 3/4' });
    });
    const cells = orderCells([source], 'seed', ['F']);
    const first = await runCells({ cells, tasks, session });
    expect(first).toEqual({ pending: 1 });
    expect(posts).toHaveLength(1);
    session.cooldowns.clear();
    refuse = false;
    const second = await runCells({ cells, tasks, session });
    expect(second).toEqual({ done: 1 });
    expect(posts).toHaveLength(2);
  });

  it('reads cell states', () => {
    expect(cellState(null)).toBe('pending');
    expect(cellState({ state: 'completed' })).toBe('done');
    expect(cellState({ state: 'failed' })).toBe('failed');
    expect(cellState({ state: 'skipped' })).toBe('pending');
    expect(cellState({ state: 'unknown' })).toBe('unknown');
    expect(cellState({ state: 'skipped', cutAttempts: 1 })).toBe('unknown');
    expect(acceptFinish(TASK, { state: 'unknown' })).toMatchObject({ state: 'unknown', accepted: false });
  });
});

describe('finish probe: policies', () => {
  const forced = (entries) => new Map(entries.map(([role, value]) => [`${TASK.id}|${role}`, value]));

  it('fill never lets an extra vote outweigh a real one', () => {
    const r = row({ diagnostics: { ...row().diagnostics, councilAnswers: [null, '3/4', null], replicateAnswers: [null, null, null, '3/4', null] } });
    const map = forced([[`council:${B}`, '7'], [`council:${COUNCIL[2]}`, '7'], ['sample:2', '7'], ['sample:3', '7'], ['sample:5', '7']]);
    const fill = policyArms(r, CTX, 'fill', map);
    expect(fill.P8.extracted).toBe('3/4');
    expect(fill.V5.extracted).toBe('3/4');
    const all = policyArms(r, CTX, 'all', map);
    expect(all.P8.extracted).toBe('7');
    expect(all.V5.extracted).toBe('7');
  });

  it('fill uses extra votes only when no real vote exists', () => {
    const r = row({ arms: { ...row().arms, P8: { status: 'no_answer', extracted: null, correct: 0 } }, diagnostics: { ...row().diagnostics, councilAnswers: [null, null, null], replicateVote: { status: 'no_answer', extracted: null, correct: 0 }, replicateAnswers: [null, null, null, null, null] } });
    const map = forced([[`council:${B}`, '3/4'], [`council:${COUNCIL[1]}`, '3/4'], [`council:${COUNCIL[2]}`, '9'], ['sample:2', '3/4']]);
    const fill = policyArms(r, CTX, 'fill', map);
    expect(fill.P8).toMatchObject({ extracted: '3/4', correct: 1 });
    expect(fill.V5).toMatchObject({ extracted: '3/4', correct: 1 });
    expect(fill.B8).toMatchObject({ extracted: '3/4', correct: 1 });
  });

  it('treats the two arms alike when a synthesis is cut', () => {
    const noAnswer = { status: 'parse_error', extracted: null, correct: 0 };
    const r = row({
      arms: { A8: noAnswer, S8: noAnswer, P8: { status: 'no_answer', extracted: null, correct: 0 }, B8: noAnswer },
      diagnostics: { ...row().diagnostics, leader: noAnswer, replicateVote: { status: 'no_answer', extracted: null, correct: 0 }, councilAnswers: [null, null, null], replicateAnswers: [null, null, null, null, null] },
    });
    const ctx = { ...CTX, a8Cut: true, s8Cut: true, leaderRole: `council:${B}` };
    const map = forced([[`council:${B}`, '3/4'], ['sample:2', '3/4']]);
    expect(policyArms(r, ctx, 'fallback', map).A8.correct).toBe(0);
    expect(policyArms(r, ctx, 'fallback', map).S8.correct).toBe(0);
    const fill = policyArms(r, ctx, 'fill', map);
    expect(fill.A8).toMatchObject({ extracted: '3/4', correct: 1 });
    expect(fill.S8).toMatchObject({ extracted: '3/4', correct: 1 });
    expect(policyArms(r, { ...ctx, leaderRole: null }, 'fill', map).undetermined).toBe(true);
  });

  it('prefers finished answers at both arms and keeps an accepted final', () => {
    const noAnswer = { status: 'parse_error', extracted: null, correct: 0 };
    const r = row({ arms: { ...row().arms, A8: noAnswer, S8: noAnswer } });
    const ctx = { ...CTX, a8Cut: true, s8Cut: true, leaderRole: `council:${B}` };
    const map = forced([[`council:${B}`, '7']]);
    const fill = policyArms(r, ctx, 'fill', map);
    expect(fill.A8.extracted).toBe('3/4');
    expect(fill.S8.extracted).toBe('3/4');
    const accepted = row();
    expect(policyArms(accepted, ctx, 'fill', map).A8).toBe(accepted.arms.A8);
  });

  it('breaks vote ties by the seeded hash, not by position', () => {
    const one = voteOf('q', ['1', '2']);
    const two = voteOf('q', ['2', '1']);
    expect(one.extracted).toBe(two.extracted);
  });
});

describe('finish probe: criteria', () => {
  const models = [B];
  const items = (n, group, question = (i) => `q${i}`) => Array.from({ length: n }, (_, i) => ({ id: `${group}${i}`, questionId: question(i), model: B, group }));
  const run = (inputs, hits, control = () => 0) => {
    const labels = new Map(inputs.map((item) => [item.id, item.group]));
    const table = new Map();
    inputs.forEach((item, index) => {
      table.set(`${item.id}|F`, { state: 'done', accepted: true, correct: hits(item, index) });
      table.set(`${item.id}|C`, { state: 'done', accepted: true, correct: control(item, index) });
    });
    return evaluateCriteria({ inputs, outcome: (id) => table.get(id), labels, models });
  };

  it('applies ceil on the texts and the mean over questions', () => {
    const inputs = [...items(15, 'firm'), ...items(9, 'candidate')];
    const result = run(inputs, (item, index) => (item.group === 'firm' && index < 12 ? 1 : 0));
    expect(result.c2).toMatchObject({ n: 15, correct: 12, need: 12, verdict: 'pass' });
    expect(result.c3).toMatchObject({ n: 24, correct: 12, need: 12, verdict: 'pass' });
    const low = run(inputs, (item, index) => (item.group === 'firm' && index < 11 ? 1 : 0));
    expect(low.c2.verdict).toBe('fail');
  });

  it('fails on the question-level mean even when the text count passes', () => {
    const inputs = [...items(12, 'firm', () => 'big'), ...items(3, 'firm', (i) => `small${i}`).map((item) => ({ ...item, id: `x${item.id}` }))];
    const result = run(inputs, (item) => (item.questionId === 'big' ? 1 : 0));
    expect(result.c2).toMatchObject({ correct: 12, need: 12, verdict: 'fail' });
  });

  it('does not pass an empty group, and leaves an incomplete set open', () => {
    const inputs = items(3, 'none');
    expect(run(inputs, () => 0).c2.verdict).toBe('fail');
    const firm = items(5, 'firm');
    const labels = new Map(firm.map((item) => [item.id, 'firm']));
    const table = new Map(firm.map((item) => [`${item.id}|F`, { state: 'done', accepted: true, correct: 1 }]));
    table.set(`${firm[0].id}|F`, { state: 'unknown', accepted: false, correct: 0 });
    const result = evaluateCriteria({ inputs: firm, outcome: (id) => table.get(id), labels, models });
    expect(result.c2.verdict).toBe('undetermined');
    expect(result.c1.verdict).toBe('undetermined');
  });

  it('needs F above C by the margin', () => {
    const inputs = items(115, 'none');
    expect(run(inputs, (item, i) => (i < 40 ? 1 : 0), (item, i) => (i < 30 ? 1 : 0)).c4.verdict).toBe('pass');
    expect(run(inputs, (item, i) => (i < 39 ? 1 : 0), (item, i) => (i < 30 ? 1 : 0)).c4.verdict).toBe('fail');
  });

  it('turns verdicts into the decision', () => {
    expect(decide('pass', 'fail', 'pass', 'pass')).toMatch(/no change/);
    expect(decide('pass', 'pass', 'pass', 'fail')).toMatch(/not shown/);
    expect(decide('pass', 'pass', 'pass', 'undetermined')).toMatch(/undetermined/);
    expect(decide('pass', 'pass', 'pass', 'pass')).toMatch(/confirming/);
  });

  it('raises the cap only for a cut share above the limit', () => {
    const row1 = { F: { n: 4, length: 1, accepted: 3 } };
    const row2 = { F: { n: 5, length: 1, accepted: 4 } };
    expect(raisedRoutes({ a: row1, b: row2 })).toEqual(['a']);
  });
});

describe('finish probe: labels', () => {
  it('derives groups from gold-free notes', () => {
    expect(groupFrom({ status: 'accepted', values: ['3/4'], earlier: [] }, '3/4', TASK)).toBe('firm');
    expect(groupFrom({ status: 'leading', values: ['3/4', '5'], earlier: [] }, '3/4', TASK)).toBe('candidate');
    expect(groupFrom({ status: 'accepted', values: ['5'], earlier: ['3/4'] }, '3/4', TASK)).toBe('switched');
    expect(groupFrom({ status: 'none', values: [], earlier: ['3/4'] }, '3/4', TASK)).toBe('switched');
    expect(groupFrom({ status: 'none', values: [], earlier: [] }, '3/4', TASK)).toBe('none');
  });

  it('turns a disagreement into a candidate and keeps both notes', () => {
    const id = `${TASK.id}|sample:2`;
    const sources = new Map([[id, { questionId: TASK.id, textSha: 'sha' }]]);
    const tasks = new Map([[TASK.id, TASK]]);
    const [item] = mergeLabels([id], sources, tasks, [{ cell: id, status: 'accepted', values: ['3/4'], earlier: [] }], [{ cell: id, status: 'none', values: [], earlier: [] }]);
    expect(item).toMatchObject({ groupA: 'firm', groupB: 'none', group: 'candidate', agreedAccepted: null });
    const [same] = mergeLabels([id], sources, tasks, [{ cell: id, status: 'accepted', values: ['\\frac{3}{4}'], earlier: [] }], [{ cell: id, status: 'accepted', values: ['3/4'], earlier: [] }]);
    expect(same).toMatchObject({ group: 'firm', agreedAccepted: '3/4' });
  });

  it('chooses excerpts by the words only', () => {
    const text = `${'answer here. '.repeat(100)}${'z'.repeat(9000)}`;
    const out = excerpts(text);
    expect(out.fragments).toHaveLength(30);
    expect(out.tail).toHaveLength(8000);
  });
});
