import { describe, expect, it } from 'vitest';

import { evaluateCriteria } from './finishProbe.js';
import { evaluateExact, leaveOneOutExact, needOf, verdictDifferences } from './finishProbeCriteria.js';

const MODEL = 'a/one';

// n inputs in distinct questions; the first `f` are right under F and the
// first `c` under C. Every call is finished and accepted.
function setup(n, f, c, extra = {}) {
  const inputs = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, questionId: `q${i}`, model: MODEL }));
  const outcomes = new Map();
  inputs.forEach((item, i) => {
    outcomes.set(`${item.id}|F`, { state: 'done', accepted: true, correct: i < f ? 1 : 0 });
    outcomes.set(`${item.id}|C`, { state: 'done', accepted: true, correct: i < c ? 1 : 0 });
  });
  return { inputs, outcome: (id) => outcomes.get(id), labels: extra.labels || new Map(), models: [MODEL] };
}

describe('finish probe criteria in whole texts', () => {
  it('passes criterion 4 at exactly 10 of 115 for every pair, where the shares can fail', () => {
    let floatingFails = 0;
    for (let c = 0; c + 10 <= 115; c += 1) {
      const args = setup(115, c + 10, c);
      expect(evaluateExact(args).c4.verdict).toBe('pass');
      if (evaluateCriteria(args).c4.verdict !== 'pass') floatingFails += 1;
    }
    expect(floatingFails).toBeGreaterThan(0);
    expect(evaluateExact(setup(115, 40, 31)).c4.verdict).toBe('fail');
  });

  it('needs the integer counts of the plan', () => {
    expect(needOf(25, 8, 10)).toBe(20);
    expect(needOf(21, 8, 10)).toBe(17);
    expect(needOf(31, 5, 10)).toBe(16);
    expect(needOf(33, 5, 10)).toBe(17);
    for (let n = 1; n <= 140; n += 1) expect(needOf(n, 8, 10)).toBe(Math.ceil((8 * n) / 10));
    const accepted = (k) => {
      const args = setup(80, 0, 0);
      const outcome = (id) => {
        const index = Number(id.slice(1).split('|')[0]);
        return id.endsWith('|F') ? { state: 'done', accepted: index < k, correct: 0 } : args.outcome(id);
      };
      return evaluateExact({ ...args, outcome }).c1.models[MODEL].verdict;
    };
    expect(accepted(72)).toBe('pass');
    expect(accepted(71)).toBe('fail');
  });

  it('agrees with the v1 code away from a threshold, decision included', () => {
    const labels = new Map(Array.from({ length: 20 }, (_, i) => [`s${i}`, i < 12 ? 'firm' : 'candidate']));
    for (const [f, c] of [[60, 20], [30, 25], [5, 0], [100, 100]]) {
      const args = setup(115, f, c, { labels });
      const exact = evaluateExact(args);
      const floating = evaluateCriteria(args);
      expect(verdictDifferences(exact, floating)).toEqual([]);
      expect(exact.decision).toBe(floating.decision);
    }
  });

  it('leaves an incomplete set undetermined and names a flip when a question is left out', () => {
    const args = setup(115, 30, 20);
    const outcome = (id) => (id === 's0|F' ? { state: 'unknown', accepted: false, correct: 0 } : args.outcome(id));
    expect(evaluateExact({ ...args, outcome }).c4.verdict).toBe('undetermined');
    const edge = setup(115, 10, 0);
    const flips = leaveOneOutExact(edge);
    expect(flips.some((row) => row.criterion === 'c4' && row.to === 'fail')).toBe(true);
  });
});
