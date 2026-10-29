import { describe, expect, it } from 'vitest';

import { buildBank, findOverlap, hamiltonQuotas, normalizeAime, permuteChoices } from './datasets.js';
import { gradeResponse } from './grade.js';

describe('exact grading', () => {
  it('keeps the gold choice attached to the same text after a permutation', () => {
    const choices = [
      { text: 'right', correct: true },
      { text: 'no-1', correct: false },
      { text: 'no-2', correct: false },
      { text: 'no-3', correct: false },
    ];
    const once = permuteChoices(choices, 'item-1', 'seed');
    const twice = permuteChoices(choices, 'item-1', 'seed');
    expect(twice).toEqual(once);
    expect(once.options.find((option) => option.letter === once.goldLetter).text).toBe('right');
  });

  it('reads only the last answer line', () => {
    const numeric = { kind: 'integer', goldCanon: '7', choiceCount: 0 };
    const buried = gradeResponse(numeric, 'The answer is 42 and option A.\nANSWER: 007');
    expect(buried.extracted).toBe('7');
    expect(buried.correct).toBe(1);
    expect(gradeResponse(numeric, '42\nThe answer is 42').status).toBe('parse_error');
    expect(gradeResponse(numeric, 'ANSWER: +7').status).toBe('parse_error');
    expect(gradeResponse(numeric, 'ANSWER: 7.0').status).toBe('parse_error');

    const choice = { kind: 'choice', goldCanon: 'C', choiceCount: 4 };
    expect(gradeResponse(choice, 'Option A is tempting.\nANSWER: C').extracted).toBe('C');
    expect(gradeResponse(choice, 'I choose A').status).toBe('parse_error');
    expect(gradeResponse(choice, 'I cannot answer this.').status).toBe('refusal');
  });

  it('accepts AIME leading zeros and rejects a short bank', () => {
    expect(normalizeAime({ problem: 'Three plus four', answer: '007', id: 'p' }, 'aime2025').goldCanon).toBe('7');
    expect(() => buildBank({
      aime2025: [],
      aime2026: [],
      gpqa: [],
      mmluValidation: [],
      mmluTest: [],
    })).toThrow(/Need 8/);
  });

  it('allocates equal Hamilton remainders by category name', () => {
    expect(hamiltonQuotas({ a: 10, b: 10, c: 10 }, 5)).toEqual({ a: 2, b: 2, c: 1 });
  });

  it('rejects shared text and accepts disjoint splits', () => {
    expect(findOverlap({
      left: [{ dataset: 'a', sourceId: '1', fingerprint: 'same' }],
      right: [{ dataset: 'b', sourceId: '2', fingerprint: 'same' }],
    })).toHaveLength(1);
    expect(findOverlap({
      left: [{ dataset: 'a', sourceId: '1', fingerprint: 'one' }],
      right: [{ dataset: 'b', sourceId: '2', fingerprint: 'two' }],
    })).toHaveLength(0);

    const aime = (prefix, count) => Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`,
      problem: `${prefix} problem ${index}`,
      answer: String(index % 1000),
    }));
    const gpqa = Array.from({ length: 60 }, (_, index) => ({
      id: `g-${index}`,
      Question: `GPQA stem ${index}`,
      'Correct Answer': 'correct',
      'Incorrect Answer 1': 'no1',
      'Incorrect Answer 2': 'no2',
      'Incorrect Answer 3': 'no3',
    }));
    const categories = ['bio', 'chem', 'cs', 'econ', 'hist', 'law', 'math', 'phys'];
    const mmluRow = (category, index) => ({
      question_id: `${category}-${index}`,
      question: `${category} question ${index}`,
      options: ['aa', 'bb', 'cc', 'dd'],
      answer: 1,
      category,
    });
    const bank = buildBank({
      aime2025: aime('dev', 8),
      aime2026: aime('test', 30),
      gpqa,
      mmluValidation: categories.map((category) => mmluRow(category, 0)),
      mmluTest: categories.flatMap((category) => (
        Array.from({ length: 5 }, (_, index) => mmluRow(category, index + 1))
      )),
    });
    expect(bank.counts).toEqual({ dev: 24, test: 120, smoke: 2 });
    const ids = bank.items.map((item) => `${item.split}:${item.dataset}:${item.sourceId}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => buildBank({
      aime2025: aime('same', 8),
      aime2026: [{ id: 'overlap', problem: 'same problem 0', answer: '1' }, ...aime('year', 29)],
      gpqa,
      mmluValidation: categories.map((category) => mmluRow(category, 0)),
      mmluTest: categories.flatMap((category) => (
        Array.from({ length: 5 }, (_, index) => mmluRow(category, index + 1))
      )),
    })).toThrow(/overlap/);
  });
});
