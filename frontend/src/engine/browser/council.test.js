import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MODELS_UNAVAILABLE,
  Stage1AllFailed,
  buildJudgeView,
  calculateAggregateRankings,
  computeConsensus,
  generateConversationTitle,
  parseCorrectnessScores,
  parseDisputedClaims,
  parseRankingFromText,
  pendingStage1Slots,
  redTeamReview,
  retainedStage1Failures,
  stage1CollectResponsesStreaming,
  stage2CollectRankingsStreaming,
  stage3SynthesizeFinal,
  usableStage1Results,
} from './council.js';
import * as openrouter from './openrouter.js';
import { resetFreeQueueForTests } from './openrouter.js';
import { clearModelCooldowns, rememberModelCooldown } from './roster.js';
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

  it('does not keep a skipped harness sample as a failure', async () => {
    settings.councilModels = ['thinkingmachines/inkling:free', 'openai/gpt-4.1'];
    settings.nSamples = 2;
    const calls = [];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      calls.push(model);
      if (!String(model).endsWith(':free')) {
        return { ok: true, content: 'ok', usage: {} };
      }
      const freeCalls = calls.filter((item) => String(item).endsWith(':free')).length;
      if (freeCalls === 1) {
        return {
          ok: false,
          error: { status: 403, message: 'harness', detail: 'harness' },
        };
      }
      return {
        ok: false,
        skipped: true,
        error: { status: 403, message: 'Skipped', detail: '' },
      };
    });
    const events = [];
    for await (const event of stage1CollectResponsesStreaming('q', { n: 2 })) {
      events.push(event);
    }
    const failed = events.filter((event) => event[0] === 'model_failed' && !event[1].existing);
    expect(failed).toHaveLength(2);
    expect(failed.filter((event) => event[1].skipped)).toHaveLength(1);
    const complete = events.find((event) => event[0] === 'all_complete')[1];
    expect(complete.failures).toHaveLength(1);
  });

  it('keeps failures on Stage1AllFailed', () => {
    const failures = [{ model: 'a', error: { message: '402: cannot afford reserved tokens' } }];
    const exc = new Stage1AllFailed(failures);
    expect(exc.failures).toEqual(failures);
    expect(String(exc)).toContain('All models failed');
  });

  it('says the models are unavailable when every sample was skipped', () => {
    const exc = new Stage1AllFailed([]);
    expect(exc.message).toBe(MODELS_UNAVAILABLE);
  });

  it('uses one sample for an all-free council even when n is 3', async () => {
    settings.councilModels = ['a/one:free', 'b/two:free'];
    settings.nSamples = 3;
    const queried = [];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      queried.push(model);
      return { ok: true, content: `ok ${model}`, usage: {} };
    });
    const events = [];
    for await (const event of stage1CollectResponsesStreaming('q', { n: 3 })) {
      events.push(event);
    }
    expect(queried).toEqual(['a/one:free', 'b/two:free']);
    const init = events.find((event) => event[0] === 'init')[1];
    expect(init.total_models).toBe(2);
    const complete = events.find((event) => event[0] === 'all_complete')[1];
    expect(complete.results).toHaveLength(2);
  });

  it('keeps an explicit sample count for a mixed council', async () => {
    settings.councilModels = ['a/one:free', 'openai/gpt-4.1'];
    settings.nSamples = 1;
    const queried = [];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      queried.push(model);
      return { ok: true, content: 'ok', usage: {} };
    });
    for await (const event of stage1CollectResponsesStreaming('q', { n: 3 })) {
      void event;
    }
    expect(queried.filter((model) => model === 'a/one:free')).toHaveLength(3);
    expect(queried.filter((model) => model === 'openai/gpt-4.1')).toHaveLength(3);
  });

  it('drops stored samples beyond the all-free limit on resume', async () => {
    settings.councilModels = ['a/one:free'];
    settings.nSamples = 3;
    const queried = [];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      queried.push(model);
      return { ok: true, content: 'new', usage: {} };
    });
    const events = [];
    for await (const event of stage1CollectResponsesStreaming('q', {
      n: 3,
      existingResults: [
        { model: 'a/one:free', response: 'first' },
        { model: 'a/one:free', response: 'second' },
        { model: 'a/one:free', response: 'third' },
      ],
    })) {
      events.push(event);
    }
    expect(queried).toEqual([]);
    const complete = events.find((event) => event[0] === 'all_complete')[1];
    expect(complete.results).toEqual([
      { model: 'a/one:free', response: 'first' },
    ]);
  });
});

describe('skipped models in later stages', () => {
  it('does not keep a skipped stage 2 judge as a failure', async () => {
    settings.councilModels = ['a/one:free', 'openai/gpt-4.1'];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      if (String(model).endsWith(':free')) {
        return { ok: false, skipped: true, error: { message: 'Skipped' } };
      }
      return { ok: true, content: 'FINAL RANKING:\n1. Response 1', usage: {} };
    });
    const events = [];
    for await (const event of stage2CollectRankingsStreaming('q', [
      { model: 'openai/gpt-4.1', response: 'answer' },
    ])) {
      events.push(event);
    }
    const complete = events.find((event) => event[0] === 'all_complete')[1];
    expect(complete.failures).toEqual([]);
    expect(complete.results).toHaveLength(1);
    const skipped = events.filter((event) => event[0] === 'model_failed');
    expect(skipped).toHaveLength(1);
    expect(skipped[0][1].skipped).toBe(true);
  });

  it('treats a skipped red team as a miss', async () => {
    vi.spyOn(openrouter, 'queryModelResult').mockResolvedValue({
      ok: false,
      skipped: true,
      error: { message: 'Skipped' },
    });
    const result = await redTeamReview(
      'q',
      'answer',
      0,
      [],
      [{ model: 'openai/gpt-4.1', response: 'answer' }],
    );
    expect(result).toBeNull();
  });

  it('asks the next council model when the chairman is cooling', async () => {
    settings.chairmanModel = 'google/gemma-4-31b-it:free';
    settings.councilModels = ['google/gemma-4-31b-it:free', 'openai/gpt-4.1'];
    rememberModelCooldown('google/gemma-4-31b-it:free', 1);
    const called = [];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      called.push(model);
      return { ok: true, content: 'final', usage: {} };
    });
    const result = await stage3SynthesizeFinal('q', [
      { model: 'openai/gpt-4.1', response: 'a' },
    ]);
    expect(called).toEqual(['openai/gpt-4.1']);
    expect(result.model).toBe('openai/gpt-4.1');
    expect(settings.chairmanModel).toBe('google/gemma-4-31b-it:free');
  });

  it('tries the next council model when the chairman call is skipped', async () => {
    settings.chairmanModel = 'google/gemma-4-31b-it:free-reasoning-high';
    settings.councilModels = ['google/gemma-4-31b-it:free', 'openai/gpt-4.1'];
    const called = [];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      called.push(model);
      if (String(model).includes('gemma')) {
        return { ok: false, skipped: true, error: { message: 'Skipped' } };
      }
      return { ok: true, content: 'final', usage: {} };
    });
    const result = await stage3SynthesizeFinal('q', [
      { model: 'openai/gpt-4.1', response: 'a' },
    ]);
    expect(called).toEqual(['google/gemma-4-31b-it:free-reasoning-high', 'openai/gpt-4.1']);
    expect(result.model).toBe('openai/gpt-4.1');
    expect(settings.chairmanModel).toBe('google/gemma-4-31b-it:free-reasoning-high');
  });

  it('surfaces a real chairman failure without trying another model', async () => {
    settings.chairmanModel = 'google/gemma-4-31b-it:free';
    settings.councilModels = ['openai/gpt-4.1'];
    const called = [];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      called.push(model);
      return { ok: false, error: { message: '402: cannot afford reserved tokens' } };
    });
    await expect(stage3SynthesizeFinal('q', [
      { model: 'openai/gpt-4.1', response: 'a' },
    ])).rejects.toThrow('Chairman model (google/gemma-4-31b-it:free) failed: 402: cannot afford reserved tokens');
    expect(called).toEqual(['google/gemma-4-31b-it:free']);
  });

  it('says the models are unavailable when every synthesizer is skipped', async () => {
    settings.chairmanModel = 'google/gemma-4-31b-it:free';
    settings.councilModels = ['openai/gpt-4.1'];
    vi.spyOn(openrouter, 'queryModelResult').mockResolvedValue({
      ok: false,
      skipped: true,
      error: { message: 'Skipped' },
    });
    await expect(stage3SynthesizeFinal('q', [
      { model: 'openai/gpt-4.1', response: 'a' },
    ])).rejects.toThrow(MODELS_UNAVAILABLE);
  });
});

function completionResponse(content) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: {},
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bearerIs(init, key) {
  return init?.headers?.Authorization === `Bearer ${key}`;
}

describe('title and red-team credentials', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearModelCooldowns();
    resetFreeQueueForTests();
  });

  it('returns New Conversation without a title request when there is no personal key', async () => {
    settings.clearApiKey();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateConversationTitle('What is rain?')).resolves.toBe('New Conversation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still asks the paid title model with the personal key', async () => {
    settings.apiKey = 'sk-user-test';
    const fetchMock = vi.fn(async () => completionResponse('Rain Question'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateConversationTitle('What is rain?')).resolves.toBe('Rain Question');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1];
    expect(bearerIs(init, 'sk-user-test')).toBe(true);
    expect(JSON.parse(init.body).model).toBe('google/gemini-2.5-flash');
  });

  it('returns null when the title request is already aborted', async () => {
    settings.clearApiKey();
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateConversationTitle('q', controller.signal)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the personal key when a family swap stays on a free model', async () => {
    settings.clearApiKey();
    settings.chairmanModel = 'a/one:free';
    settings.redTeamModel = null;
    const missing = vi.fn();
    vi.stubGlobal('fetch', missing);
    const refused = await redTeamReview(
      'q',
      'answer',
      0,
      [{ model: 'b/two:free', index: 1 }, { model: 'a/one:free', index: 0 }],
      [
        { model: 'a/one:free', response: 'answer' },
        { model: 'b/two:free', response: 'other' },
      ],
    );
    expect(missing).not.toHaveBeenCalled();
    expect(refused.error.message).toBe('No API key configured');

    settings.apiKey = 'sk-user-test';
    resetFreeQueueForTests();
    const fetchMock = vi.fn(async () => completionResponse('ok\nVERDICT: UPHELD\nCONFIDENCE: 8'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await redTeamReview(
      'q',
      'answer',
      0,
      [{ model: 'b/two:free', index: 1 }, { model: 'a/one:free', index: 0 }],
      [
        { model: 'a/one:free', response: 'answer' },
        { model: 'b/two:free', response: 'other' },
      ],
    );
    expect(result.model).toBe('b/two:free');
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bearerIs(fetchMock.mock.calls[0][1], 'sk-user-test')).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('b/two:free');
  });

  it('does not post a paid historical red-team model without a personal key', async () => {
    settings.clearApiKey();
    settings.chairmanModel = 'a/one:free';
    settings.redTeamModel = null;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await redTeamReview(
      'q',
      'answer',
      0,
      [{ model: 'openai/gpt-4.1', index: 1 }],
      [{ model: 'a/one:free', response: 'answer' }],
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.model).toBe('openai/gpt-4.1');
    expect(result.verdict).toBeNull();
    expect(result.error.message).toBe('No API key configured');
  });

  it('falls through a cooled chairman onto the next model with that model\'s key', async () => {
    settings.apiKey = 'sk-user-test';
    settings.chairmanModel = 'openai/gpt-4.1';
    settings.councilModels = ['b/two:free'];
    rememberModelCooldown('openai/gpt-4.1', 600);
    resetFreeQueueForTests();
    const fetchMock = vi.fn(async () => completionResponse('final'));
    vi.stubGlobal('fetch', fetchMock);
    const stage3 = await stage3SynthesizeFinal('q', [
      { model: 'b/two:free', response: 'yes' },
    ]);
    expect(stage3.response).toBe('final');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1];
    expect(bearerIs(init, 'sk-user-test')).toBe(true);
    expect(JSON.parse(init.body).model).toBe('b/two:free');
  });
});

describe('stage 1 transport boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetFreeQueueForTests();
  });

  it('does not rank a stream that ends before [DONE]', async () => {
    const previous = {
      council: [...settings.councilModels],
      chairman: settings.chairmanModel,
      samples: settings.nSamples,
      key: settings.apiKey,
    };
    settings.apiKey = 'sk-user-test';
    settings.councilModels = ['test/alpha:free'];
    settings.chairmanModel = 'test/alpha:free';
    settings.nSamples = 1;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )));
    try {
      const events = [];
      for await (const event of stage1CollectResponsesStreaming('q')) {
        events.push(event);
      }
      const completed = events.filter((event) => event[0] === 'model_complete' && !event[1].existing);
      const failed = events.filter((event) => event[0] === 'model_failed' && !event[1].existing);
      const finished = events.find((event) => event[0] === 'all_complete');
      expect(completed).toEqual([]);
      expect(failed).toHaveLength(1);
      expect(failed[0][1].error.kind).toBe('protocol');
      expect(finished[1].results).toEqual([]);
      expect(JSON.stringify(finished[1].results)).not.toContain('partial answer');
    } finally {
      settings.councilModels = previous.council;
      settings.chairmanModel = previous.chairman;
      settings.nSamples = previous.samples;
      if (previous.key) settings.apiKey = previous.key;
      else settings.clearApiKey();
    }
  });
});
