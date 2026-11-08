import { describe, expect, it } from 'vitest';

import { ANSWER_INSTRUCTIONS } from './protocol.js';
import {
  answerPrompt,
  canonAnswer,
  canonNumber,
  failureKind,
  gradeResponse,
  gradeResponseLenient,
  NUMBER_INSTRUCTIONS,
  plurality,
} from './grade.js';

const NUMBER = { kind: 'number', goldCanon: '3/4', stem: 'q', choiceCount: 0 };

describe('exact number answers', () => {
  it.each([
    ['12', '12'],
    ['-12', '-12'],
    ['+7', '7'],
    ['007', '7'],
    ['123456789012345678901234567890', '123456789012345678901234567890'],
    ['-0', '0'],
    ['3/4', '3/4'],
    ['6/8', '3/4'],
    ['-6/8', '-3/4'],
    ['0/5', '0'],
    ['4/2', '2'],
    [String.raw`\frac{512}{375}`, '512/375'],
    [String.raw`-\frac{1}{21}`, '-1/21'],
    [String.raw`\dfrac{-2}{4}`, '-1/2'],
    [String.raw`-\tfrac{-2}{4}`, '1/2'],
    [String.raw`\frac{ 4 }{ 2 }`, '2'],
    ['0.25', '1/4'],
    ['-.5', '-1/2'],
    ['2.50', '5/2'],
    [String.raw`$\boxed{3/4}$`, '3/4'],
    [String.raw`$\boxed{\frac{3}{4}}$`, '3/4'],
    [String.raw`\(7\)`, '7'],
    [String.raw`\[ -\frac{5}{3} \]`, '-5/3'],
    ['12.', '12'],
    ['−3', '-3'],
    [String.raw`1\,000`, '1000'],
  ])('reads %s as %s', (raw, canon) => {
    expect(canonNumber(raw)).toBe(canon);
  });

  it.each([
    '5/0',
    '2 3',
    '(0,1)',
    String.raw`4\pi`,
    'x=5',
    'IIII',
    'xiv',
    'VX',
    '2,3',
    '4, 6, 8',
    '12,34',
    '2^x',
    '3/4 or 1',
    '',
    String.raw`\sqrt{2}`,
    '1e3',
  ])('rejects %s', (raw) => {
    expect(canonNumber(raw)).toBeNull();
  });

  it.each([
    ['XIV', '14'],
    ['MMXXV', '2025'],
    ['$IX$', '9'],
    ['1,000', '1000'],
    ['-12,345', '-12345'],
    [String.raw`\frac12`, '1/2'],
    [String.raw`\frac 12`, '1/2'],
    [String.raw`\dfrac34`, '3/4'],
    ['2^{10}-1', '1023'],
    ['2^10 + 1', '1025'],
  ])('reads the form %s as %s', (raw, canon) => {
    expect(canonNumber(raw)).toBe(canon);
  });

  it('grades from the ANSWER line only', () => {
    expect(gradeResponse(NUMBER, 'work 3/4 maybe\nANSWER: 6/8').correct).toBe(1);
    expect(gradeResponse(NUMBER, 'ANSWER: 0.75').correct).toBe(1);
    expect(gradeResponse(NUMBER, 'the value is 3/4').status).toBe('parse_error');
    expect(gradeResponse(NUMBER, 'ANSWER: 3/4 or 1').status).toBe('parse_error');
    expect(gradeResponse(NUMBER, 'ANSWER: 2/3').correct).toBe(0);
  });

  it('reads a boxed fraction in the lenient layer only', () => {
    const text = String.raw`so the answer is $\boxed{\frac{3}{4}}$`;
    expect(gradeResponse(NUMBER, text).correct).toBe(0);
    const lenient = gradeResponseLenient(NUMBER, text);
    expect(lenient.correct).toBe(1);
    expect(lenient.lenient).toBe(true);
  });

  it('votes on canonical strings, so equal values written differently agree', () => {
    const grades = ['ANSWER: 6/8', 'ANSWER: 0.75', 'ANSWER: 2'].map((text) => gradeResponse(NUMBER, text));
    const vote = plurality(grades, (tied) => tied[0]);
    expect(vote.extracted).toBe('3/4');
    expect(vote.votes).toEqual({ '3/4': 2, 2: 1 });
  });

  it('keeps integer and choice prompts and readings as they were', () => {
    const integer = { kind: 'integer', stem: 'S', goldCanon: '7', choiceCount: 0 };
    const choice = { kind: 'choice', stem: 'S', goldCanon: 'B', choiceCount: 4, options: [
      { letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }, { letter: 'C', text: 'c' }, { letter: 'D', text: 'd' },
    ] };
    expect(answerPrompt(integer).startsWith(`${ANSWER_INSTRUCTIONS}\n\nQuestion:\nS`)).toBe(true);
    expect(answerPrompt(choice).startsWith(`${ANSWER_INSTRUCTIONS}\n\nQuestion:\nS`)).toBe(true);
    expect(answerPrompt(NUMBER).startsWith(`${NUMBER_INSTRUCTIONS}\n\nQuestion:\nq`)).toBe(true);
    expect(canonAnswer('1234', integer)).toBeNull();
    expect(canonAnswer('-3', integer)).toBeNull();
    expect(canonAnswer('b', choice)).toBe('B');
    expect(canonAnswer('E', choice)).toBeNull();
  });

  it('names a context refusal and a loop failure', () => {
    expect(failureKind({ ok: false, error: { kind: 'context', message: 'context' } })).toBe('context');
    expect(failureKind({ ok: false, error: { kind: 'loop', message: 'loop' } })).toBe('loop');
  });
});
