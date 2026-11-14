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
import { detectLoop, repeatShare } from './engine/browser/loopGuard.js';
import { IDLE_WAIT_SECONDS } from './engine/browser/openrouter.js';
import {
  buildSelfMoaPrompt,
  forwardSampleText,
  SELF_MOA_SAMPLES,
  SELF_MOA_TAIL_CHARS,
  SELF_MOA_TAIL_MARKER,
  selfMoaRequestOptions,
} from './engine/browser/selfMoa.js';

// Long fixture texts are written as parts: ['repeat', text, times],
// ['numbers', from, to] (joined by spaces), ['counted', prefix, suffix, n].
function buildText(parts) {
  return parts.map(([kind, a, b, c]) => {
    if (kind === 'repeat') return a.repeat(b);
    if (kind === 'numbers') return Array.from({ length: b - a }, (_, i) => String(a + i)).join(' ');
    if (kind === 'counted') return Array.from({ length: c }, (_, i) => `${a}${i}${b}`).join('');
    throw new Error(`unknown text part ${kind}`);
  }).join('');
}

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
  if (testCase.kind === 'self_moa_prompt') {
    expect(buildSelfMoaPrompt(testCase.query, testCase.samples)).toBe(testCase.expected);
    return;
  }
  if (testCase.kind === 'self_moa_forward') {
    const text = buildText(testCase.text);
    const forwarded = forwardSampleText({ response: text, cut_reasoning: testCase.cut_reasoning });
    expect(forwarded).toBe(testCase.expected_prefix + text.slice(-testCase.expected_tail_chars));
    return;
  }
  if (testCase.kind === 'self_moa_request') {
    const messages = [{ role: 'user', content: 'x'.repeat(testCase.prompt_chars) }];
    const options = selfMoaRequestOptions(null, messages, testCase.info);
    expect({
      max_tokens: options.maxTokens,
      temperature: options.temperature ?? null,
      top_p: options.topP ?? null,
    }).toEqual(testCase.expected);
    return;
  }
  if (testCase.kind === 'self_moa_settings') {
    const messages = [{ role: 'user', content: 'x'.repeat(testCase.prompt_chars) }];
    const options = selfMoaRequestOptions(null, messages, testCase.info);
    expect(SELF_MOA_SAMPLES).toBe(testCase.samples);
    expect(options.maxTokens).toBe(testCase.max_tokens);
    expect(options.temperature).toBe(testCase.temperature);
    expect(options.topP).toBe(testCase.top_p);
    expect(options.timeout).toBe(testCase.stream_seconds);
    expect(IDLE_WAIT_SECONDS).toBe(testCase.idle_seconds);
    expect(options.maxRetries).toBe(testCase.max_attempts);
    expect(options.loopGuard).toEqual(testCase.loop_guard);
    expect(SELF_MOA_TAIL_CHARS).toBe(testCase.tail_chars);
    expect(SELF_MOA_TAIL_MARKER).toBe(testCase.tail_marker);
    return;
  }
  if (testCase.kind === 'loop_guard') {
    expect(detectLoop(buildText(testCase.text))).toEqual(testCase.expected);
    return;
  }
  if (testCase.kind === 'loop_guard_share') {
    expect(repeatShare(buildText(testCase.text), testCase.end, true)).toBe(testCase.expected);
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
