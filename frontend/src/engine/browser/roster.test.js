import { describe, expect, it } from 'vitest';

import { clearBlockedIds, dropBlockedModel, pruneRoster } from './roster.js';
import { settings } from './settings.js';

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
