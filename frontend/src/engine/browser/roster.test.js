import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearBlockedIds,
  dropBlockedModel,
  isModelUnavailable,
  pruneRoster,
  readModelCooldown,
  rememberBlockedId,
  rememberModelCooldown,
} from './roster.js';
import { settings } from './settings.js';

describe('model cooldowns', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shares a cooldown across reasoning variants, without banning the vendor', () => {
    const error = { status: 429, message: 'HTTP 429: Provider returned error', detail: 'busy' };
    const entry = rememberModelCooldown('google/model:free-reasoning-high', 600, error);
    expect(readModelCooldown('google/model:free')).toEqual(entry);
    expect(isModelUnavailable('google/model:free-reasoning')).toBe(true);
    expect(isModelUnavailable('google/other:free')).toBe(false);
    expect(isModelUnavailable('google/paid')).toBe(false);
    expect(rememberModelCooldown('google/paid', 600)).toBeNull();
  });

  it('does not shorten an existing cooldown', () => {
    vi.useFakeTimers();
    const first = rememberModelCooldown('a/one:free', 1800);
    vi.advanceTimersByTime(10000);
    expect(rememberModelCooldown('a/one:free', 600).retry_at).toBe(first.retry_at);
  });

  it('expires at the exact deadline without scheduling a background probe', () => {
    vi.useFakeTimers();
    rememberModelCooldown('a/one:free', 600);
    vi.advanceTimersByTime(599999);
    expect(isModelUnavailable('a/one:free')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isModelUnavailable('a/one:free')).toBe(false);
    expect(readModelCooldown('a/one:free')).toBeNull();
  });

  it.each(['{', 'null', '[]', '{"a/one:free":{"retry_at":"tomorrow"}}'])('ignores malformed cooldown storage %s', (stored) => {
    localStorage.setItem('llm-council-model-cooldowns', stored);
    expect(readModelCooldown('a/one:free')).toBeNull();
    expect(rememberModelCooldown('a/one:free', 600)).not.toBeNull();
    expect(isModelUnavailable('a/one:free')).toBe(true);
  });

  it('keeps cooldowns and permanent blocks when storage cannot be read or written', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full'); });
    expect(() => rememberModelCooldown('a/one:free', 600)).not.toThrow();
    expect(isModelUnavailable('a/one:free')).toBe(true);
    expect(() => rememberBlockedId('b/two:free')).not.toThrow();
    expect(isModelUnavailable('b/two:free-reasoning')).toBe(true);
  });
});

describe('pruneRoster', () => {
  it('drops a delisted model and keeps the chairman reasoning suffix', () => {
    const pruned = pruneRoster({
      councilModels: [
        'apodex/apodex-1.1-mini:free',
        'google/gemma-4-31b-it:free',
      ],
      chairmanModel: 'apodex/apodex-1.1-mini:free-reasoning-high',
      redTeamModel: 'apodex/apodex-1.1-mini:free',
    }, new Set(['google/gemma-4-31b-it:free']));

    expect(pruned.removed).toEqual(['apodex/apodex-1.1-mini:free']);
    expect(pruned.councilModels).toEqual(['google/gemma-4-31b-it:free']);
    expect(pruned.chairmanModel).toBe('google/gemma-4-31b-it:free-reasoning-high');
    expect(pruned.redTeamModel).toBe('google/gemma-4-31b-it:free');
  });

  it('drops a harness-only id that is still in the catalogue', () => {
    const pruned = pruneRoster({
      councilModels: [
        'thinkingmachines/inkling:free',
        'google/gemma-4-31b-it:free',
      ],
      chairmanModel: 'google/gemma-4-31b-it:free',
      redTeamModel: null,
    }, new Set([
      'thinkingmachines/inkling:free',
      'google/gemma-4-31b-it:free',
    ]), new Set(['thinkingmachines/inkling:free']));

    expect(pruned.councilModels).toEqual(['google/gemma-4-31b-it:free']);
    expect(pruned.removed).toEqual(['thinkingmachines/inkling:free']);
  });
});

describe('dropBlockedModel', () => {
  it('caps samples when the remaining council is all-free', () => {
    const council = [...settings.councilModels];
    const chairman = settings.chairmanModel;
    const samples = settings.nSamples;
    settings.councilModels = ['openai/gpt-4.1', 'a/one:free'];
    settings.chairmanModel = 'openai/gpt-4.1';
    settings.nSamples = 3;
    try {
      dropBlockedModel('openai/gpt-4.1');
      expect(settings.councilModels).toEqual(['a/one:free']);
      expect(settings.nSamples).toBe(1);
    } finally {
      settings.councilModels = council;
      settings.chairmanModel = chairman;
      settings.nSamples = samples;
      clearBlockedIds();
    }
  });

  it('keeps samples when a paid model remains', () => {
    const council = [...settings.councilModels];
    const chairman = settings.chairmanModel;
    const samples = settings.nSamples;
    settings.councilModels = ['openai/gpt-4.1', 'a/one:free'];
    settings.chairmanModel = 'openai/gpt-4.1';
    settings.nSamples = 3;
    try {
      dropBlockedModel('a/one:free');
      expect(settings.councilModels).toEqual(['openai/gpt-4.1']);
      expect(settings.nSamples).toBe(3);
    } finally {
      settings.councilModels = council;
      settings.chairmanModel = chairman;
      settings.nSamples = samples;
      clearBlockedIds();
    }
  });
});
