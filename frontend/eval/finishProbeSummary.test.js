import { describe, expect, it } from 'vitest';

import { writeAndCheck, writerMessages } from './evalAnalysis.js';
import { outcomeOf } from './finishProbeV3.js';
import {
  AFTER_V3, ANALYSIS_END, ANALYSIS_START, GROUPS, README_END, README_START, STATUSES, SUMMARY_INSTRUCTION,
  byGroup, byStatus, changedCells, correctnessTransitions, median, pricePerCorrect, summaryAnalysisSection, transitions,
} from './finishProbeSummary.js';
import { placeBlock } from './finishProbeV3.js';

const row = (v3, extra = {}) => ({ v3, correct: 0, posts: 1, cost: 0.01, completionTokens: 100, serviceMs: 1000, ...extra });
const cells = (n) => Array.from({ length: n }, (_, index) => ({ id: `c${index}`, questionId: `q${index}` }));

describe('finish probe summary: tables', () => {
  it('counts the same cells at both caps, only where the later cap confirmed them', () => {
    const list = cells(6);
    const low = new Map([
      ['c0', row('accepted')], ['c1', row('accepted')], ['c2', row('rejected')], ['c3', row('rejected')], ['c4', row('unmeasured')], ['c5', row('accepted')],
    ]);
    const high = new Map([
      ['c0', row('accepted', { correct: 1 })], ['c1', row('rejected')], ['c2', row('accepted')], ['c3', row('rejected')], ['c4', row('accepted')], ['c5', row('pending', { posts: 0 })],
    ]);
    const t = transitions(list, low, high);
    expect(t.n).toBe(5);
    expect(t.table).toEqual({
      accepted: { accepted: 1, rejected: 1 },
      rejected: { accepted: 1, rejected: 1 },
      unconfirmed: { accepted: 1, rejected: 0 },
    });
    expect(t.at8192).toMatchObject({ accepted: 3, correct: 1, rejected: 2 });
    expect(t.at2048).toMatchObject({ accepted: 2, rejected: 2 });
  });

  it('reads a 404 before generation as not measured, not as a cut', () => {
    const slot = { state: 'failed', result: { error: { status: 404, detail: 'No endpoints found for x' } }, httpAttempts: 1 };
    expect(outcomeOf({ kind: 'number', goldCanon: '5' }, slot).v3).toBe('unmeasured');
  });

  it('splits acceptance and correctness by label group, unlabelled included', () => {
    const inputs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const groups = new Map([['a', 'firm'], ['b', 'firm'], ['c', 'none']]);
    const outcome = new Map([
      ['a|F', row('accepted', { correct: 1 })], ['b|F', row('rejected')], ['c|F', row('accepted', { correct: 0 })], ['d|F', row('pending', { posts: 0 })],
    ]);
    const table = byGroup(inputs, outcome, groups);
    expect(Object.keys(table)).toEqual([...GROUPS]);
    expect(table.firm).toEqual({ n: 2, accepted: 1, correct: 1, wrong: 0, rejected: 1, unconfirmed: 0 });
    expect(table.none).toEqual({ n: 1, accepted: 1, correct: 0, wrong: 1, rejected: 0, unconfirmed: 0 });
    expect(table.unlabelled).toEqual({ n: 1, accepted: 0, correct: 0, wrong: 0, rejected: 0, unconfirmed: 1 });
  });

  it('splits by the status both passes gave the text, and keeps differing passes apart', () => {
    const inputs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const items = new Map([
      ['a', { passA: { status: 'none' }, passB: { status: 'none' } }],
      ['b', { passA: { status: 'accepted' }, passB: { status: 'leading' } }],
      ['c', { passA: { status: 'leading' }, passB: { status: 'leading' } }],
    ]);
    const outcome = new Map([['a|F', row('accepted', { correct: 1 })], ['b|F', row('rejected')], ['c|F', row('accepted')], ['d|F', row('accepted', { correct: 1 })]]);
    const table = byStatus(inputs, outcome, items);
    expect(Object.keys(table)).toEqual([...STATUSES]);
    expect(table.none).toEqual({ n: 1, accepted: 1, correct: 1, rejected: 0, unconfirmed: 0 });
    expect(table.differ).toEqual({ n: 1, accepted: 0, correct: 0, rejected: 1, unconfirmed: 0 });
    expect(table.leading).toMatchObject({ n: 1, accepted: 1, correct: 0 });
    expect(table.unlabelled).toMatchObject({ n: 1, accepted: 1, correct: 1 });
  });

  it('crosses correctness at both caps and lists the cells whose acceptance changed', () => {
    const list = [
      { id: 'c0|F', sourceId: 'c0' }, { id: 'c1|F', sourceId: 'c1' }, { id: 'c2|F', sourceId: 'c2' }, { id: 'c3|F', sourceId: 'c3' },
    ];
    const low = new Map([['c0|F', row('accepted', { correct: 1 })], ['c1|F', row('accepted')], ['c2|F', row('rejected', { completionTokens: 2048 })], ['c3|F', row('rejected')]]);
    const high = new Map([['c0|F', row('accepted', { correct: 1 })], ['c1|F', row('rejected')], ['c2|F', row('accepted', { correct: 1, completionTokens: 7667 })], ['c3|F', row('pending', { posts: 0 })]]);
    const table = correctnessTransitions(list, low, high);
    expect(table.right).toEqual({ right: 1, wrong: 0, cut: 0 });
    expect(table.wrong).toEqual({ right: 0, wrong: 0, cut: 1 });
    expect(table.cut).toEqual({ right: 1, wrong: 0, cut: 0 });
    const changed = changedCells(list, low, high, new Map([['c2', { passA: { status: 'none' }, passB: { status: 'none' } }]]));
    expect(changed).toEqual([
      { cell: 'c1', status: 'unlabelled', at2048: { form: 'wrong', tokens: 100 }, at8192: { form: 'cut', tokens: 100 } },
      { cell: 'c2', status: 'none', at2048: { form: 'cut', tokens: 2048 }, at8192: { form: 'right', tokens: 7667 } },
    ]);
  });

  it('prices a correct answer from the known costs of every posted call', () => {
    const inputs = [{ id: 'a', model: 'm' }, { id: 'b', model: 'm' }, { id: 'c', model: 'm' }];
    const outcome = new Map([
      ['a|F', row('accepted', { correct: 1, cost: 0.03 })], ['b|F', row('rejected', { cost: 0.05 })], ['c|F', row('unmeasured', { cost: null })],
    ]);
    const [price] = pricePerCorrect(inputs, outcome, ['m']);
    expect(price).toMatchObject({ n: 3, posted: 3, withoutCost: 1, accepted: 1, correct: 1 });
    expect(price.usd).toBeCloseTo(0.08, 10);
    expect(price.usdPerCorrect).toBeCloseTo(0.08, 10);
    expect(median([3, 1, 2, 10])).toBe(2.5);
  });
});

describe('finish probe summary: README', () => {
  it('places the block after the v3 analysis, then the analysis after the block, and replaces both in place', () => {
    const base = `intro\n${AFTER_V3}\ntail\n`;
    const once = placeBlock(base, README_START, README_END, 'one', AFTER_V3);
    expect(once.indexOf(README_START)).toBeGreaterThan(once.indexOf(AFTER_V3));
    expect(once.endsWith('tail\n')).toBe(true);
    const twice = placeBlock(once, README_START, README_END, 'two', AFTER_V3);
    expect(twice).not.toContain('one');
    expect(twice.split(README_START).length).toBe(2);
    const section = summaryAnalysisSection('text', { problems: [] }, 'w/m', 'c/m');
    const withAnalysis = placeBlock(twice, ANALYSIS_START, ANALYSIS_END, section, README_END);
    expect(withAnalysis.indexOf(ANALYSIS_START)).toBeGreaterThan(withAnalysis.indexOf(README_END));
    expect(section).toContain('замечаний: 0');
    expect(section).toContain('Claude этот текст не писал и не правил');
  });
});

describe('analysis: write and check', () => {
  const replies = (list) => {
    const calls = [];
    return { calls, post: async (model, messages, role) => { calls.push({ model, role, messages }); return list.shift(); } };
  };

  it('places nothing unless the checker found no problem', async () => {
    const { post, calls } = replies([
      { ok: true, content: 'draft 1' },
      { ok: true, content: '{"ok": false, "problems": [{"quote": "7", "issue": "not in the report"}]}' },
      { ok: true, content: 'draft 2' },
      { ok: true, content: '{"ok": true, "problems": []}' },
    ]);
    const out = await writeAndCheck({ instruction: SUMMARY_INSTRUCTION, rules: 'R', report: 'REP', post, writer: 'w', checker: 'c' });
    expect(out).toMatchObject({ text: 'draft 2', rounds: 2 });
    expect(calls.map((call) => `${call.model}:${call.role}`)).toEqual(['w:write-1', 'c:check-1', 'w:write-2', 'c:check-2']);
    expect(calls[2].messages[0].content).toContain('not in the report');
  });

  it('stops when problems remain after the fix or the checker reply is not JSON', async () => {
    const bad = '{"ok": false, "problems": [{"quote": "x", "issue": "y"}]}';
    const first = replies([{ ok: true, content: 'a' }, { ok: true, content: bad }, { ok: true, content: 'b' }, { ok: true, content: bad }]);
    expect((await writeAndCheck({ instruction: 'I', rules: 'R', report: 'REP', post: first.post })).text).toBeNull();
    const second = replies([{ ok: true, content: 'a' }, { ok: true, content: 'no json here' }]);
    expect(await writeAndCheck({ instruction: 'I', rules: 'R', report: 'REP', post: second.post })).toMatchObject({ text: null, reason: 'checker gave no valid reply' });
  });

  it('gives the writer the rules and the report as data', () => {
    const [message] = writerMessages('I', 'RULES', 'REPORT');
    expect(message.content).toContain('<<<PROTOCOL\nRULES\nPROTOCOL>>>');
    expect(message.content).toContain('<<<REPORT\nREPORT\nREPORT>>>');
  });
});
