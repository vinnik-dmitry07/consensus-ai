import { describe, expect, it } from 'vitest';

import { compareSecondary, comparePrimary, completedPairs, interpret, renderA8Report } from './a8Report.js';

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

function rowWithVote(id, block, correct) {
  return {
    id,
    block,
    status: 'complete',
    arms: {
      A8: { correct: correct.A8, status: 'graded' },
      S8: { correct: correct.S8, status: 'graded' },
      P8: { correct: correct.P8, status: 'graded' },
      B8: { correct: correct.S8, status: 'graded' },
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

  it('adds P8 and the secondary pairs only when the rows carry the vote arm', () => {
    const pairs = [['P8', 'S8'], ['P8', 'A8']];
    const rows = [
      rowWithVote('a', 'aime', { A8: 1, S8: 0, P8: 1 }),
      rowWithVote('b', 'gpqa', { A8: 0, S8: 1, P8: 1 }),
      rowWithVote('c', 'mmlu', { A8: 1, S8: 1, P8: 0 }),
    ];
    const text = renderA8Report({
      rows,
      planned: 3,
      complete: true,
      secondaryPairs: pairs,
      stageCaps: { stage1: 8192, sample: 8192, stage2: 16384, stage3: 16384 },
      streamTimeoutSeconds: 2168,
      armRules: { a8RequiresFullCouncil: true, s8RequiresAllSamples: true, p8RequiresFullCouncil: true },
    });
    expect(text).toContain('| P8 |');
    expect(text).toContain('P8 − S8');
    expect(text).toContain('P8 − A8');
    expect(text).toContain('Holm p');
    expect(text).toContain('Stage 2 judges 16384');
    expect(text).toContain('Stream deadline 2168 s');
    expect(text).toContain('P8 needs all three');
    const secondary = compareSecondary(rows, pairs);
    expect(secondary).toHaveLength(2);
    expect(secondary[0].n).toBe(3);
    expect(secondary[0].holmP).toBeGreaterThanOrEqual(secondary[0].p);
    const plain = renderA8Report({ rows: [row('a', 'aime', 1, 0)], planned: 1, complete: true, secondaryPairs: pairs });
    expect(plain).not.toContain('| P8 |');
    expect(plain).not.toContain('Secondary pairs');
  });
});
