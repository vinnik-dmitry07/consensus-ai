import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  answerTabsFrom,
  applyStage1Event,
  pickAnswerTab,
  safeNoteReason,
  stageRetryPatch,
} from './stage1State.js';

const appSource = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');

function answer(model, response) {
  return { model, response };
}

function failure(model, message, extra = {}) {
  return { model, error: { message, ...extra }, ...extra };
}

function init(message, total, existingCount = 0) {
  return applyStage1Event(message, 'stage1_init', {
    data: { total_models: total, existing_count: existingCount },
  });
}

describe('applyStage1Event', () => {
  it('is the helper App uses for Stage 1 events', () => {
    expect(appSource).toContain("import { applyStage1Event, knownList, stageRetryPatch } from './stage1State.js'");
    expect(appSource).toContain('applyStage1Event(messages[idx], eventType, event)');
    expect(appSource).toContain('stageRetryPatch(msg, stage)');
    expect(appSource).not.toContain('127.0.0.1:7417');
  });

  it('counts a new success, failure, and skip as one answer with completed 2 and total 2', () => {
    let message = init({ stage1_failures: [], stage1_skipped: [] }, 3);
    message = applyStage1Event(message, 'stage1_model_complete', {
      data: { result: answer('nvidia/nemotron', 'draft'), existing: false },
    });
    message = applyStage1Event(message, 'stage1_model_failed', {
      data: failure('openai/missing', 'Model not found (404)'),
    });
    message = applyStage1Event(message, 'stage1_model_failed', {
      data: {
        ...failure('google/gemma', 'Temporarily rate-limited upstream'),
        skipped: true,
      },
    });

    expect(message.stage1Progress.results).toEqual([answer('nvidia/nemotron', 'draft')]);
    expect(message.stage1Progress.completed).toBe(2);
    expect(message.stage1Progress.total).toBe(2);
    expect(message.stage1_failures.map((item) => item.model)).toEqual(['openai/missing']);
    expect(message.stage1_skipped.map((item) => item.model)).toEqual(['google/gemma']);
  });

  it('does not count replayed samples twice', () => {
    let message = init({}, 4, 2);
    message = applyStage1Event(message, 'stage1_model_complete', {
      data: { result: answer('a/one', 'kept'), existing: true },
    });
    message = applyStage1Event(message, 'stage1_model_failed', {
      data: { ...failure('b/two', 'Model not found (404)'), existing: true },
    });

    expect(message.stage1Progress.completed).toBe(2);
    expect(message.stage1Progress.results).toEqual([answer('a/one', 'kept')]);
    expect(message.stage1_failures).toHaveLength(1);

    message = applyStage1Event(message, 'stage1_model_complete', {
      data: { result: answer('a/one', 'kept'), existing: true },
    });
    expect(message.stage1Progress.completed).toBe(2);
    expect(message.stage1Progress.results).toHaveLength(2);
  });

  it('keeps both samples of one model and drops two skipped slots', () => {
    let message = init({}, 4);
    message = applyStage1Event(message, 'stage1_model_complete', {
      data: { result: answer('openai/gpt', 'first') },
    });
    message = applyStage1Event(message, 'stage1_model_complete', {
      data: { result: answer('openai/gpt', 'second') },
    });
    message = applyStage1Event(message, 'stage1_model_failed', {
      data: { ...failure('google/gemma', 'Skipped'), skipped: true },
    });
    message = applyStage1Event(message, 'stage1_model_failed', {
      data: { ...failure('google/gemma', 'Skipped'), skipped: true },
    });

    expect(message.stage1Progress.results.map((item) => item.response)).toEqual(['first', 'second']);
    expect(message.stage1Progress.completed).toBe(2);
    expect(message.stage1Progress.total).toBe(2);
    expect(message.stage1_skipped).toHaveLength(2);
  });

  it('replaces skips from a terminal payload and keeps them when the field is absent', () => {
    const accumulated = init({
      stage1_skipped: [
        failure('old/a', 'Skipped'),
        failure('old/b', 'Skipped'),
      ],
    }, 1);
    const withEvents = applyStage1Event(accumulated, 'stage1_model_failed', {
      data: { ...failure('new/c', 'Only available on agentic harnesses'), skipped: true },
    });

    const replaced = applyStage1Event(withEvents, 'stage1_complete', {
      data: [answer('nvidia/nemotron', 'final')],
      failures: [failure('openai/missing', 'Model not found (404)')],
      skipped: [failure('google/gemma', 'Temporarily rate-limited upstream')],
    });
    expect(replaced.stage1_skipped.map((item) => item.model)).toEqual(['google/gemma']);
    expect(replaced.stage1).toEqual([answer('nvidia/nemotron', 'final')]);
    expect(replaced.stage1Progress).toBeNull();
    expect(replaced.loading.stage1).toBe(false);

    const cleared = applyStage1Event(withEvents, 'stage1_complete', {
      data: [],
      skipped: [],
    });
    expect(cleared.stage1_skipped).toEqual([]);

    const kept = applyStage1Event(withEvents, 'stage1_error', {
      message: 'stopped',
      failures: [failure('openai/missing', 'Model not found (404)')],
    });
    expect(kept.stage1_skipped.map((item) => item.model)).toEqual([
      'old/a',
      'old/b',
      'new/c',
    ]);
    expect(kept.error).toEqual({ stage: 1, message: 'stopped' });
    expect(kept.stage1Progress).toBeNull();

    const errorCleared = applyStage1Event(withEvents, 'stage1_error', {
      message: 'stopped',
      skipped: [],
    });
    expect(errorCleared.stage1_skipped).toEqual([]);

    const errorReplaced = applyStage1Event(withEvents, 'stage1_error', {
      message: 'stopped',
      skipped: [failure('google/gemma', 'Cooling down after an upstream rate limit')],
    });
    expect(errorReplaced.stage1_skipped.map((item) => item.model)).toEqual(['google/gemma']);
  });

  it('accepts a final failure list, including an explicit empty list', () => {
    const message = {
      stage1_failures: [failure('openai/missing', 'Model not found (404)')],
      stage1_skipped: [],
      stage1Progress: { total: 1, completed: 1, results: [answer('a/one', 'kept')] },
    };
    const cleared = applyStage1Event(message, 'stage1_complete', {
      data: [answer('a/one', 'kept')],
      failures: [],
    });
    expect(cleared.stage1_failures).toEqual([]);

    const kept = applyStage1Event(message, 'stage1_error', { message: 'stopped' });
    expect(kept.stage1_failures).toEqual(message.stage1_failures);

    const replaced = applyStage1Event(message, 'stage1_complete', {
      data: [],
      failures: [failure('openai/other', 'Request failed')],
    });
    expect(replaced.stage1_failures.map((item) => item.model)).toEqual(['openai/other']);
  });

  it('clears the previous skips when a new Stage 1 starts', () => {
    const message = applyStage1Event({
      stage1: [answer('openai/gpt', 'old answer')],
      stage1_skipped: [failure('google/gemma', 'Skipped')],
      stage1_failures: [failure('openai/missing', 'Model not found (404)')],
      stage1Progress: { total: 1, completed: 1, results: [answer('openai/gpt', 'old answer')] },
      loading: { stage1: false, stage2: true },
    }, 'stage1_start');

    expect(message.stage1).toEqual([]);
    expect(message.stage1_skipped).toEqual([]);
    expect(message.stage1_failures).toEqual([]);
    expect(message.stage1Progress).toBeNull();
    expect(message.loading).toEqual({ stage1: true, stage2: true });
  });

  it('does not let a skip drive total below zero', () => {
    let message = init({}, 0);
    message = applyStage1Event(message, 'stage1_model_failed', {
      data: { ...failure('google/gemma', 'Skipped'), skipped: true },
    });
    expect(message.stage1Progress.total).toBe(0);
    expect(message.stage1Progress.completed).toBe(0);
  });
});

describe('stage retry patch', () => {
  const message = {
    stage1: [answer('a/keep', 'kept')],
    stage1Progress: { total: 2, completed: 1, results: [answer('a/keep', 'kept')] },
    stage1_failures: [failure('openai/missing', 'Model not found (404)')],
    stage1_skipped: [failure('google/gemma', 'Skipped')],
    stage2_failures: [failure('b/judge', 'Request failed')],
    stage2_skipped: [failure('c/judge', 'Skipped')],
    loading: { stage1: false, stage2: false, stage3: false },
  };

  it('clears visible Stage 1 answers when Stage 1 is retried', () => {
    const next = stageRetryPatch(message, 1);
    expect(next.stage1).toEqual([]);
    expect(next.stage1Progress).toBeNull();
    expect(next.stage1_failures).toEqual([]);
    expect(next.stage1_skipped).toEqual([]);
    expect(next.stage2_skipped).toEqual([]);
    expect(next.loading.stage1).toBe(true);
  });

  it('leaves Stage 1 answers in place for a later-stage retry', () => {
    const next = stageRetryPatch(message, 2);
    expect(next.stage1).toEqual(message.stage1);
    expect(next.stage1Progress).toEqual(message.stage1Progress);
    expect(next.stage1_skipped).toEqual(message.stage1_skipped);
    expect(next.stage2_skipped).toEqual([]);
    expect(next.loading).toEqual({
      stage1: false,
      stage2: true,
      redteam: false,
      stage3: false,
    });
  });
});

describe('diagnostic note text', () => {
  it('hides timeout tokens, raw bodies, and invented skip reasons', () => {
    for (const token of ['first-response', 'idle', 'total', 'aborted']) {
      expect(safeNoteReason('fail', token)).toBe('Request failed');
      expect(safeNoteReason('fail', token)).not.toBe(token);
    }
    expect(safeNoteReason('fail', 'HTTP 503 {"raw":"secret"}')).toBe('HTTP 503');
    expect(safeNoteReason('fail', 'Temporarily rate-limited upstream {"raw":"secret"}')).toBe(
      'Request failed',
    );
    expect(safeNoteReason('skip', 'not a known reason')).toBe('');
    expect(safeNoteReason('skip', 'Provider returned an error')).toBe('Provider returned an error');
    expect(safeNoteReason('skip', 'Temporarily unavailable (cooldown)')).toBe(
      'Temporarily unavailable (cooldown)',
    );
    expect(safeNoteReason('skip', 'Cooling down after an upstream rate limit')).toBe(
      'Cooling down after an upstream rate limit',
    );
  });
});

describe('answer tab identity', () => {
  it('drops empty, whitespace, and non-string responses without sorting the rest', () => {
    const tabs = answerTabsFrom([
      { model: 'a/one', response: '  first  ' },
      { model: 'b/two', response: '   ' },
      { model: 'c/three', response: '' },
      { model: 'd/four', response: 4 },
      { model: 'e/five', response: null },
      { model: 'a/one', response: 'second' },
    ]);
    expect(tabs.map((tab) => tab.response)).toEqual(['  first  ', 'second']);
    expect(tabs.map((tab) => tab.sourceIndex)).toEqual([0, 5]);
  });

  it('follows the latest answer until a sample is pinned', () => {
    const tabs = answerTabsFrom([
      answer('a/one', 'early'),
      answer('b/two', 'late'),
    ]);
    expect(pickAnswerTab(tabs, null)?.response).toBe('late');
    expect(pickAnswerTab(tabs, 0)?.response).toBe('early');
    const appended = answerTabsFrom([
      answer('a/one', 'early'),
      answer('b/two', 'late'),
      answer('c/three', 'newer'),
    ]);
    expect(pickAnswerTab(appended, 0)?.response).toBe('early');
    expect(pickAnswerTab(appended, null)?.response).toBe('newer');
  });
});
