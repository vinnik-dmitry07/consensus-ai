import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  PROTOCOL_V4, V4_CAP, V4_FILES, V4_LIMITS, criterionKP, criterionKW, decideV4, evaluateV4, renderV4Readme,
  routeCheck, v4Cells,
} from './finishProbeV4.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const row = (v3, correct = 0) => ({ v3, correct, accepted: v3 === 'accepted' });
const items = (n, questionOf = (index) => `q${index}`) => Array.from({ length: n }, (_, index) => ({ id: `t${index}`, questionId: questionOf(index), model: 'm' }));
const tally = (wins, undetermined = 0) => ({ wins, losses: 0, unchanged: 10, undetermined });
const recountOf = (b8, p8, v5) => ({ fill: { overFallback: { B8: b8, P8: p8, V5: v5, A8: tally(0), S8: tally(0) } } });

describe('finish probe v4: criteria', () => {
  it('passes KP at half right among the accepted, by count and by question', () => {
    const list = items(4);
    const outcome = new Map([['t0', row('accepted', 1)], ['t1', row('accepted', 0)], ['t2', row('rejected')], ['t3', row('rejected')]]);
    expect(criterionKP(list, (item) => outcome.get(item.id))).toMatchObject({ accepted: 2, right: 1, unconfirmed: 0, verdict: 'pass' });
  });

  it('fails KP below half, and with no accepted answer at all', () => {
    const list = items(3);
    const few = new Map([['t0', row('accepted', 1)], ['t1', row('accepted', 0)], ['t2', row('accepted', 0)]]);
    expect(criterionKP(list, (item) => few.get(item.id)).verdict).toBe('fail');
    expect(criterionKP(list, () => row('rejected')).verdict).toBe('fail');
  });

  it('reads KP with bounds: unconfirmed cells as wrong, then as right', () => {
    const list = items(4);
    // 2 right of 3 accepted; one unconfirmed: low 2/4 holds, so pass.
    const a = new Map([['t0', row('accepted', 1)], ['t1', row('accepted', 1)], ['t2', row('accepted', 0)], ['t3', row('pending')]]);
    expect(criterionKP(list, (item) => a.get(item.id))).toMatchObject({ verdict: 'pass', shareLow: 0.5, shareHigh: 0.75 });
    // 1 right of 3 accepted; two unconfirmed: low 1/5 fails, high 3/5 holds.
    const b = new Map([['t0', row('accepted', 1)], ['t1', row('accepted', 0)], ['t2', row('pending')], ['t3', row('unknown')]]);
    expect(criterionKP(list, (item) => b.get(item.id)).verdict).toBe('not_evaluable');
  });

  it('fails KP on the mean over questions when one question carries the right answers', () => {
    // q-big: 3 right of 3; four other questions: 1 wrong each. Count 3/7 < 1/2 anyway; make count pass and mean fail.
    const list = items(6, (index) => (index < 4 ? 'big' : `q${index}`));
    const outcome = new Map([['t0', row('accepted', 1)], ['t1', row('accepted', 1)], ['t2', row('accepted', 1)], ['t3', row('accepted', 1)], ['t4', row('accepted', 0)], ['t5', row('accepted', 0)]]);
    // Count 4/6 holds; question mean (1 + 0 + 0) / 3 = 1/3 fails.
    expect(criterionKP(list, (item) => outcome.get(item.id)).verdict).toBe('fail');
  });

  it('decides KW by wins over the fallback in B8, P8, and the vote of five only', () => {
    expect(criterionKW(recountOf(tally(1), tally(0), tally(0)))).toMatchObject({ verdict: 'pass', winArms: ['B8'] });
    expect(criterionKW(recountOf(tally(0), tally(0, 3), tally(0))).verdict).toBe('not_evaluable');
    expect(criterionKW(recountOf(tally(0), tally(0), tally(0))).verdict).toBe('fail');
    const onlySyntheses = { fill: { overFallback: { B8: tally(0), P8: tally(0), V5: tally(0), A8: tally(4), S8: tally(4) } } };
    expect(criterionKW(onlySyntheses).verdict).toBe('fail');
  });

  it('lets the first failing criterion decide, then incomplete, then confirmed', () => {
    const v = (verdict) => ({ verdict });
    expect(decideV4({ n: 0, k4: v('pass'), kp: v('pass'), kw: v('pass') }).code).toBe('no_cut_inputs');
    expect(decideV4({ n: 5, k4: v('fail'), kp: v('pass'), kw: v('pass') }).code).toBe('text_benefit_not_shown');
    expect(decideV4({ n: 5, k4: v('not_evaluable'), kp: v('fail'), kw: v('pass') }).code).toBe('accepted_often_wrong');
    expect(decideV4({ n: 5, k4: v('pass'), kp: v('pass'), kw: v('fail') }).code).toBe('no_use_for_arms');
    expect(decideV4({ n: 5, k4: v('pass'), kp: v('not_evaluable'), kw: v('pass') }).code).toBe('incomplete');
    expect(decideV4({ n: 5, k4: v('pass'), kp: v('pass'), kw: { verdict: 'pass', winArms: ['P8'] } })).toEqual({ code: 'confirmed_for_arms', arms: ['P8'] });
  });

  it('computes K4 with the v1 threshold on any N', () => {
    // N = 46: need ceil(460/115) = 4 texts.
    const list = items(46);
    const out = (diff) => new Map(list.flatMap((item, index) => [[`${item.id}|F`, row('accepted', index < diff ? 1 : 0)], [`${item.id}|C`, row('rejected')]]));
    const run = (diff) => evaluateV4({ inputs: list, outcome: (id) => out(diff).get(id), recount: recountOf(tally(1), tally(0), tally(0)) });
    expect(run(3).k4).toMatchObject({ needDifference: 4, verdict: 'fail' });
    expect(run(4).k4.verdict).toBe('pass');
    expect(run(4).decision.code).toBe('accepted_often_wrong');
  });
});

describe('finish probe v4: cells and routes', () => {
  const sources = [
    { id: 'q1|council:a', questionId: 'q1', kind: 'input', model: 'a', sample: 11, text: 'x' },
    { id: 'q2|sample:2', questionId: 'q2', kind: 'input', model: 'a', sample: 2, text: 'y' },
    { id: 'q1|synthesis:A8', questionId: 'q1', kind: 'synthesis', model: 'a', sample: 21, text: 'z' },
  ];

  it('puts F and C of every input before any synthesis, and finishes a synthesis with F only', () => {
    const cells = v4Cells(sources);
    expect(cells.map((cell) => cell.condition).filter((condition) => condition === 'T')).toEqual([]);
    expect(cells).toHaveLength(5);
    const firstSynthesis = cells.findIndex((cell) => cell.source.kind === 'synthesis');
    expect(firstSynthesis).toBe(4);
    expect(cells[4].condition).toBe('F');
    expect(new Set(cells.slice(0, 2).map((cell) => cell.sourceId)).size).toBe(1);
  });

  it('asks a route only when its pinned endpoint is listed and fits', () => {
    const route = { id: 'a', tag: 'host', providerName: 'Host', pricing: { prompt: '0.000001', completion: '0.000002' } };
    const fine = { tag: 'host/fp8', provider_name: 'Host', context_length: 100000, max_completion_tokens: 4096, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['max_tokens', 'temperature', 'top_p', 'reasoning'] };
    const needs = { a: { needPrompt: 50000, cap: V4_CAP } };
    expect(routeCheck([route], { a: { status: 200, endpoints: [fine] } }, needs).a).toMatchObject({ usable: true, endpoint: 'host/fp8' });
    expect(routeCheck([route], { a: { status: 200, endpoints: [{ ...fine, supported_parameters: ['max_tokens'] }] } }, needs).a.usable).toBe(false);
    expect(routeCheck([route], { a: { status: 200, endpoints: [{ ...fine, tag: 'other', provider_name: 'Other' }] } }, needs).a).toMatchObject({ usable: false, problems: ['not listed'] });
  });
});

describe('finish probe v4: text and protocol', () => {
  it('renders the README block from numbers only', () => {
    const k4 = { n: 10, fCorrect: 3, cCorrect: 1, differenceLow: 2, differenceHigh: 2, needDifference: 1, verdict: 'pass' };
    const kp = { right: 3, accepted: 5, unconfirmed: 0, verdict: 'pass' };
    const kw = { arms: [{ arm: 'B8', wins: 1, undetermined: 0 }], verdict: 'pass' };
    const pair = { delta: 0, interval: { low: -0.1, high: 0.1 } };
    const block = renderV4Readme({
      meta: { sourceRun: 'a8-open-v6', rows: 46, planned: 46, limits: V4_LIMITS, money: null },
      result: { decision: { code: 'confirmed_for_arms', arms: ['B8'] }, k4, kp, kw, inputs: 10, questions: 5, syntheses: 2, acceptance: [], recount: { original: { a8MinusS8: pair }, fallback: { a8MinusS8: pair }, fill: { a8MinusS8: pair } } },
    });
    expect(block).toContain('подтверждено на новых вопросах для рук с выигрышем (B8)');
    expect(block).toContain('| K4. F выше C |');
  });

  it('has a protocol that states the frozen rules and lists itself among the frozen files', () => {
    const text = readFileSync(path.join(EVAL_ROOT, PROTOCOL_V4), 'utf8');
    for (const phrase of ['$15 and 900 POSTs', 'One cap of 2048', 'K4', 'KP', 'KW', 'before the first test POST', 'No early stop']) expect(text).toContain(phrase);
    expect(V4_FILES).toContain(PROTOCOL_V4);
    expect(V4_FILES).toContain('finishProbeV4.test.js');
  });
});
