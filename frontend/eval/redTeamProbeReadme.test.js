import { describe, expect, it } from 'vitest';

import { interpretPair } from './redTeamProbe.js';
import { readingRu, renderReadme } from './redTeamProbeReadme.js';

const interval = (low, high) => ({ low, high, degenerate: false });

describe('redteam probe README', () => {
  it('turns every reading line of interpretPair into Russian', () => {
    const cases = [
      { n: 269, wins: 20, losses: 2, delta: 18 / 269, p: 0.0001, interval: interval(0.06, 0.1), interval90: interval(0.065, 0.09) },
      { n: 269, wins: 2, losses: 20, delta: -18 / 269, p: 0.0001, interval: interval(-0.1, -0.06), interval90: interval(-0.09, -0.065) },
      { n: 269, wins: 3, losses: 4, delta: -1 / 269, p: 1, interval: interval(-0.02, 0.015), interval90: interval(-0.015, 0.01) },
      { n: 269, wins: 9, losses: 1, delta: 8 / 269, p: 0.02, interval: interval(0.01, 0.06), interval90: interval(0.012, 0.055) },
      { n: 269, wins: 0, losses: 0, delta: 0, p: 1, interval: { low: 0, high: 0, degenerate: true }, interval90: { low: 0, high: 0, degenerate: true } },
      { n: 269, wins: 2, losses: 1, delta: 1 / 269, p: 1, interval: interval(-0.01, 0.02), interval90: { low: 0, high: 0, degenerate: true } },
    ];
    const lines = [...cases.flatMap((item) => interpretPair(item, 269, true, 'Rc', 'C')), ...interpretPair(cases[0], 269, false, 'Rc', 'C')];
    for (const line of lines) expect(readingRu(line), line).not.toBe(line);
    expect(readingRu('something else')).toBe('something else');
  });

  it('renders a block from an empty report without failing', () => {
    const empty = { n: 0, wins: 0, losses: 0, ties: 0, delta: null, p: 1, interval: { low: null, high: null, degenerate: true }, interval90: { low: null, high: null, degenerate: true } };
    const layer = { n: 0, wins: 0, losses: 0, delta: null };
    const report = {
      meta: { source: 'a8-open-v5e', routes: 'a8-routes-v7', planned: 269, measured: 0, complete: false, frozen: '8adbc8412ef6', spend: { settledUsd: 0, heldUsd: 0, posts: 0 } },
      primary: { ...empty, accuracy: { C: null, Rc: null }, constructionTies: 0, observedTies: 0, reading: ['interim: the primary set is incomplete, so this is not a final claim'] },
      secondary: [{ name: 'G - C', ...empty, holm: 1 }],
      policyG: { call: 0, skip: 0, accuracy: null, rcMinusG: layer, calledLayer: layer, skippedLayer: layer, cost: { cOnly: 0, g: 0, always: 0 } },
      diagnostics: { byVerdict: {}, rtEndings: {}, policyUsd: 0 },
    };
    const block = renderReadme(report, [{ name: 'as run', summary: { questions: 120, wins: 3, losses: 8, capLosses: 4 } }]);
    expect(block).toContain('Измерено 0 из 269');
    expect(block).toContain('| G − C | 0 | н/д |');
    expect(block).toContain('| as run | 120 | 3 | 8 | 4 |');
  });
});
