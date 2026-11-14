import { describe, expect, it } from 'vitest';

import { interpretV5 } from './a8Report.js';
import {
  captureCall, cellsToSend, cleanReading, cleanRedTeam, measuredPrefix, primaryState, productRedTeam, productState,
  requestHash, routeProblems, rtOutcome, seededOrder,
} from './redTeamProbe.js';

const completed = (content, finishReason = 'stop', extra = {}) => ({ state: 'completed', result: { ok: true, content, finishReason, ...extra } });

describe('redteam probe: clean reading of a reply', () => {
  it('takes the last valid VERDICT and CONFIDENCE lines and drops the earlier ones and the template', () => {
    const text = 'Critique.\nVERDICT: REFUTED | CONTESTED | UPHELD\nCONFIDENCE: <0-10>\nVERDICT: CONTESTED\nCONFIDENCE: 4\nMore.\n**VERDICT:** UPHELD\nCONFIDENCE: 8/10';
    const reading = cleanReading(text);
    expect(reading.verdict).toBe('UPHELD');
    expect(reading.confidence).toBe(8);
    expect(reading.critique).toBe('Critique.\nMore.\n**VERDICT:** UPHELD\nCONFIDENCE: 8/10');
    expect(reading.counts).toMatchObject({ templates: 2, duplicates: 2, verdictLines: 2, confidenceLines: 2 });
  });

  it('leaves the verdict empty instead of CONTESTED, and does not clamp a confidence out of range', () => {
    const reading = cleanReading('No final line here.\nCONFIDENCE: 15\nVERDICT: UPHELD.');
    expect(reading.verdict).toBeNull();
    expect(reading.confidence).toBeNull();
    expect(reading.counts).toMatchObject({ invalidConfidence: 1, otherVerdictLike: 1 });
    expect(reading.critique).toBe('No final line here.\nCONFIDENCE: 15\nVERDICT: UPHELD.');
  });

  it('keeps CRLF lines byte for byte', () => {
    const reading = cleanReading('A\r\nVERDICT: REFUTED\r\nB\r\nVERDICT: upheld\r\n');
    expect(reading.verdict).toBe('UPHELD');
    expect(reading.critique).toBe('A\r\nB\r\nVERDICT: upheld\r\n');
  });
});

describe('redteam probe: the RT outcome and the clean object', () => {
  it('admits only a finished reply with visible text', () => {
    expect(rtOutcome(completed('x'))).toEqual({ state: 'done', usable: true, reason: 'stop' });
    expect(rtOutcome(completed('x', 'length')).reason).toBe('cap');
    expect(rtOutcome(completed('x', 'loop')).reason).toBe('loop');
    expect(rtOutcome(completed('x', 'stop', { contentFromReasoning: true })).reason).toBe('reasoning_only');
    expect(rtOutcome(completed('x', null)).reason).toBe('finish_unknown');
    expect(rtOutcome({ state: 'failed', result: { ok: false, error: { kind: 'total' } } })).toEqual({ state: 'done', usable: false, reason: 'failed' });
  });

  it('keeps a route that is not listed, a waiting call and a missing call out of the measured set', () => {
    const notListed = { state: 'failed', result: { ok: false, error: { status: 404, detail: 'No endpoints found matching your data policy' } } };
    expect(rtOutcome(notListed).state).toBe('unmeasured');
    expect(rtOutcome({ state: 'skipped', result: { ok: false, skipped: true } }).state).toBe('pending');
    expect(rtOutcome({ state: 'unknown' }).state).toBe('pending');
    expect(rtOutcome(null).state).toBe('pending');
  });

  it('gives Rc nothing for an unusable or empty reply, and the cleaned critique otherwise', () => {
    expect(cleanRedTeam({ state: 'done', usable: false, reason: 'cap' }, { content: 'x' }, 'm/a', 0, false).object).toBeNull();
    expect(cleanRedTeam({ state: 'done', usable: true, reason: 'stop' }, { content: 'VERDICT: REFUTED | CONTESTED | UPHELD\n' }, 'm/a', 0, false).reason).toBe('empty_after_cleaning');
    const admitted = cleanRedTeam({ state: 'done', usable: true, reason: 'stop' }, { content: 'Fine.\nVERDICT: UPHELD', usage: { cost: 1 } }, 'm/a', 2, true);
    expect(admitted.object).toEqual({ model: 'm/a', target_index: 2, critique: 'Fine.\nVERDICT: UPHELD', verdict: 'UPHELD', confidence: null, usage: { cost: 1 }, same_family: true });
  });
});

describe('redteam probe: the product object', () => {
  const question = {
    prompt: 'Q?',
    forwarded: [{ model: 'alpha/one', response: 'A' }, { model: 'beta/two', response: 'B' }],
    leaderIndex: 0,
    ranked: { responseRankings: [{ index: 0, model: 'alpha/one' }, { index: 1, model: 'beta/two' }] },
    roster: { councilModels: ['alpha/one', 'beta/two'], chairmanModel: 'beta/two', redTeamModel: null, topK: 2, selfExclusion: true, strictChairman: true },
  };

  it('reads the first match and defaults to CONTESTED, as the engine does', async () => {
    expect((await productRedTeam(question, { ok: true, content: 'cut before the end' })).verdict).toBe('CONTESTED');
    expect((await productRedTeam(question, { ok: true, content: 'VERDICT: REFUTED | CONTESTED | UPHELD\nVERDICT: UPHELD' })).verdict).toBe('REFUTED');
    const failed = await productRedTeam(question, { ok: false, error: { message: 'boom' } });
    expect(failed).toMatchObject({ verdict: null, critique: '', error: { message: 'boom' } });
    expect(await productRedTeam(question, { ok: false, skipped: true })).toBeNull();
  });

  it('captures the red-team request without sending it', async () => {
    const { call } = await captureCall(async () => {
      const { queryModelResult } = await import('../src/engine/browser/openrouter.js');
      return queryModelResult('beta/two', [{ role: 'user', content: 'hi' }], {});
    });
    expect(call).toMatchObject({ model: 'beta/two', messages: [{ role: 'user', content: 'hi' }] });
  });
});

describe('redteam probe: cells, aliases and the prefix', () => {
  const slot = (state) => ({ state, result: state === 'completed' ? { ok: true, content: 'x', finishReason: 'stop' } : { ok: false } });
  const plan = ({ rt = slot('completed'), c = null, rc = 'alias', rp = null } = {}) => ({
    question: { id: 'q1' },
    rt: { branch: 'RT', slot: rt, outcome: rtOutcome(rt), call: { model: 'm/a' } },
    c: { branch: 'C', slot: c, call: { model: 'm/a' } },
    rc: rc === 'alias' ? { branch: 'C', slot: c, alias: 'C', call: { model: 'm/a' } } : { branch: 'Rc', slot: rc, call: { model: 'm/a' } },
    rp: rp === 'alias' ? { branch: 'C', slot: c, alias: 'C' } : rp ? { branch: 'Rp', slot: rp, call: { model: 'm/a' } } : null,
  });

  it('sends RT first, then C and an own Rc, never an alias and never an ended cell', () => {
    expect(cellsToSend(plan({ rt: null })).map((item) => item.branch)).toEqual(['RT']);
    expect(cellsToSend(plan({ rc: 'alias' })).map((item) => item.branch)).toEqual(['C']);
    expect(cellsToSend(plan({ rc: null })).map((item) => item.branch).sort()).toEqual(['C', 'Rc']);
    expect(cellsToSend(plan({ c: slot('completed'), rc: slot('failed') }))).toEqual([]);
    expect(cellsToSend(plan({ rp: null }), { product: true })).toEqual([]);
    expect(cellsToSend(plan({ c: slot('completed'), rp: 'alias' }), { product: true })).toEqual([]);
  });

  it('measures a question when C and Rc ended, and Rp apart', () => {
    expect(primaryState(plan({ c: slot('completed') }))).toBe('measured');
    expect(primaryState(plan({ c: slot('completed'), rc: null }))).toBe('pending');
    expect(primaryState(plan({ rt: { state: 'skipped' } }))).toBe('pending');
    expect(productState(plan({ c: slot('completed'), rp: slot('completed') }))).toBe('measured');
    expect(measuredPrefix(['a', 'b', 'c'], (id) => (id === 'b' ? 'pending' : 'measured'))).toEqual(['a']);
  });

  it('tells requests apart by model, stage and messages', () => {
    const prepare = (model, stage) => ({ maxTokens: stage === 'redteam' ? 7 : 9, provider: { order: [model] } });
    const base = { model: 'm/a', messages: [{ role: 'user', content: 'x' }], options: {} };
    expect(requestHash(prepare, base, 'stage3')).toBe(requestHash(prepare, { ...base }, 'stage3'));
    expect(requestHash(prepare, base, 'stage3')).not.toBe(requestHash(prepare, base, 'redteam'));
    expect(requestHash(prepare, base, 'stage3')).not.toBe(requestHash(prepare, { ...base, model: 'm/b' }, 'stage3'));
  });

  it('orders ids by a seed, the same every time', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(seededOrder(ids)).toEqual(seededOrder([...ids].reverse()));
    expect([...seededOrder(ids)].sort()).toEqual(ids);
  });
});

describe('redteam probe: routes and reading', () => {
  const route = { provider: { order: ['host/x'] }, tag: 'host/x', providerName: 'Host', pricing: { prompt: '0.000001', completion: '0.000002' } };
  const endpoint = (extra = {}) => ({
    tag: 'host/x', provider_name: 'Host', status: 0, context_length: 100000, max_completion_tokens: 50000,
    supported_parameters: ['max_tokens', 'temperature', 'top_p'], pricing: { prompt: '0.000001', completion: '0.000002' }, ...extra,
  });

  it('blocks a host that is not listed, down, missing a parameter, too small or dearer', () => {
    expect(routeProblems(route, { endpoints: [endpoint()] }, 1000, 32768)).toEqual([]);
    expect(routeProblems(route, { endpoints: [] }, 1000)).toEqual(['not listed']);
    expect(routeProblems(route, { endpoints: [endpoint({ status: -5 })] }, 1000)).toEqual(['status -5']);
    expect(routeProblems(route, { endpoints: [endpoint({ supported_parameters: ['max_tokens'] })] }, 1000)).toEqual(['parameters: temperature, top_p']);
    expect(routeProblems(route, { endpoints: [endpoint({ context_length: 20000 })] }, 1000)).toEqual(['context']);
    expect(routeProblems(route, { endpoints: [endpoint({ pricing: { prompt: '0.00001', completion: '0.000002' } })] }, 1000)).toEqual(['price']);
  });

  it('reads a pair with the v5 rules', async () => {
    const { interpretPair } = await import('./redTeamProbe.js');
    const cases = [
      { n: 269, wins: 20, losses: 2, delta: 18 / 269, p: 0.0001, interval: { low: 0.03, high: 0.1, degenerate: false }, interval90: { low: 0.04, high: 0.09, degenerate: false } },
      { n: 269, wins: 3, losses: 4, delta: -1 / 269, p: 1, interval: { low: -0.02, high: 0.015, degenerate: false }, interval90: { low: -0.015, high: 0.01, degenerate: false } },
      { n: 269, wins: 0, losses: 0, delta: 0, p: 1, interval: { low: 0, high: 0, degenerate: true }, interval90: { low: 0, high: 0, degenerate: true } },
    ];
    for (const item of cases) expect(interpretPair(item, 269, true, 'A8', 'S8')).toEqual(interpretV5(item, 269, true));
    expect(interpretPair(cases[0], 269, false, 'Rc', 'C')[0]).toMatch(/^interim/);
  });
});
