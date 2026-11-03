import { describe, expect, it } from 'vitest';

import { comparePrimary, completedPairs, interpret, renderA8Report } from './a8Report.js';

function row(id, block, a8, s8, status = 'complete') {
  return {
    id,
    block,
    status,
    arms: {
      A8: { correct: a8, status: 'graded' },
      S8: { correct: s8, status: 'graded' },
      B8: { correct: s8, status: 'graded' },
    },
  };
}

describe('a8 report', () => {
  it('keeps pending rows out of the primary denominator', () => {
    const rows = [
      row('a', 'aime', 1, 0),
      row('b', 'gpqa', 0, 1),
      { id: 'c', block: 'mmlu', status: 'pending', arms: {} },
    ];
    expect(completedPairs(rows)).toHaveLength(2);
    const comparison = comparePrimary(rows);
    expect(comparison.n).toBe(2);
    expect(comparison.wins).toBe(1);
    expect(comparison.losses).toBe(1);
    expect(interpret(comparison, 120, false)).toMatch(/incomplete/);
  });

  it('does not turn a degenerate zero interval into equivalence', () => {
    const rows = [row('a', 'aime', 1, 1)];
    const comparison = comparePrimary(rows);
    expect(comparison.interval.degenerate).toBe(true);
    expect(interpret(comparison, 1, true)).toMatch(/degenerate/);
    const text = renderA8Report({ rows, planned: 1, complete: true, spend: { settledUsd: 1, unresolvedUsd: 0, posts: 2 } });
    expect(text).toContain('A8 against S8');
    expect(text).not.toContain('equivalent');
  });
});
