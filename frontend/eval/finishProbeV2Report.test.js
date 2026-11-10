import { describe, expect, it } from 'vitest';

import { createCampaignBudget } from './budget.js';
import { STAGE, cellKey, evaluateCriteria, orderCells } from './finishProbe.js';
import {
  FORMS, c4ByRoute, formOf, formTable, heldSplit, keyOfAttempt, pinnedListed, readOutcomes, renderReadme, renderV2Report,
  routeUnavailable,
} from './finishProbeV2Report.js';

const ROUTES = ['alpha/one', 'beta/two'];
const source = (n, model, kind = 'input') => ({ id: `test:x:${n}|council:${model}`, questionId: `test:x:${n}`, kind, sample: 11, model, text: 't' });
const gone = { state: 'failed', result: { ok: false, error: { status: 404, detail: 'No endpoints found for beta/two. Every candidate endpoint was removed during routing.' } }, usage: null };
const broken = { state: 'failed', result: { ok: false, error: { status: 502, detail: 'Provider returned error' } }, usage: null };

describe('finish probe v2 report: a route that is gone', () => {
  it('tells a call that reached no model from a call that failed', () => {
    expect(routeUnavailable(gone)).toBe(true);
    expect(routeUnavailable(broken)).toBe(false);
    expect(routeUnavailable({ ...gone, state: 'completed' })).toBe(false);
    expect(routeUnavailable({ ...gone, usage: { prompt_tokens: 5 } })).toBe(false);
    expect(routeUnavailable({ state: 'failed', result: { ok: false, error: { status: 404, detail: 'Model not found' } } })).toBe(false);
    expect(routeUnavailable(null)).toBe(false);
  });

  it('leaves such a cell not measured under the addendum and counts it as no answer as first written', () => {
    const cells = orderCells([source(1, ROUTES[1]), source(2, ROUTES[1])], 'seed', ['F']);
    const slots = new Map([[cells[0].id, gone], [cells[1].id, broken]]);
    const raw = new Map(cells.map((cell) => [cell.id, { state: 'failed', accepted: false, correct: 0, extracted: null, reason: 'failed' }]));
    const slotOf = (cell) => slots.get(cell.id);
    const addendum = readOutcomes(cells, raw, slotOf, 'addendum');
    expect(addendum.get(cells[0].id)).toMatchObject({ state: 'pending', reason: 'route_unavailable', accepted: false });
    expect(addendum.get(cells[1].id)).toMatchObject({ state: 'done', reason: 'failed', accepted: false });
    const written = readOutcomes(cells, raw, slotOf, 'written');
    expect([...written.values()].map((row) => `${row.state} ${row.reason}`)).toEqual(['done failed', 'done failed']);
    const inputs = cells.map((cell) => cell.source);
    const verdict = (outcomes) => evaluateCriteria({ inputs, outcome: (id) => outcomes.get(id), labels: new Map(), models: [ROUTES[1]] }).c1.models[ROUTES[1]];
    expect(verdict(addendum)).toMatchObject({ incomplete: 1, verdict: 'undetermined' });
    expect(verdict(written)).toMatchObject({ incomplete: 0, verdict: 'fail' });
  });

  it('keeps other outcomes as they are', () => {
    const cells = orderCells([source(1, ROUTES[0])], 'seed', ['F']);
    const row = { state: 'done', accepted: true, correct: 1, extracted: '3', reason: 'accepted' };
    const raw = new Map([[cells[0].id, row]]);
    expect(readOutcomes(cells, raw, () => null, 'addendum').get(cells[0].id)).toBe(row);
  });

  it('finds the pinned provider in an endpoint list', () => {
    const route = { tag: 'cohere', providerName: 'Cohere' };
    expect(pinnedListed(route, [{ tag: 'tencent/fp8', provider_name: 'Tencent' }, { tag: 'novita/fp8', provider_name: 'Novita' }])).toBe(false);
    expect(pinnedListed(route, [{ tag: 'cohere', provider_name: 'Cohere' }])).toBe(true);
    expect(pinnedListed(route, [{ tag: 'cohere/fp8', provider_name: 'Cohere' }])).toBe(true);
    expect(pinnedListed({ tag: 'featherless/fp4', providerName: 'Featherless' }, [{ tag: 'featherless/fp8', provider_name: 'Other' }])).toBe(false);
  });
});

describe('finish probe v2 report: forms and money', () => {
  it('names the form of each outcome', () => {
    expect(formOf(undefined)).toBe('not finished');
    expect(formOf({ state: 'pending', reason: 'pending' })).toBe('not finished');
    expect(formOf({ state: 'unknown', reason: 'unknown' })).toBe('not finished');
    expect(formOf({ state: 'pending', reason: 'route_unavailable' })).toBe('not measured');
    expect(formOf({ state: 'done', accepted: true, reason: 'accepted' })).toBe('accepted');
    expect(formOf({ state: 'done', accepted: false, reason: 'cut' })).toBe('cut at the cap');
    expect(formOf({ state: 'done', accepted: false, reason: 'from_reasoning' })).toBe('answer only in the reasoning');
    expect(formOf({ state: 'done', accepted: false, reason: 'failed' })).toBe('call failed');
    expect(formOf({ state: 'done', accepted: false, reason: 'parse_error' })).toBe('not read by the parser');
  });

  it('counts forms by route and condition, and criterion 4 inside a route', () => {
    const sources = [source(1, ROUTES[0]), source(2, ROUTES[0]), source(3, ROUTES[1]), { ...source(4, ROUTES[0], 'synthesis'), id: 'test:x:4|synthesis:A8' }];
    const table = new Map([
      [`${sources[0].id}|F`, { state: 'done', accepted: true, correct: 1, reason: 'accepted' }],
      [`${sources[0].id}|C`, { state: 'done', accepted: false, correct: 0, reason: 'cut' }],
      [`${sources[1].id}|F`, { state: 'done', accepted: false, correct: 0, reason: 'cut' }],
      [`${sources[1].id}|C`, { state: 'done', accepted: true, correct: 1, reason: 'accepted' }],
      [`${sources[2].id}|F`, { state: 'pending', accepted: false, correct: 0, reason: 'route_unavailable' }],
      [`${sources[3].id}|F`, { state: 'done', accepted: true, correct: 0, reason: 'accepted' }],
    ]);
    const outcome = (id) => table.get(id);
    const forms = formTable(sources, outcome, ROUTES);
    expect(forms.rows).toHaveLength(6);
    const row = (route, condition) => forms.rows.find((item) => item.route === route && item.condition === condition);
    expect(row(ROUTES[0], 'F')).toMatchObject({ n: 2, accepted: 1, 'cut at the cap': 1 });
    expect(row(ROUTES[0], 'T')).toMatchObject({ n: 2, 'not finished': 2 });
    expect(row(ROUTES[1], 'F')).toMatchObject({ n: 1, 'not measured': 1 });
    expect(forms.syntheses).toMatchObject({ n: 1, accepted: 1 });
    for (const item of forms.rows) expect(FORMS.reduce((sum, name) => sum + item[name], 0)).toBe(item.n);
    expect(c4ByRoute(sources, outcome, ROUTES)).toEqual([
      { route: ROUTES[0], n: 2, measured: 2, fCorrect: 1, cCorrect: 1 },
      { route: ROUTES[1], n: 1, measured: 0, fCorrect: 0, cCorrect: 0 },
    ]);
  });

  it('splits held money by whether the call reached a model', () => {
    const events = [];
    const budget = createCampaignBudget({ maxUsd: 10, maxPosts: 10, prices: Object.fromEntries(ROUTES.map((id) => [id, { prompt: '0.000001', completion: '0.000002' }])), onEvent: (event) => events.push(event) });
    const meta = (n, model) => ({ questionId: `test:x:${n}`, branch: 'finish-F', stage: STAGE, sample: 11, model });
    const id = (m) => `${m.questionId}|${m.branch}|${m.stage}|${m.sample}|${m.model}|hash#1`;
    const lost = meta(1, ROUTES[1]);
    const cut = meta(2, ROUTES[0]);
    const paid = meta(3, ROUTES[0]);
    for (const m of [lost, cut, paid]) budget.admit({ attemptId: id(m), model: m.model, promptTokens: 1000, maxTokens: 1000 });
    budget.settle({ attemptId: id(lost), incomplete: true });
    budget.settle({ attemptId: id(paid), usage: { prompt_tokens: 1000, completion_tokens: 10, cost: 0.001 } });
    expect(keyOfAttempt(id(lost))).toBe(cellKey(lost));
    const split = heldSplit(events, { maxUsd: 10, maxPosts: 10 }, new Set([cellKey(lost)]));
    expect(split.routeUnavailableCalls).toBe(1);
    expect(split.otherCalls).toBe(1);
    expect(split.routeUnavailableUsd).toBeCloseTo(0.003, 10);
    expect(split.otherUsd).toBeCloseTo(0.003, 10);
    expect(split.routeUnavailableUsd + split.otherUsd).toBeCloseTo(budget.state.unresolvedUsd, 10);
  });
});

describe('finish probe v2 report: texts', () => {
  const verdict = (value, incomplete = 0) => ({ n: 21, correct: 9, need: 17, questionMean: 0.4, incomplete, verdict: value });
  const criteria = (hy4, decision) => ({
    c1: { models: { 'stepfun/s': { n: 80, accepted: 50, incomplete: 0, verdict: 'fail' }, 'tencent/h': hy4 }, verdict: 'fail' },
    c2: verdict('undetermined', 2),
    c3: verdict('undetermined', 4),
    c4: { fRate: 0.3, cRate: 0.05, difference: 0.25, questionMeanDifference: 0.2, margin: 10 / 115, incomplete: 16, verdict: 'undetermined' },
    decision,
  });
  const tally = { n: 115, correct: 30, wrong: 20, empty: 49, incomplete: 16 };
  const result = {
    criteria: criteria({ n: 21, accepted: 5, incomplete: 16, verdict: 'undetermined' }, 'no change: at least one of criteria 1-3 failed'),
    conditions: Object.fromEntries(['F', 'T', 'C'].map((name) => [name, { all: tally, byGroup: { firm: tally }, byRoute: { 'stepfun/s': tally } }])),
    sensitivity: { c2: verdict('fail'), c3: verdict('fail'), c4: { difference: 0.2, verdict: 'pass' } },
    leaveOneOut: [],
    fidelity: { n: 21, matches: 10 },
    policies: {},
    synthesis: { A8: { n: 9, fallback: 1, finishedAccepted: 5, finished: 2, chain: 3 }, S8: { n: 9, fallback: 3, finishedAccepted: 5, finished: 2, chain: 4 } },
  };
  const written = { criteria: criteria({ n: 21, accepted: 5, incomplete: 0, verdict: 'fail' }, 'no change: at least one of criteria 1-3 failed') };
  const form = (route, condition, values) => ({ route, condition, n: 0, ...Object.fromEntries(FORMS.map((name) => [name, 0])), ...values });
  const meta = {
    sourceRun: 'a8-open-v5e',
    budget: { settledUsd: 5, unresolvedUsd: 1.8, posts: 402 },
    v1: { settledUsd: 1.83, heldUsd: 0.14, posts: 151 },
    v2: { settledUsd: 3.17, heldUsd: 1.66, posts: 251 },
    keyDelta: 6.7,
    caps: { 'stepfun/s': 2048, 'tencent/h': 2048 },
    reasoning: { 'stepfun/s': { effort: 'low' }, 'tencent/h': { effort: 'none' } },
    origin: { cells: 363, v1Done: 112, v2: {}, resent: [{ cell: 'q|sample:2|F', v2: 'done' }] },
    labels: { knownUsd: 1.63, calls: 108, unknown: 0 },
    labelModels: { A: 'openai/a', B: 'google/b' },
    groups: { firm: 21, candidate: 12, none: 18 },
    groupsDiffer: 4,
  };
  const extra = {
    v2Done: 203, unavailable: 48, failedCalls: 0, open: 0,
    forms: {
      rows: [
        form('stepfun/s', 'F', { n: 80, accepted: 50, 'cut at the cap': 29, 'not read by the parser': 1 }),
        form('stepfun/s', 'C', { n: 80, accepted: 2, 'cut at the cap': 78 }),
        form('tencent/h', 'F', { n: 21, accepted: 5, 'not measured': 16 }),
        form('tencent/h', 'C', { n: 21, accepted: 4, 'cut at the cap': 1, 'not measured': 16 }),
      ],
      syntheses: form('stepfun/s', 'F', { n: 18, accepted: 10, 'cut at the cap': 8 }),
    },
    c4Routes: [{ route: 'stepfun/s', n: 80, measured: 80, fCorrect: 25, cCorrect: 1 }],
    held: { routeUnavailableUsd: 1.6, routeUnavailableCalls: 48, otherUsd: 0.06, otherCalls: 1 },
    labelQuestions: 11, firmQuestions: 9,
    routeCheck: { at: '2026-11-10T00:10:00.000Z', model: 'tencent/h', pinnedListed: false, listed: ['tencent/fp8'] },
    key: { first: 60.94, last: 67.64, lastAt: '2026-11-10T00:12:00.000Z', settledAll: 6.63, heldReal: 0.2 },
  };

  it('writes the README note from the numbers', () => {
    const text = renderReadme(result, written, meta, extra);
    expect(text).toContain('не выполнен хотя бы один из критериев 1–3');
    expect(text).toContain('| 1. Принятые ответы, stepfun | 50 из 80 | 90% | не выполнен |');
    expect(text).toContain('| 1. Принятые ответы, tencent | 5 из 21, не измерено 16 | 90% | не определён |');
    expect(text).toContain('| F | 115 | 30 | 20 | 49 | 16 |');
    expect(text).toContain('| stepfun | 80 | 50 | 29 | 1 | 0 |');
    expect(text).toContain('| tencent | 21 | 5 | 0 | 0 | 16 |');
    expect(text).toContain('48 ячеек получили 404');
    expect(text).toContain('в списке не появился');
    expect(text).toContain('Из 80 вызовов F не принято 30, из них 29 оборваны на лимите 2048');
    expect(text).toContain('в 78 случаях из 80');
    expect(text).not.toContain('Маршрут tencent обязан рассуждать');
    expect(text).toContain('Маршрут stepfun обязан рассуждать (наименьшее усилие low)');
    expect(text).not.toMatch(/не успевает ответить|Что дал бы больший лимит/);
    expect(text).toContain('его написала одна модель OpenRouter, а числа в нём сверила с отчётом другая');
    expect(text).toContain('удержано $0.20');
    expect(text).toContain('$1.60 числится в резерве');
    expect(text).not.toMatch(/undefined|NaN/);
  });

  it('writes the full report with both readings of point 6', () => {
    const text = renderV2Report(result, written, meta, extra);
    expect(text).toContain('48 not measured because the pinned route was unavailable');
    expect(text).toContain('| stepfun/s | F | 80 | 50 | 29 | 0 | 1 | 0 | 0 | 0 |');
    expect(text).toContain('## Point 6 of v2 as first written');
    expect(text).toContain('- 1, tencent/h: 5 of 21 accepted, 0 incomplete: fail.');
    expect(text).toContain('- 1, tencent/h: 5 of 21 accepted, 16 incomplete: undetermined.');
    expect(text).toContain('is not listed');
    expect(text).toContain('$1.6000 for 48 calls that reached no model');
    expect(text).not.toMatch(/undefined|NaN/);
  });

  it('states the whole-text comparison, the v3 draft, and the entry that reproduces it', () => {
    const same = renderReadme(result, written, meta, extra);
    expect(same).toContain('даёт те же итоги и то же решение');
    expect(same).toContain('node frontend/eval/finishProbeCli.js finish-probe-v2 --phase report');
    expect(same).not.toContain('npm --prefix frontend run eval -- finish-probe-v2');
    const differs = { ...result, floatingDifferences: [{ criterion: 'c4', exact: 'pass', floating: 'fail' }] };
    expect(renderReadme(differs, written, meta, extra)).toContain('даёт другое: c4 — не выполнен');
    const draft = { recordedAt: '2026-11-09T23:57:38.524Z', sha256: 'ab'.repeat(32), bytes: 15424, mtime: '2026-11-09T23:30:14.369Z' };
    const full = renderV2Report(differs, written, meta, { ...extra, v3PlanDraft: draft });
    expect(full).toContain('differs: c4 fail instead of pass');
    expect(full).toContain(`sha256 ${'ab'.repeat(32)}`);
    expect(renderV2Report(result, written, meta, extra)).not.toContain('draft plan');
  });
});
