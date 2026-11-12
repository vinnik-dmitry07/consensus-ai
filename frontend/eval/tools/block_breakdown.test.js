import { describe, expect, it } from 'vitest';

import { readGold } from '../campaignData.js';
import { placeBefore, withLineEndings } from '../noteTools.js';
import {
  TARGET, engineReply, markers, rulesOf, scoreRow, sheepFits, shownCandidates, shownResponses, tally, variantsOf,
} from './block_breakdown.js';

const graded = (extracted) => ({ status: 'graded', extracted });
const row = (a8, s8, leader = null, council = []) => ({
  arms: { A8: a8, S8: s8, P8: graded('1'), B8: graded('2') },
  diagnostics: { leader, councilAnswers: council },
});
const tasks = new Map([
  ['test:set:a', { kind: 'number', goldCanon: '5' }],
  ['test:set:b', { kind: 'number', goldCanon: '7' }],
  ['test:set:c', { kind: 'number', goldCanon: '9' }],
]);

describe('block breakdown: scoring', () => {
  it('counts a graded answer equal to the gold and nothing else', () => {
    const score = scoreRow(row(graded('8'), { status: 'parse_error', extracted: '4, 6, 8' }, graded('14'), ['8', '14', null]), '8');
    expect(score.arms).toEqual({ A8: 1, S8: 0, P8: 0, B8: 0 });
    expect(score.leader).toBe(0);
    expect(score.council).toEqual([1, 0, 0]);
  });

  it('tallies arms and discordant pairs', () => {
    const scored = [
      { arms: { A8: 1, S8: 0, P8: 1, B8: 0 } },
      { arms: { A8: 0, S8: 1, P8: 1, B8: 1 } },
      { arms: { A8: 0, S8: 1, P8: 0, B8: 1 } },
      { arms: { A8: 1, S8: 1, P8: 1, B8: 1 } },
    ];
    expect(tally(scored)).toEqual({ n: 4, wins: 1, losses: 2, A8: 2, S8: 3, P8: 3, B8: 3 });
  });
});

describe('block breakdown: gold variants', () => {
  const main = readGold({ 'test:set:a': { gold: '6', reason: 'recount' }, 'test:set:b': { exclude: true, reason: 'ill-posed' } }, tasks);
  const wide = readGold({ 'test:set:a': { gold: '6', reason: 'recount' }, 'test:set:b': { exclude: true, reason: 'ill-posed' }, 'test:set:c': { exclude: true, reason: 'many keys' } }, tasks);

  it('reads a corrections file as the report does', () => {
    expect(main.gold.get('test:set:a')).toBe('6');
    expect([...main.excluded.keys()]).toEqual(['test:set:b']);
    expect(main.reasons.get('test:set:b')).toBe('ill-posed');
    expect(main.goldOf('test:set:a')).toBe('6');
    expect(main.goldOf('test:set:c')).toBe(tasks.get('test:set:c').goldCanon);
    expect(() => readGold({ 'test:set:zzz': { gold: '1' } }, tasks)).toThrow(/unknown question/);
  });

  it('goes from the report as run to every correction at once', () => {
    const list = variantsOf(TARGET, tasks, main, wide);
    expect(list.map((item) => item.key)).toEqual(['report', 'main', 'main-less', 'wide']);
    expect(list[0].gold('test:set:a')).toBe('5');
    expect([...list[0].excluded]).toEqual([]);
    expect(list[1].gold('test:set:a')).toBe('6');
    expect([...list[1].excluded]).toEqual(['test:set:b']);
    expect([...list[2].excluded].sort()).toEqual(['test:set:b', 'test:set:c']);
    expect(list[2].gold('test:set:a')).toBe('6');
    expect([...list[3].excluded].sort()).toEqual(['test:set:b', 'test:set:c']);
  });
});

describe('block breakdown: what a judge and the chairman were shown', () => {
  it('reads the anonymized answers of a judge prompt', () => {
    const prompt = 'You are evaluating.\n\nHere are the responses from different models (anonymized):\n\nResponse 1:\nfirst\n\nANSWER: 14\n\nResponse 2:\nANSWER: 2021\n\nYour task:\n1. Evaluate each response independently.';
    expect(shownResponses(prompt)).toEqual([
      { label: 'Response 1', text: 'first\n\nANSWER: 14' },
      { label: 'Response 2', text: 'ANSWER: 2021' },
    ]);
    expect(shownResponses('no answers here')).toEqual([]);
  });

  it('reads the candidates of a chairman prompt with their peer scores', () => {
    const prompt = 'CANDIDATES\n\nCandidate #1 (score=1.00, correctness=10.0/10):\nJudge issues: none\nlong answer\n\nANSWER: 14\n\nCandidate #2 (score=0.50, correctness=9.0/10):\nJudge issues: no proof\nANSWER: 8\n\nYour task:\n- Treat Candidate #1 as the base draft.';
    const list = shownCandidates(prompt);
    expect(list.map((item) => [item.place, item.score, item.correctness])).toEqual([[1, '1.00', '10.0/10'], [2, '0.50', '9.0/10']]);
    expect(list[0].text.trim().endsWith('ANSWER: 14')).toBe(true);
    expect(list[1].text.trim().endsWith('ANSWER: 8')).toBe(true);
  });
});

describe('block breakdown: the judge text the engine parsed', () => {
  const rule = { chars: 12, marker: '[tail]' };
  const judge = (finishReason, contentFromReasoning) => ({ result: { ok: true, content: 'Response 1 ... FINAL RANKING: 1. Response 2', finishReason, contentFromReasoning } });

  it('reads a judge cut in its reasoning from its tail, as the tail rule does', () => {
    const content = judge('length', true).result.content;
    expect(engineReply(judge('length', true), rule)).toEqual({ text: `[tail]\n${content.slice(-12)}`, tail: true });
    expect(content.slice(-12)).toBe('. Response 2');
    expect(engineReply(judge('loop', true), rule).tail).toBe(true);
  });

  it('reads a finished judge, or any judge without the rule, whole', () => {
    expect(engineReply(judge('stop', false), rule)).toEqual({ text: 'Response 1 ... FINAL RANKING: 1. Response 2', tail: false });
    expect(engineReply(judge('length', false), rule).tail).toBe(false);
    expect(engineReply(judge('length', true), null).tail).toBe(false);
  });
});

describe('block breakdown: the sheep question', () => {
  it('finds the four readings that fit the stated counts', () => {
    expect(sheepFits()).toEqual([
      { k: 4, period: 12, first: 20, fromStart: false, onFirstSheep: false, at60: false, at100: false },
      { k: 4, period: 12, first: 24, fromStart: false, onFirstSheep: false, at60: true, at100: false },
      { k: 4, period: 16, first: 0, fromStart: true, onFirstSheep: true, at60: false, at100: false },
      { k: 4, period: 16, first: 4, fromStart: true, onFirstSheep: false, at60: false, at100: true },
    ]);
  });
});

describe('block breakdown: README', () => {
  it('places the block before the next section once and refills it after', () => {
    const { start, end } = markers();
    const readme = 'results\n\n### Next\n\ntail\n';
    const once = placeBefore(readme, start, end, 'one', '### Next');
    expect(once.indexOf(end)).toBeLessThan(once.indexOf('### Next'));
    expect(once).toContain('one');
    const twice = placeBefore(once, start, end, 'two', '### Next');
    expect(twice).toContain('two');
    expect(twice).not.toContain('one');
    expect(twice.split(start).length).toBe(2);
    expect(() => placeBefore('no heading', start, end, 'x', '### Next')).toThrow(/not in the README/);
  });

  it('keeps the line endings the README has and leaves an unchanged one alone', () => {
    const crlf = 'a\r\nb\r\n';
    expect(withLineEndings(crlf, (text) => text.replace('b', 'b\nc'))).toBe('a\r\nb\r\nc\r\n');
    expect(withLineEndings('a\nb\n', (text) => text.replace('b', 'b\nc'))).toBe('a\nb\nc\n');
    const mixed = 'a\r\nb\nc\r\n';
    expect(withLineEndings(mixed, (text) => text)).toBe(mixed);
  });

  it('gives the analysis the rules and the results written before the block', () => {
    const { start } = markers();
    const readme = `intro\n\n### a8-open-v5: общий максимальный лимит, новые блоки, защита от цикла\n\nrules text\n\n### Итоги a8-open-v5e\n\nresults text\n\n${start}\n\nblock text\n`;
    const rules = rulesOf(readme, start);
    expect(rules).toContain('rules text');
    expect(rules).toContain('results text');
    expect(rules).not.toContain('intro');
    expect(rules).not.toContain('block text');
    expect(rules.indexOf('rules text')).toBeLessThan(rules.indexOf('results text'));
    expect(() => rulesOf('### Итоги a8-open-v5e\n\nno rules', start)).toThrow(/not in the README/);
  });
});
