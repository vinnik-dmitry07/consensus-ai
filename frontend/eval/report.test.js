import { describe, expect, it } from 'vitest';

import {
  analyze,
  armStatuses,
  classifyEffect,
  holm,
  mcnemarExact,
  pairedBootstrap,
  renderSummary,
  replaceSection,
} from './report.js';

function row(block, arms, extra = {}) {
  return {
    block,
    status: 'complete',
    pending: false,
    arms,
    ...extra,
  };
}

describe('paired analysis', () => {
  it('computes the two-sided exact McNemar probability', () => {
    expect(mcnemarExact(8, 2).p).toBe(0.109375);
    expect(mcnemarExact(0, 0).p).toBe(1);
  });

  it('adjusts Holm thresholds without reordering the result', () => {
    expect(holm([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
  });

  it('does not treat a zero-width interval as evidence against a gain', () => {
    expect(classifyEffect({ low: 0, high: 0, degenerate: true })).toBe('insufficient');
    const tied = [row('aime', { A6: { correct: 1 }, A1: { correct: 1 } })];
    const analysis = analyze(tied, { alternatives: ['A1'] });
    expect(analysis.family[0].familyClaim).toBe('insufficient');
    expect(analysis.family[0].delta).toBe(0);
    expect(analysis.confidenceAboutLeader.buckets.HIGH.n).toBe(0);
    expect(analysis.confidenceAboutLeader.buckets.HIGH.validated).toBe(false);
    expect(analysis.scored).toBe(1);
    expect(analyze([]).scored).toBe(0);
  });

  it('flips the sign when the pair is swapped and keeps the bootstrap seed', () => {
    const rows = [
      row('aime', { A6: { correct: 1 }, A1: { correct: 0 } }),
      row('aime', { A6: { correct: 0 }, A1: { correct: 1 } }),
      row('gpqa', { A6: { correct: 1 }, A1: { correct: 0 } }),
      row('mmlu', { A6: { correct: 1 }, A1: { correct: 1 } }),
    ];
    const forward = analyze(rows, { alternatives: ['A1'] });
    const swapped = analyze(rows.map((item) => ({
      ...item,
      arms: { A6: item.arms.A1, A1: item.arms.A6 },
    })), { alternatives: ['A1'] });
    expect(forward.family[0].delta).toBeGreaterThan(0);
    expect(swapped.family[0].delta).toBe(-forward.family[0].delta);
    const first = pairedBootstrap(rows, 'A6', 'A1', { reps: 40, tails: [0.025, 0.005] });
    const second = pairedBootstrap(rows, 'A6', 'A1', { reps: 40, tails: [0.025, 0.005] });
    expect(second[0]).toEqual(first[0]);
    expect(first[1].high).toBeGreaterThanOrEqual(first[0].high);
    expect(first[1].low).toBeLessThanOrEqual(first[0].low);
  });
});

describe('interim summary', () => {
  const rows = [
    row('aime', {
      A1: { correct: 1, status: 'graded' },
      A6: { correct: 1, status: 'graded', fallback: true },
      A7: { correct: 0, status: 'parse_error' },
    }, { rankingFallback: true }),
    row('gpqa', {
      A1: { correct: 0, status: 'timeout' },
      A6: { correct: 0, status: 'graded' },
      A7: { correct: 0, status: 'not_run' },
    }),
    { block: 'mmlu', status: 'paused', pending: true, arms: {} },
  ];

  it('counts failure modes per arm and separates pending from not started', () => {
    const analysis = analyze(rows, { alternatives: ['A1'], expected: 10 });
    expect(analysis.scored).toBe(2);
    expect(analysis.pending).toBe(1);
    expect(analysis.notStarted).toBe(7);
    expect(analysis.scoredByBlock).toEqual({ aime: 1, gpqa: 1, mmlu: 0 });
    expect(analysis.rankingFallback).toBe(1);
    const status = armStatuses(rows.slice(0, 2));
    expect(status.A1).toMatchObject({ correct: 1, wrong: 0, transport: 1 });
    expect(status.A6).toMatchObject({ correct: 1, wrong: 1, fallback: 1 });
    expect(status.A7).toMatchObject({ parse_error: 1, not_run: 1 });
    expect(status.A2.missing).toBe(2);
  });

  it('labels an incomplete run as interim and a complete one as final', () => {
    const analysis = analyze(rows, { alternatives: ['A1'], expected: 10 });
    const interim = renderSummary(analysis, { complete: false, blockTotals: { aime: 3, gpqa: 3, mmlu: 4 } });
    expect(interim).toContain('interim snapshot, 2 of 10 test questions');
    expect(interim).toContain('7 questions are not started and 1 are paused');
    expect(interim).toContain('AIME 2026 1/3, GPQA Diamond 1/3, MMLU-Pro 0/4');
    expect(interim).toContain('| A6 − A1 |');
    expect(interim).not.toContain('undefined');
    const done = analyze(rows.slice(0, 2), { alternatives: ['A1'], expected: 2 });
    const final = renderSummary(done, { complete: true });
    expect(final).toContain('final result on 2 test questions');
  });

  it('replaces only the text between the README markers', () => {
    const text = 'before\n<!-- a -->\nold\n<!-- b -->\nafter';
    expect(replaceSection(text, '<!-- a -->', '<!-- b -->', 'new')).toBe('before\n<!-- a -->\nnew\n<!-- b -->\nafter');
    expect(replaceSection('no markers', '<!-- a -->', '<!-- b -->', 'new')).toBe(null);
  });

  it('renders the as-run table and the paid repair table', () => {
    const analysis = analyze(rows.slice(0, 2), { alternatives: ['A1'], expected: 2 });
    const text = renderSummary(analysis, {
      complete: true,
      networkOutageQuestions: 3,
      repaired: analysis,
      nominal: { A0: 1, A1: 1, A2: 5, A3: 6, A4: 5, A5: 10, A6: 12, A7: 11 },
      repair: {
        reusedSlots: 4,
        liveSlots: 2,
        paidPosts: 2,
        freePosts: 0,
        usdEstimate: 0.125,
        keySpend: 0.2,
        usageUnknownCharged: 1,
        amendment: 'secondary layer',
        mapping: { 'alpha/a:free': 'alpha/a' },
      },
    });
    expect(text).toContain('As run on free endpoints');
    expect(text).toContain('Transport failures retried via paid endpoints');
    expect(text).toContain('3 questions had every Stage 1 call fail');
    expect(text).toContain('secondary layer');
    expect(text).toContain('`alpha/a:free` → `alpha/a`');
    expect(text).toContain('key usage counter): $0.2000');
    expect(text).not.toContain('undefined');
  });

  it('counts a lenient read and an exhausted redraw as subsets of correct and wrong', () => {
    const status = armStatuses([
      row('aime', {
        A1: { correct: 0, status: 'no_answer', exhausted: true },
        A6: { correct: 1, status: 'graded', lenient: true, via: 'boxed' },
      }),
    ]);
    expect(status.A1).toMatchObject({ wrong: 1, exhausted: 1, no_answer: 0 });
    expect(status.A6).toMatchObject({ correct: 1, lenientCorrect: 1, lenientWrong: 0 });
    const analysis = analyze([
      row('aime', {
        A1: { correct: 0, status: 'no_answer', exhausted: true },
        A6: { correct: 1, status: 'graded', lenient: true },
      }),
      row('gpqa', {
        A1: { correct: 1, status: 'graded', resampled: 2 },
        A6: { correct: 0, status: 'graded', resampled: 1 },
      }),
    ], { alternatives: ['A1'], expected: 2 });
    const text = renderSummary(analysis, {
      complete: true,
      completed: analysis,
      completion: {
        attempts: 3,
        lenientRules: 'lenient-v1: one unambiguous answer',
        amendment: 'answer-complete layer',
        reusedSlots: 9,
        resamplePosts: 4,
        resampledCells: 2,
        exhaustedCells: 1,
        usdEstimate: 0.5,
        keySpend: 0.4,
        usageUnknownCharged: 0,
      },
    });
    expect(text).toContain('Every cell answered: lenient read + re-sampled non-answers');
    expect(text).toContain('No answer after 4 samples (scored wrong)');
    expect(text).toContain('lenient-v1: one unambiguous answer');
    expect(text).toContain('answer-complete layer');
    expect(text).not.toContain('undefined');
  });
});
