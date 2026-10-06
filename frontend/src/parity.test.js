import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  calculateAggregateRankings,
  computeConsensus,
  parseCorrectnessScores,
  parseDisputedClaims,
  parseRankingFromText,
  pyFixed,
} from './engine/browser/council.js';

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/stage2_cases.json',
);
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));

function checkCase(testCase) {
  if (testCase.kind === 'parse') {
    if ('correctness' in testCase) {
      expect(parseCorrectnessScores(testCase.text)).toEqual(testCase.correctness);
    }
    if ('ranking' in testCase) {
      expect(parseRankingFromText(testCase.text)).toEqual(testCase.ranking);
    }
    if ('disputed_claims' in testCase) {
      expect(parseDisputedClaims(testCase.text)).toEqual(testCase.disputed_claims);
    }
    return;
  }
  if (testCase.kind === 'format') {
    expect(pyFixed(testCase.value, testCase.digits)).toBe(testCase.expected);
    return;
  }
  if (testCase.kind === 'aggregate') {
    const { responseRankings, rankingFallback } = calculateAggregateRankings(
      testCase.stage1,
      testCase.stage2,
    );
    expect(rankingFallback).toBe(testCase.fallback);
    const byIndex = Object.fromEntries(responseRankings.map((row) => [row.index, row.score]));
    const [left, right] = testCase.score_greater;
    expect(byIndex[left]).toBeGreaterThan(byIndex[right]);
    return;
  }
  if (testCase.kind === 'consensus') {
    const result = computeConsensus(
      testCase.response_rankings,
      testCase.stage2,
      testCase.red_team,
    );
    expect(result.level).toBe(testCase.level);
    if ('top1_agreement' in testCase) {
      expect(result.top1_agreement).toBe(testCase.top1_agreement);
    }
    if ('reason_includes' in testCase) {
      expect(result.reasons).toContain(testCase.reason_includes);
    }
    return;
  }
  throw new Error(`unknown fixture kind ${testCase.kind}`);
}

describe('shared stage 2 fixtures', () => {
  it.each(fixtures.cases.map((testCase) => [testCase.name, testCase]))(
    '%s',
    (_name, testCase) => {
      checkCase(testCase);
    },
  );
});
