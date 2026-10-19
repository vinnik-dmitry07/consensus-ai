import { describe, expect, it, vi } from 'vitest';

import {
  clearBlockedIds,
  dropBlockedModel,
  pruneRoster,
  rankTopFreeModels,
  rememberModelCooldown,
  rosterRequiresUserKey,
  runAllowedBySettings,
  stage1SampleLimit,
  storePrunedRoster,
} from './roster.js';
import {
  DEFAULT_CHAIRMAN_MODEL,
  DEFAULT_COUNCIL_MODELS,
  DEFAULT_RED_TEAM_MODEL,
  SETTINGS_CHANGED_EVENT,
} from './settings.js';
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

function freeRow(id, name = id, description = '') {
  return { id, name, description };
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

describe('rosterRequiresUserKey', () => {
  const free = ['a/one:free', 'b/two:free'];

  it.each([
    [free, 'a/one:free', null, false],
    [free, 'a/one:free', 'b/two:free-reasoning-high', false],
    [['a/one:free', 'openai/gpt-4.1'], 'a/one:free', null, true],
    [free, 'openai/gpt-4.1', null, true],
    [free, 'a/one:free', 'openai/gpt-4.1', true],
    [[], 'a/one:free', null, true],
    [null, 'a/one:free', null, true],
    [free, '', null, true],
    [free, null, null, true],
    [DEFAULT_COUNCIL_MODELS, DEFAULT_CHAIRMAN_MODEL, DEFAULT_RED_TEAM_MODEL, true],
    [['vendor/name:free-extra'], 'vendor/name:free-extra', null, true],
    [['vendor/name:free-reasoning'], 'vendor/name:free-reasoning-high', null, false],
  ])('council %j chairman %j red %j requires key %s', (council, chairman, redTeam, requires) => {
    expect(rosterRequiresUserKey(council, chairman, redTeam)).toBe(requires);
  });

  it('does not change the all-free sample cap when the chairman is paid', () => {
    expect(stage1SampleLimit(free, 3)).toBe(1);
    expect(rosterRequiresUserKey(free, 'openai/gpt-4.1', null)).toBe(true);
  });

  it('treats an incomplete settings snapshot as not runnable', () => {
    expect(runAllowedBySettings(null)).toBe(false);
    expect(runAllowedBySettings({ has_api_key: false })).toBe(false);
    expect(runAllowedBySettings({
      has_api_key: false,
      council_models: free,
      chairman_model: 'a/one:free',
    })).toBe(false);
    expect(runAllowedBySettings({
      has_api_key: true,
      council_models: ['openai/gpt-4.1'],
      chairman_model: 'openai/gpt-4.1',
      red_team_model: null,
    })).toBe(true);
    expect(runAllowedBySettings({
      has_api_key: false,
      council_models: free,
      chairman_model: 'a/one:free-reasoning-high',
      red_team_model: null,
    })).toBe(true);
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
});
