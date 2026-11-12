import { describe, expect, it } from 'vitest';

import { buildNote } from './finishProbeV4Readme.js';

const forms = (notMeasured, waiting) => ({
  rows: [{ 'not measured': notMeasured, 'not sent or waiting': waiting }],
  syntheses: { 'not measured': 0, 'not sent or waiting': 0 },
});

describe('finish probe v4 README note', () => {
  it('corrects the frozen wording when a criterion it calls held was not evaluable', () => {
    const result = { decision: { code: 'accepted_often_wrong', arms: [] }, k4: { verdict: 'not_evaluable' }, kp: { verdict: 'fail' }, kw: { verdict: 'pass' }, forms: forms(1, 0) };
    const note = buildNote({ result }, [{ kind: 'run', end: 'route_unavailable', blocked: ['d/seek'] }, { kind: 'run', end: 'done', blocked: [] }]);
    expect(note).toContain('Запусков прогона: 2');
    expect(note).toContain('маршрут не спрашивался до конца запуска: d/seek');
    expect(note).toContain('без измерения');
    expect(note).toContain('K4 не определён');
  });

  it('adds no correction when the named criteria held', () => {
    const result = { decision: { code: 'accepted_often_wrong', arms: [] }, k4: { verdict: 'pass' }, kp: { verdict: 'fail' }, kw: { verdict: 'pass' }, forms: forms(0, 0) };
    const note = buildNote({ result }, [{ kind: 'run', end: 'done' }]);
    expect(note).not.toContain('Поправка');
    expect(note).not.toContain('Запусков');
  });

  it('checks every criterion the decision text names', () => {
    const result = { decision: { code: 'confirmed_for_arms', arms: ['B8'] }, k4: { verdict: 'pass' }, kp: { verdict: 'not_evaluable' }, kw: { verdict: 'pass' }, forms: forms(0, 0) };
    expect(buildNote({ result }, [])).toContain('KP не определён');
  });
});
