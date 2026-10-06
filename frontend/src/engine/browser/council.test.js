import { describe, expect, it, vi } from 'vitest';

import {
  Stage1AllFailed,
  buildJudgeView,
  calculateAggregateRankings,
  computeConsensus,
  parseCorrectnessScores,
  parseDisputedClaims,
  parseRankingFromText,
  pendingStage1Slots,
  retainedStage1Failures,
  stage1CollectResponsesStreaming,
  usableStage1Results,
} from './council.js';
import * as openrouter from './openrouter.js';
import { settings } from './settings.js';

describe('stage 2 parsers', () => {
  it('reads bold markdown headers and scores', () => {
    const text = `
**Response 1:**
**Correctness:** 8/10
Issues: none

**Response 2**
Correctness: **7**/10
Issues: none

FINAL RANKING:
1. **Response 2**
2. **Response 1**
`;
    expect(parseCorrectnessScores(text)).toMatchObject({
      'Response 1': 8,
      'Response 2': 7,
    });
    expect(parseRankingFromText(text)).toEqual(['Response 2', 'Response 1']);
  });

  it('does not split a block on an in-prose response mention', () => {
    const text = `
Response 1:
This is stronger than Response 2 on facts.
Correctness: 8/10
Issues: none

Response 2:
Correctness: 4/10
Issues: none

FINAL RANKING:
1. Response 1
2. Response 2
`;
    const scores = parseCorrectnessScores(text);
    expect(scores['Response 1']).toBe(8);
    expect(scores['Response 2']).toBe(4);
  });

  it('accepts a colon outside bold headings', () => {
    const text = `
**Response 1:**
**Correctness**: 8/10
Issues: none

**DISPUTED CLAIMS**:
- the sky color

**FINAL RANKING**:
1. **Response 1**
`;
    expect(parseCorrectnessScores(text)['Response 1']).toBe(8);
    expect(parseDisputedClaims(text)).toEqual(['the sky color']);
    expect(parseRankingFromText(text)).toEqual(['Response 1']);
  });
});

describe('borda', () => {
  it('scores the shown set instead of treating a partial list as last place', () => {
    const stage1 = Array.from({ length: 6 }, (_, i) => ({
      model: `m${i}`,
      response: String(i),
    }));
    const shown = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`Response ${i + 1}`, i]),
    );
    const full = { label_to_index: shown, ranked_indices: [0, 1, 2, 3, 4, 5] };
    const partial = { label_to_index: shown, ranked_indices: [0, 1, 2] };
    const { responseRankings, rankingFallback } = calculateAggregateRankings(
      stage1,
      [full, partial, partial],
    );
    expect(rankingFallback).toBe(false);
    const byIndex = Object.fromEntries(responseRankings.map((row) => [row.index, row.score]));
    expect(byIndex[2]).toBeGreaterThan(byIndex[3]);
  });
});

describe('consensus', () => {
  it('keeps family top-1 agreement when samples are split', () => {
    const responseRankings = [
      { index: 0, model: '~openai/gpt-sol-latest', score: 0.8, mean_correctness: 9, top1_votes: 3 },
      { index: 1, model: '~openai/gpt-sol-latest', score: 0.7, mean_correctness: 8.5, top1_votes: 2 },
      { index: 2, model: '~openai/gpt-sol-latest', score: 0.6, mean_correctness: 8, top1_votes: 1 },
      { index: 3, model: '~x-ai/grok-latest', score: 0.1, mean_correctness: 5, top1_votes: 0 },
    ];
    const shown = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`Response ${i + 1}`, i]),
    );
    const stage2 = [0, 0, 0, 1, 1, 2].map((first) => ({
      label_to_index: shown,
      ranked_indices: [first, 3],
      disputed_claims: [],
    }));
    const consensus = computeConsensus(responseRankings, stage2, { verdict: 'UPHELD' });
    expect(consensus.top1_agreement).toBe(1);
    expect(consensus.level).toBe('HIGH');
  });

  it('excludes blind judges from the denominator', () => {
    const responseRankings = [
      { index: 0, model: '~openai/gpt-sol-latest', score: 0.9, mean_correctness: 9, top1_votes: 6 },
      { index: 1, model: '~x-ai/grok-latest', score: 0.2, mean_correctness: 6, top1_votes: 2 },
    ];
    const sighted = {
      label_to_index: { 'Response 1': 0, 'Response 2': 1 },
      ranked_indices: [0, 1],
      disputed_claims: [],
    };
    const blind = {
      label_to_index: { 'Response 1': 1 },
      ranked_indices: [1],
      disputed_claims: [],
    };
    const consensus = computeConsensus(
      responseRankings,
      [...Array(6).fill(sighted), ...Array(2).fill(blind)],
      { verdict: 'UPHELD' },
    );
    expect(consensus.top1_agreement).toBe(1);
    expect(consensus.level).toBe('HIGH');
  });

  const rankings = [{
    index: 0,
    model: 'a/one',
    score: 0.9,
    mean_correctness: 9.5,
    top1_votes: 1,
  }];
  const stage2 = [{
    label_to_index: { 'Response 1': 0 },
    ranked_indices: [0],
    disputed_claims: [],
  }];

  it('cannot reach HIGH without a red team', () => {
    const result = computeConsensus(rankings, stage2, null);
    expect(result.level).toBe('MEDIUM');
    expect(result.reasons).toContain('Red-team review was unavailable');
  });

  it('cannot reach HIGH when the red team errored', () => {
    const result = computeConsensus(rankings, stage2, {
      verdict: null,
      error: { message: 'boom' },
    });
    expect(result.level).toBe('MEDIUM');
  });

  it('still reaches HIGH when the red team upholds', () => {
    const result = computeConsensus(rankings, stage2, { verdict: 'UPHELD' });
    expect(result.level).toBe('HIGH');
  });
});

describe('self exclusion', () => {
  it('does not let a judge grade a sibling from its own vendor', async () => {
    const stage1 = [
      { model: 'anthropic/claude-opus-4.1', response: 'a' },
      { model: 'anthropic/claude-sonnet-4.5', response: 'b' },
      { model: 'google/gemini-pro-latest', response: 'c' },
    ];
    const view = await buildJudgeView(
      'anthropic/claude-opus-4.1',
      stage1,
      'q',
      true,
    );
    expect(view.self_excluded).toBe(true);
    expect(Object.values(view.label_to_index).sort()).toEqual([2]);
  });

  it('skips exclusion when it would leave nothing to rank', async () => {
    const stage1 = [
      { model: 'anthropic/claude-opus-4.1', response: 'a' },
      { model: 'anthropic/claude-sonnet-4.5', response: 'b' },
    ];
    const view = await buildJudgeView(
      'anthropic/claude-opus-4.1',
      stage1,
      'q',
      true,
    );
    expect(view.self_excluded).toBe(false);
    expect(view.candidates).toHaveLength(2);
  });
});

describe('resume hygiene', () => {
  it('drops samples from a removed model', () => {
    const existing = [
      { model: 'a/one', response: '1' },
      { model: 'dropped/two', response: '2' },
      { model: 'a/one', response: '3' },
    ];
    const kept = usableStage1Results(['a/one'], 2, existing);
    expect(kept.map((row) => row.response)).toEqual(['1', '3']);
    expect(pendingStage1Slots(['a/one'], 2, existing)).toEqual([]);
  });

  it('drops samples beyond the current n', () => {
    const existing = Array.from({ length: 4 }, (_, i) => ({
      model: 'a/one',
      response: String(i),
    }));
    const kept = usableStage1Results(['a/one'], 2, existing);
    expect(kept.map((row) => row.response)).toEqual(['0', '1']);
    expect(pendingStage1Slots(['a/one'], 2, existing)).toEqual([]);
  });

  it('drops failures from removed models', () => {
    const failures = [
      { model: 'a/one', error: { message: 'x' } },
      { model: 'dropped/two', error: { message: 'y' } },
    ];
    expect(retainedStage1Failures(failures, [], ['a/one'])).toEqual([
      { model: 'a/one', error: { message: 'x' } },
    ]);
  });

  it('keeps the council filter optional', () => {
    const failures = [{ model: 'dropped/two', error: { message: 'y' } }];
    expect(retainedStage1Failures(failures, [])).toEqual(failures);
  });

  it('counts remaining samples per model', () => {
    expect(pendingStage1Slots(
      ['a', 'b'],
      3,
      [{ model: 'a' }, { model: 'a' }],
    )).toEqual(['a', 'b', 'b', 'b']);
  });

  it('drops failures for models that will be retried', () => {
    const kept = retainedStage1Failures(
      [
        { model: 'a', error: { message: 'old' } },
        { model: 'b', error: { message: 'keep' } },
      ],
      ['a'],
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].model).toBe('b');
  });
});

describe('stage 1 streaming', () => {
  it('yields model_failed on a 402', async () => {
    settings.councilModels = ['~x-ai/grok-latest-reasoning'];
    settings.nSamples = 1;
    vi.spyOn(openrouter, 'queryModelResult').mockResolvedValue({
      ok: false,
      error: {
        status: 402,
        message: '402: cannot afford reserved tokens',
        detail: 'need more credits',
      },
    });
    const events = [];
    for await (const event of stage1CollectResponsesStreaming('q', { n: 1 })) {
      events.push(event);
    }
    const types = events.map((event) => event[0]);
    expect(types).toContain('model_failed');
    const failed = events.find((event) => event[0] === 'model_failed')[1];
    expect(failed.model).toBe('~x-ai/grok-latest-reasoning');
    expect(failed.error.message).toBe('402: cannot afford reserved tokens');
    const complete = events.find((event) => event[0] === 'all_complete')[1];
    expect(complete.results).toEqual([]);
    expect(complete.failures).toHaveLength(1);
  });

  it('queries only the samples still missing', async () => {
    settings.councilModels = ['a', 'b'];
    settings.nSamples = 2;
    const queried = [];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      queried.push(model);
      return { ok: true, content: `ok ${model}`, usage: {} };
    });
    const events = [];
    for await (const event of stage1CollectResponsesStreaming('q', {
      n: 2,
      existingResults: [{ model: 'a', response: 'old' }],
      existingFailures: [{ model: 'a', error: { message: 'old 402' } }],
    })) {
      events.push(event);
    }
    expect(queried.filter((model) => model === 'a')).toHaveLength(1);
    expect(queried.filter((model) => model === 'b')).toHaveLength(2);
    const complete = events.find((event) => event[0] === 'all_complete')[1];
    expect(complete.results).toHaveLength(4);
    expect(complete.failures).toEqual([]);
  });

  it('keeps failures on Stage1AllFailed', () => {
    const failures = [{ model: 'a', error: { message: '402: cannot afford reserved tokens' } }];
    const exc = new Stage1AllFailed(failures);
    expect(exc.failures).toEqual(failures);
    expect(String(exc)).toContain('All models failed');
  });
});
