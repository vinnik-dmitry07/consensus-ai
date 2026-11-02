import { describe, expect, it, vi } from 'vitest';

import {
  classifyEndpoints,
  clearEndpointCache,
  collectAvailableFreeModels,
  draftUnchanged,
  formatFreeRosterNote,
  freeEndpointsUrl,
  inspectFreeEndpoint,
  replaceUnavailableManagedMembers,
  selectHealthyFreeRoster,
} from './freeRoster.js';
import { rememberModelCooldown } from './roster.js';
import { resetSettingsState, settings, STORAGE_KEY } from './settings.js';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function model(id, rank, extra = {}) {
  return {
    id,
    name: extra.name || id,
    weeklyRank: rank,
    pricing: { prompt: '0', completion: '0' },
    context_length: extra.context_length ?? 64000,
    max_completion_tokens: 4096,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    benchmarks: extra.benchmarks === undefined ? null : extra.benchmarks,
    ...(extra.reasoningPresent ? { reasoning: extra.reasoning } : {}),
  };
}

function healthyEndpoint(extra = {}) {
  return {
    provider_name: 'Test',
    status: 0,
    pricing: { prompt: '0', completion: '0' },
    context_length: 64000,
    max_completion_tokens: 4096,
    uptime_last_5m: 100,
    uptime_last_30m: 99,
    uptime_last_1d: 10,
    ...extra,
  };
}

function endpointFetch(endpointsFor) {
  return vi.fn(async (url) => {
    const id = [...endpointsFor.keys()].find((candidate) => String(url).includes(candidate));
    const endpoints = id ? endpointsFor.get(id) : null;
    if (!endpoints) return jsonResponse(404, {});
    return jsonResponse(200, { data: { endpoints } });
  });
}

describe('classifyEndpoints', () => {
  it('keeps the status, price, and uptime of one endpoint together', () => {
    const mixed = classifyEndpoints([
      {
        provider_name: 'Paid',
        status: 0,
        pricing: { prompt: '0.1', completion: '0.2' },
        context_length: 200000,
        uptime_last_30m: 100,
      },
      {
        provider_name: 'Free',
        status: 0,
        pricing: { prompt: '0', completion: '0' },
        context_length: 8000,
        uptime_last_30m: 3,
        uptime_last_1d: null,
      },
    ]);
    expect(mixed.state).toBe('available');
    expect(mixed.provider_name).toBe('Free');
    expect(mixed.context_length).toBe(8000);
    expect(mixed.uptime.last_30m).toBe(3);
    expect(mixed.uptime.last_1d).toBeNull();
  });

  it('does not call a paid route healthy because another route has context', () => {
    const mixed = classifyEndpoints([
      {
        provider_name: 'Paid',
        status: 0,
        pricing: { prompt: '1', completion: '1' },
        context_length: 128000,
      },
      {
        provider_name: 'Tiny',
        status: 0,
        pricing: { prompt: '0', completion: '0' },
        context_length: 1000,
      },
    ]);
    expect(mixed.state).toBe('unavailable');
    expect(mixed.reason).toBe('unsuitable-route');
  });

  it('leaves an unknown numeric status unknown instead of refusing the model', () => {
    const result = classifyEndpoints([
      healthyEndpoint({ status: 7, uptime_last_30m: 100 }),
    ]);
    expect(result.state).toBe('unknown');
    expect(result.reason).toBe('unknown-health');
  });

  it('treats a null uptime as a missing measurement on an otherwise open route', () => {
    const result = classifyEndpoints([
      healthyEndpoint({
        uptime_last_5m: null,
        uptime_last_30m: null,
        uptime_last_1d: null,
      }),
    ]);
    expect(result.state).toBe('available');
    expect(result.uptime.last_30m).toBeNull();
  });
});

describe('inspectFreeEndpoint', () => {
  it('keeps the :free suffix in the request path', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      data: { endpoints: [healthyEndpoint()] },
    }));
    await inspectFreeEndpoint('author/model:free', { fetchImpl, apiKey: 'sk-test' });
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain('/author/model:free/endpoints');
    expect(url).not.toContain('%3A');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-test');
  });

  it('does not cache a timeout, and a cancelled check throws', async () => {
    clearEndpointCache();
    const fetchImpl = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }));
    const timed = await inspectFreeEndpoint('author/model:free', {
      fetchImpl,
      timeoutMs: 15,
      apiKey: '',
    });
    expect(timed.state).toBe('unknown');
    expect(timed.reason).toBe('timeout');
    const again = await inspectFreeEndpoint('author/model:free', {
      fetchImpl,
      timeoutMs: 15,
      apiKey: '',
    });
    expect(again.cached).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const signal = AbortSignal.abort();
    await expect(inspectFreeEndpoint('author/model:free', {
      fetchImpl,
      signal,
      apiKey: '',
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('selectHealthyFreeRoster', () => {
  it('stops at available models and does not label an unchecked id healthy', async () => {
    clearEndpointCache();
    const models = [
      model('vendor/bad:free', 1),
      model('vendor/good:free', 2, {
        benchmarks: { artificial_analysis: { intelligence: 10 } },
        reasoningPresent: true,
        reasoning: { supported_efforts: ['high'] },
      }),
      model('vendor/later:free', 3),
    ];
    const fetchImpl = endpointFetch(new Map([
      ['vendor/bad:free', []],
      ['vendor/good:free', [healthyEndpoint()]],
      ['vendor/later:free', [healthyEndpoint()]],
    ]));
    const roster = await selectHealthyFreeRoster(models, {
      fetchImpl,
      apiKey: '',
      blockedIds: [],
      coolingIds: [],
      quarantinedIds: [],
      limit: 10,
      budgetMs: 8000,
    });
    expect(roster.councilModels).toEqual(['vendor/good:free', 'vendor/later:free']);
    expect(roster.chairmanModel).toBe('vendor/good:free-reasoning-high');
    expect(roster.excluded.some((row) => row.id === 'vendor/bad:free' && row.reason === 'unsuitable-route')).toBe(true);
    expect(roster.excluded.some((row) => row.id === 'vendor/later:free')).toBe(false);
    expect(freeEndpointsUrl('vendor/good:free')).toContain(':free');
  });

  it('does not apply a fallback when the caller cancels', async () => {
    const signal = AbortSignal.abort();
    await expect(selectHealthyFreeRoster([
      model('vendor/good:free', 1),
    ], { signal, fetchImpl: vi.fn() })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('names the real exclusion and never calls it low uptime', async () => {
    const note = formatFreeRosterNote({
      fallback: 'size',
      chairmanBasis: 'order',
      excluded: [
        { id: 'vendor/slow:free', reason: 'cooldown' },
        { id: 'vendor/old:free', reason: 'unknown-health' },
      ],
    });
    expect(note).toContain('previous size ranking');
    expect(note).toContain('Cooling down: vendor/slow:free');
    expect(note).toContain('Endpoint health unknown: vendor/old:free');
    expect(note.toLowerCase()).not.toContain('low uptime');
  });
});

describe('replaceUnavailableManagedMembers', () => {
  it('keeps a manual roster even when a member is cooling down', async () => {
    localStorage.clear();
    resetSettingsState();
    settings.councilModels = ['vendor/cooling:free', 'vendor/kept:free'];
    settings.chairmanModel = 'vendor/kept:free';
    settings.updateFromDict({
      council_models: ['vendor/cooling:free', 'vendor/kept:free'],
      chairman_model: 'vendor/kept:free',
      free_roster_managed: false,
    });
    rememberModelCooldown('vendor/cooling:free', 600);
    const fetchImpl = vi.fn();
    const result = await replaceUnavailableManagedMembers([
      model('vendor/spare:free', 1),
    ], new Set(['vendor/cooling:free', 'vendor/kept:free', 'vendor/spare:free']), { fetchImpl });
    expect(result.changed).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(settings.councilModels).toEqual(['vendor/cooling:free', 'vendor/kept:free']);
  });

  it('replaces only the unavailable member of a managed roster and keeps the red team', async () => {
    localStorage.clear();
    resetSettingsState();
    const stored = {
      council_models: ['vendor/cooling:free', 'vendor/kept:free'],
      chairman_model: 'vendor/kept:free',
      red_team_model: 'vendor/kept:free',
      n_samples: 1,
      top_k: 3,
      self_exclusion: true,
      api_key: 'sk-test',
      use_free_tier_default: false,
      free_roster_managed: true,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    resetSettingsState();
    rememberModelCooldown('vendor/cooling:free', 600);
    const fetchImpl = endpointFetch(new Map([
      ['vendor/spare:free', [healthyEndpoint()]],
    ]));
    const result = await replaceUnavailableManagedMembers([
      model('vendor/cooling:free', 1),
      model('vendor/kept:free', 2),
      model('vendor/spare:free', 3),
    ], new Set([
      'vendor/cooling:free',
      'vendor/kept:free',
      'vendor/spare:free',
    ]), {
      fetchImpl,
      apiKey: '',
      blockedIds: [],
      coolingIds: new Set(['vendor/cooling:free']),
      quarantinedIds: [],
    });
    expect(result.changed).toBe(true);
    expect(result.councilModels).toEqual(['vendor/spare:free', 'vendor/kept:free']);
    expect(settings.chairmanModel).toBe('vendor/kept:free');
    expect(settings.redTeamModel).toBe('vendor/kept:free');
    expect(settings.freeRosterManaged).toBe(true);
    expect(draftUnchanged(
      { councilModels: ['vendor/cooling:free'], chairmanModel: 'vendor/kept:free' },
      { councilModels: ['vendor/spare:free'], chairmanModel: 'vendor/kept:free' },
    )).toBe(false);
  });

  it('does not write when the roster changes while replacements are loading', async () => {
    localStorage.clear();
    resetSettingsState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      council_models: ['vendor/cooling:free'],
      chairman_model: 'vendor/cooling:free',
      red_team_model: null,
      n_samples: 1,
      top_k: 3,
      self_exclusion: true,
      api_key: null,
      use_free_tier_default: false,
      free_roster_managed: true,
    }));
    resetSettingsState();
    rememberModelCooldown('vendor/cooling:free', 600);
    const fetchImpl = vi.fn(async () => {
      settings.councilModels = ['openai/gpt-4.1'];
      settings.chairmanModel = 'openai/gpt-4.1';
      return jsonResponse(200, { data: { endpoints: [healthyEndpoint()] } });
    });
    const result = await replaceUnavailableManagedMembers([
      model('vendor/spare:free', 1),
    ], new Set(['vendor/cooling:free', 'vendor/spare:free']), {
      fetchImpl,
      coolingIds: new Set(['vendor/cooling:free']),
      blockedIds: [],
      quarantinedIds: [],
    });
    expect(result.changed).toBe(false);
    expect(settings.councilModels).toEqual(['openai/gpt-4.1']);
  });
});

describe('collectAvailableFreeModels', () => {
  it('keeps eligible models when every endpoint check times out', async () => {
    clearEndpointCache();
    const fetchImpl = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }));
    const collected = await collectAvailableFreeModels([
      model('vendor/one:free', 1),
      model('vendor/two:free', 2),
      model('vendor/bad:free', 3),
    ], {
      fetchImpl,
      timeoutMs: 15,
      budgetMs: 8000,
      apiKey: '',
      blockedIds: [],
      coolingIds: [],
      quarantinedIds: [],
    });
    expect(collected.ids).toEqual(['vendor/one:free', 'vendor/two:free', 'vendor/bad:free']);
    expect(collected.excluded).toEqual([]);
  });

  it('prefers a confirmed route and only then fills from unknown checks', async () => {
    clearEndpointCache();
    const fetchImpl = vi.fn((_url, init) => {
      const url = String(_url);
      if (url.includes('vendor/good:free')) {
        return jsonResponse(200, { data: { endpoints: [healthyEndpoint()] } });
      }
      if (url.includes('vendor/dead:free')) {
        return jsonResponse(200, { data: { endpoints: [] } });
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    });
    const collected = await collectAvailableFreeModels([
      model('vendor/good:free', 1),
      model('vendor/dead:free', 2),
      model('vendor/late:free', 3),
    ], {
      fetchImpl,
      timeoutMs: 15,
      budgetMs: 8000,
      apiKey: '',
      blockedIds: [],
      coolingIds: [],
      quarantinedIds: [],
      limit: 2,
    });
    expect(collected.ids).toEqual(['vendor/good:free', 'vendor/late:free']);
    expect(collected.excluded.some((row) => row.id === 'vendor/dead:free')).toBe(true);
  });

  it('does not mix a checked model into the result when the budget is already spent', async () => {
    clearEndpointCache();
    const fetchImpl = vi.fn();
    const collected = await collectAvailableFreeModels([
      model('vendor/one:free', 1),
    ], {
      fetchImpl,
      budgetMs: 0,
      now: 1000,
      blockedIds: [],
      coolingIds: [],
      quarantinedIds: [],
    });
    expect(collected.ids).toEqual([]);
    expect(collected.excluded.some((row) => row.reason === 'unchecked')).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
