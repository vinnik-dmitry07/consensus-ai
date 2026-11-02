import { describe, expect, it, vi } from 'vitest';

import { applyFreeTierDefaultRoster } from './freeRoster.js';
import {
  accountRateLimitKind,
  chooseFreeChairman,
  clearBlockedIds,
  clearUpstreamIncidents,
  dropBlockedModel,
  freeTierDefaultRoster,
  intelligenceScore,
  modelIsQuarantined,
  pruneRoster,
  rankTopFreeModels,
  recordUpstreamIncident,
  rememberModelCooldown,
  selectFreeCandidateIds,
  supportsReasoningHigh,
  UPSTREAM_QUARANTINE_MS,
  UPSTREAM_STRIKE_WINDOW_MS,
  runAllowedBySettings,
  stage1SampleLimit,
  storePrunedRoster,
} from './roster.js';
import {
  resetSettingsState,
  SETTINGS_CHANGED_EVENT,
  STORAGE_KEY,
  settings,
} from './settings.js';

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

  it('does not backfill a short manual council from a wide catalogue', () => {
    const known = new Set([
      'thinkingmachines/inkling:free',
      'test/alpha-10b:free',
      'test/bravo-90b:free',
      'test/charlie-80b:free',
    ]);
    const pruned = pruneRoster({
      councilModels: ['thinkingmachines/inkling:free', 'test/alpha-10b:free'],
      chairmanModel: 'test/alpha-10b:free',
      redTeamModel: null,
    }, known, new Set(['thinkingmachines/inkling:free']));

    expect(pruned.councilModels).toEqual(['test/alpha-10b:free']);
    expect(pruned.removed).toEqual(['thinkingmachines/inkling:free']);
  });
});

function freeRow(id, name = id, description = '', extra = {}) {
  return {
    id,
    name,
    description,
    pricing: extra.pricing || { prompt: '0', completion: '0' },
    context_length: extra.context_length ?? 32000,
    max_completion_tokens: extra.max_completion_tokens ?? 4096,
    architecture: extra.architecture || {
      input_modalities: ['text'],
      output_modalities: ['text'],
    },
  };
}

describe('rankTopFreeModels', () => {
  const tenFamilies = [
    'alpha', 'bravo', 'charlie', 'delta', 'echo',
    'foxtrot', 'golf', 'hotel', 'india', 'juliet',
  ];

  it('skips blocked inkling ids and keeps the next ten families', () => {
    const models = [
      freeRow('thinkingmachines/inkling-900b:free', 'Inkling'),
      freeRow('thinkingmachines/inkling-small-800b:free', 'Inkling Small'),
      ...tenFamilies.map((name, index) => freeRow(`test/${name}-${100 - index}b:free`, name)),
    ];
    const blocked = new Set([
      'thinkingmachines/inkling-900b:free',
      'thinkingmachines/inkling-small-800b:free',
    ]);

    const ranked = rankTopFreeModels(models, blocked);

    expect(blocked.size).toBe(2);
    expect(ranked).toEqual(tenFamilies.map((name, index) => `test/${name}-${100 - index}b:free`));
  });

  it('lets a smaller sibling represent a family whose leader is blocked', () => {
    const ranked = rankTopFreeModels([
      freeRow('test/alpha-100b:free', 'Alpha Big'),
      freeRow('test/alpha-mini-10b:free', 'Alpha Mini'),
      freeRow('test/bravo-50b:free', 'Bravo'),
    ], ['test/alpha-100b:free']);

    expect(ranked).toEqual([
      'test/bravo-50b:free',
      'test/alpha-mini-10b:free',
    ]);
  });

  it('fills a short family list without displacing a smaller representative', () => {
    const representatives = [
      ['alpha', 200],
      ['charlie', 80],
      ['delta', 70],
      ['echo', 60],
      ['foxtrot', 50],
      ['golf', 40],
      ['hotel', 30],
      ['india', 20],
      ['bravo', 10],
    ];
    const ranked = rankTopFreeModels([
      ...representatives.map(([name, size]) => freeRow(`test/${name}-${size}b:free`, name)),
      freeRow('test/alpha-90b:free', 'Alpha Second'),
      freeRow('test/charlie-5b:free', 'Charlie Tiny'),
    ], []);

    expect(ranked).toEqual([
      ...representatives.map(([name, size]) => `test/${name}-${size}b:free`),
      'test/alpha-90b:free',
    ]);
  });

  it('stops at ten family representatives when more families exist', () => {
    const families = [...tenFamilies, 'kilo'];
    const ranked = rankTopFreeModels([
      ...families.map((name, index) => freeRow(`test/${name}-${200 - index}b:free`, name)),
      freeRow('test/alpha-190b:free', 'Alpha Second'),
    ], []);

    expect(ranked).toEqual(tenFamilies.map((name, index) => `test/${name}-${200 - index}b:free`));
  });

  it.each([
    'vendor/mycode-70b:free',
    'vendor/coder-70b:free',
    'vendor/codestral-70b:free',
    'vendor/devstral-70b:free',
    'vendor/starcoder-70b:free',
    'vendor/safety-70b:free',
    'vendor/guard-70b:free',
    'vendor/omni-70b:free',
    'vendor/model-fin:free',
    'vendor/model-sante:free',
    'vendor/alpha-70b',
  ])('skips %s', (id) => {
    expect(rankTopFreeModels([
      freeRow(id, 'Skipped'),
      freeRow('test/refine-20b:free', 'Refine'),
    ], [])).toEqual(['test/refine-20b:free']);
  });

  it('reads size from the first positive source and keeps an unknown size', () => {
    const ranked = rankTopFreeModels([
      freeRow('test/alpha-10b:free', 'Alpha 900b', '2t'),
      freeRow('test/bravo:free', 'Bravo', '50b'),
      freeRow('test/charlie-2b-or-80b:free', 'Charlie'),
      freeRow('test/delta-1.5t:free', 'Delta'),
      freeRow('test/echo:free', 'Echo'),
    ], []);

    expect(ranked).toEqual([
      'test/delta-1.5t:free',
      'test/charlie-2b-or-80b:free',
      'test/bravo:free',
      'test/alpha-10b:free',
      'test/echo:free',
    ]);
  });

  it('keeps the greater display name inside a family and sorts families by the lesser name', () => {
    const ranked = rankTopFreeModels([
      freeRow('test/alpha-10b:free', 'Beta'),
      freeRow('test/alpha-mini-10b:free', 'Alpha'),
      freeRow('test/bravo-10b:free', 'Amy'),
      freeRow('test/charlie-10b:free', 'Amy'),
    ], []);

    expect(ranked).toEqual([
      'test/bravo-10b:free',
      'test/charlie-10b:free',
      'test/alpha-10b:free',
      'test/alpha-mini-10b:free',
    ]);
  });

  it('fills equal models in catalogue order and ignores a later duplicate id', () => {
    const models = [
      freeRow('test/alpha-one:free', 'Same', '10b'),
      freeRow('test/alpha-two:free', 'Same', '10b'),
      freeRow('test/alpha-three:free', 'Same', '10b'),
      freeRow('test/bravo-10b:free', 'First'),
      freeRow('test/bravo-10b:free-reasoning-high', 'Later', '900b'),
    ];
    const blocked = [];
    const snapshot = models.map((model) => ({ ...model }));

    expect(rankTopFreeModels(models, blocked, 0)).toEqual([]);
    expect(rankTopFreeModels(models, blocked, 2)).toEqual([
      'test/bravo-10b:free',
      'test/alpha-one:free',
    ]);
    expect(rankTopFreeModels(models, blocked)).toEqual([
      'test/bravo-10b:free',
      'test/alpha-one:free',
      'test/alpha-two:free',
      'test/alpha-three:free',
    ]);
    expect(models).toEqual(snapshot);
    expect(blocked).toEqual([]);
  });

  it('returns a short catalogue unchanged in length', () => {
    expect(rankTopFreeModels([], [])).toEqual([]);
    expect(rankTopFreeModels([
      freeRow('test/alpha-10b:free', 'Alpha'),
    ], new Set())).toEqual(['test/alpha-10b:free']);
  });

  it('does not exclude a model that is cooling down', () => {
    const models = [
      freeRow('test/alpha-100b:free', 'Alpha'),
      freeRow('test/bravo-10b:free', 'Bravo'),
    ];
    const before = rankTopFreeModels(models, []);
    rememberModelCooldown('test/alpha-100b:free', 600);
    expect(rankTopFreeModels(models, [])).toEqual(before);
    expect(before).toEqual([
      'test/alpha-100b:free',
      'test/bravo-10b:free',
    ]);
  });
});

describe('freeTierDefaultRoster', () => {
  it('uses the ranked free list, reasoning-high chairman, and one sample', () => {
    const models = [
      freeRow('test/alpha-100b:free', 'Alpha'),
      freeRow('test/bravo-50b:free', 'Bravo'),
    ];
    const blocked = [];
    const roster = freeTierDefaultRoster(models, blocked);
    expect(roster.councilModels).toEqual(rankTopFreeModels(models, blocked));
    expect(roster.chairmanModel).toBe(`${roster.councilModels[0]}-reasoning-high`);
    expect(roster.nSamples).toBe(1);
  });

  it('returns an empty council and chairman when nothing ranks', () => {
    expect(freeTierDefaultRoster([], [])).toEqual({
      councilModels: [],
      chairmanModel: '',
      nSamples: 1,
    });
    expect(freeTierDefaultRoster([freeRow('openai/gpt-4.1', 'GPT')], [])).toEqual({
      councilModels: [],
      chairmanModel: '',
      nSamples: 1,
    });
  });

  it('does not write when the pending-free flag is already cleared', async () => {
    const council = [...settings.councilModels];
    const chairman = settings.chairmanModel;
    settings.councilModels = ['openai/gpt-4.1'];
    settings.chairmanModel = 'openai/gpt-4.1';
    try {
      expect(settings.useFreeTierDefault).toBe(false);
      expect(await applyFreeTierDefaultRoster([
        freeRow('test/alpha-100b:free', 'Alpha'),
      ])).toBe(false);
      expect(settings.councilModels).toEqual(['openai/gpt-4.1']);
      expect(settings.chairmanModel).toBe('openai/gpt-4.1');
    } finally {
      settings.councilModels = council;
      settings.chairmanModel = chairman;
    }
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

describe('personal key gate', () => {
  const free = ['a/one:free', 'b/two:free'];

  it('does not change the all-free sample cap when the chairman is paid', () => {
    expect(stage1SampleLimit(free, 3)).toBe(1);
  });

  it('treats an incomplete settings snapshot as not runnable', () => {
    expect(runAllowedBySettings(null)).toBe(false);
    expect(runAllowedBySettings({ has_api_key: false })).toBe(false);
    expect(runAllowedBySettings({ has_api_key: true })).toBe(true);
  });
});

describe('storePrunedRoster', () => {
  it('notifies once after the roster fields are stored', () => {
    const types = [];
    vi.stubGlobal('window', {
      dispatchEvent: (event) => types.push(event.type),
    });
    try {
      storePrunedRoster({
        councilModels: ['a/one:free'],
        chairmanModel: 'a/one:free',
        redTeamModel: null,
      });
      settings.nSamples = 1;
      expect(types).toEqual([SETTINGS_CHANGED_EVENT]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps free_roster_managed when a prune save repeats the flag', () => {
    localStorage.clear();
    resetSettingsState();
    settings.updateFromDict({
      council_models: ['a/one:free', 'b/two:free'],
      chairman_model: 'a/one:free',
      free_roster_managed: true,
    });
    expect(settings.freeRosterManaged).toBe(true);
    settings.updateFromDict({
      council_models: ['a/one:free'],
      chairman_model: 'a/one:free',
      free_roster_managed: true,
    });
    expect(settings.freeRosterManaged).toBe(true);
    settings.updateFromDict({
      council_models: ['b/two:free'],
      chairman_model: 'b/two:free',
    });
    expect(settings.freeRosterManaged).toBe(false);
  });

  it('keeps a pending free-tier document when storing a pruned roster', () => {
    localStorage.clear();
    resetSettingsState();
    expect(settings.useFreeTierDefault).toBe(true);
    storePrunedRoster({
      councilModels: ['~openai/gpt-sol-latest'],
      chairmanModel: '~openai/gpt-sol-latest-reasoning-high',
      redTeamModel: null,
    });
    expect(settings.useFreeTierDefault).toBe(true);
    expect(settings.councilModels).toEqual(['~openai/gpt-sol-latest']);
    expect(settings.chairmanModel).toBe('~openai/gpt-sol-latest-reasoning-high');
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(stored.use_free_tier_default).toBe(true);
    expect(stored.council_models).toEqual(['~openai/gpt-sol-latest']);
  });
});

function weeklyRow(id, rank, extra = {}) {
  return {
    id,
    name: extra.name || id,
    description: extra.description || '',
    weeklyRank: rank,
    pricing: { prompt: '0', completion: '0', ...(extra.pricing || {}) },
    context_length: extra.context_length ?? 32000,
    max_completion_tokens: extra.max_completion_tokens ?? 4096,
    architecture: extra.architecture || {
      input_modalities: ['text'],
      output_modalities: ['text'],
    },
    ...('reasoning' in extra ? { reasoning: extra.reasoning } : {}),
    benchmarks: extra.benchmarks === undefined ? null : extra.benchmarks,
  };
}

describe('selectFreeCandidateIds', () => {
  it('orders eligible models by weekly rank and keeps coder models', () => {
    const ranked = selectFreeCandidateIds([
      weeklyRow('vendor/coder-70b:free', 3, { name: 'Coder' }),
      weeklyRow('vendor/zeta-1b:free', 1, { name: 'Zeta' }),
      weeklyRow('vendor/alpha-900b:free', 2, { name: 'Alpha', description: 'beats a 2t model' }),
      weeklyRow('vendor/safety-1b:free', 0, { name: 'Safety', weeklyRank: 0 }),
    ], { blockedIds: [], coolingIds: [], quarantinedIds: [] });
    expect(ranked.fallback).toBeNull();
    expect(ranked.ids).toEqual([
      'vendor/zeta-1b:free',
      'vendor/alpha-900b:free',
      'vendor/coder-70b:free',
    ]);
    expect(ranked.excluded.some((row) => row.reason === 'service')).toBe(true);
  });

  it('drops blocked, cooling, and quarantined ids without using size', () => {
    const ranked = selectFreeCandidateIds([
      weeklyRow('vendor/cooling:free', 1),
      weeklyRow('vendor/blocked:free', 2),
      weeklyRow('vendor/quarantine:free', 3),
      weeklyRow('vendor/kept:free', 4),
    ], {
      blockedIds: ['vendor/blocked:free'],
      coolingIds: ['vendor/cooling:free'],
      quarantinedIds: ['vendor/quarantine:free'],
    });
    expect(ranked.ids).toEqual(['vendor/kept:free']);
    expect(ranked.excluded.map((row) => row.reason).sort()).toEqual(['blocked', 'cooldown', 'quarantine']);
  });

  it('falls back to the size ranking when no weekly order exists', () => {
    const models = [
      freeRow('vendor/coder-70b:free', 'Coder'),
      freeRow('test/alpha-10b:free', 'Alpha'),
      freeRow('test/bravo-50b:free', 'Bravo'),
    ];
    const ranked = selectFreeCandidateIds(models, {
      blockedIds: [],
      coolingIds: ['test/bravo-50b:free'],
      quarantinedIds: [],
    });
    expect(ranked.fallback).toBe('size');
    expect(ranked.ids).toEqual(['test/alpha-10b:free']);
    expect(ranked.excluded).toEqual([{ id: 'test/bravo-50b:free', reason: 'cooldown' }]);
  });

  it('applies the same eligibility rules on the size fallback', () => {
    const ranked = selectFreeCandidateIds([
      freeRow('test/paid-80b:free', 'Paid', '', { pricing: { prompt: '1', completion: '1' } }),
      freeRow('test/vision-70b:free', 'Vision', '', {
        architecture: { input_modalities: ['image'], output_modalities: ['text'] },
      }),
      freeRow('test/tiny-60b:free', 'Tiny', '', { context_length: 1024 }),
      freeRow('test/kept-10b:free', 'Kept'),
    ], { blockedIds: [], coolingIds: [], quarantinedIds: [] });
    expect(ranked.fallback).toBe('size');
    expect(ranked.ids).toEqual(['test/kept-10b:free']);
    expect(ranked.excluded.map((row) => row.reason).sort()).toEqual(['context', 'not-text', 'paid-price']);
  });

  it('does not treat a provider daily quota as the account free-day cap', () => {
    expect(accountRateLimitKind('Rate limit exceeded: free-models-per-min')).toBe('minute');
    expect(accountRateLimitKind(
      'Rate limit exceeded: free-models-per-day',
      { limit_source: 'account' },
    )).toBe('day');
    expect(accountRateLimitKind('Provider daily limit exceeded', { limit_source: 'upstream' })).toBeNull();
    expect(accountRateLimitKind('per-day quota', { limit_source: 'upstream' })).toBeNull();
  });

  it('does not treat a null intelligence score as zero', () => {
    const missing = weeklyRow('vendor/none:free', 1, { benchmarks: null });
    const zero = weeklyRow('vendor/zero:free', 2, {
      benchmarks: { artificial_analysis: { intelligence: 0 } },
    });
    const scored = weeklyRow('vendor/scored:free', 3, {
      benchmarks: { artificial_analysis: { intelligence: 40 } },
    });
    expect(intelligenceScore(missing)).toBeNull();
    expect(intelligenceScore(zero)).toBe(0);
    const chairman = chooseFreeChairman(
      ['vendor/none:free', 'vendor/zero:free', 'vendor/scored:free'],
      [missing, zero, scored],
    );
    expect(chairman.basis).toBe('intelligence');
    expect(chairman.chairmanModel).toBe('vendor/scored:free');
  });

  it('uses reasoning-high only when that effort is listed', () => {
    const absent = weeklyRow('vendor/absent:free', 1);
    const empty = weeklyRow('vendor/empty:free', 2, { reasoning: null });
    const high = weeklyRow('vendor/high:free', 3, {
      reasoning: { supported_efforts: ['high'] },
    });
    expect(supportsReasoningHigh(absent)).toBe(false);
    expect(supportsReasoningHigh(empty)).toBe(false);
    expect(supportsReasoningHigh(high)).toBe(true);
    expect(chooseFreeChairman(['vendor/absent:free'], [absent]).chairmanModel).toBe('vendor/absent:free');
    expect(chooseFreeChairman(['vendor/high:free'], [high]).chairmanModel).toBe('vendor/high:free-reasoning-high');
  });

  it('does not promote the only scored model above an unscored weekly leader for the council order', () => {
    const leader = weeklyRow('vendor/leader:free', 1, { benchmarks: null });
    const scored = weeklyRow('vendor/scored:free', 2, {
      benchmarks: { artificial_analysis: { intelligence: 80 } },
    });
    const ranked = selectFreeCandidateIds([scored, leader], {
      blockedIds: [],
      coolingIds: [],
      quarantinedIds: [],
    });
    expect(ranked.ids).toEqual(['vendor/leader:free', 'vendor/scored:free']);
  });
});

describe('upstream quarantine window', () => {
  it('quarantines on the third distinct run and starts clean after expiry', () => {
    clearUpstreamIncidents();
    const start = 1_000_000;
    expect(recordUpstreamIncident('a/one:free', 'run-1', start).strikes).toBe(1);
    expect(recordUpstreamIncident('a/one:free', 'run-1', start + 10).strikes).toBe(1);
    expect(recordUpstreamIncident('a/one:free', 'run-2', start + 20).strikes).toBe(2);
    const third = recordUpstreamIncident('a/one:free', 'run-3', start + 30);
    expect(third.quarantined).toBe(true);
    expect(modelIsQuarantined('a/one:free', start + 30)).toBe(true);
    expect(recordUpstreamIncident('a/one:free', 'run-4', start + 40).quarantined).toBe(true);
    const after = start + 30 + UPSTREAM_QUARANTINE_MS + 1;
    expect(modelIsQuarantined('a/one:free', after)).toBe(false);
    expect(recordUpstreamIncident('a/one:free', 'run-5', after).strikes).toBe(1);
    const later = after + UPSTREAM_STRIKE_WINDOW_MS + 5;
    expect(recordUpstreamIncident('a/one:free', 'run-6', later).strikes).toBe(1);
    clearUpstreamIncidents();
  });
});
