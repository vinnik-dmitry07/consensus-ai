/**
 * Free-roster selection. Network calls live here so roster.js can stay a
 * pure rules module. Endpoint uptime is recorded and is not a filter.
 */

import { OPENROUTER_MODELS_URL, timeoutReason } from './openrouter.js';
import {
  catalogueId,
  chooseFreeChairman,
  contextFitsRole,
  priceVerdict,
  readBlockedIds,
  RosterEmpty,
  readCoolingIds,
  readQuarantinedIds,
  selectFreeCandidateIds,
  storePrunedRoster,
  supportsTextChat,
} from './roster.js';
import { normalizeMode, notifySettingsChanged, sameStringList, settings } from './settings.js';

export const ENDPOINT_CONCURRENCY = 5;
export const ENDPOINT_TIMEOUT_MS = 4000;
export const SELECTION_BUDGET_MS = 8000;
export const ENDPOINT_CACHE_MS = 10 * 60 * 1000;

const endpointCache = new Map();

export function clearEndpointCache() {
  endpointCache.clear();
}

export function freeEndpointsUrl(modelId) {
  const id = String(modelId || '');
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return null;
  const author = id.slice(0, slash);
  const slug = id.slice(slash + 1);
  const encode = (part) => encodeURIComponent(part).replace(/%3A/gi, ':');
  return `${OPENROUTER_MODELS_URL}/${encode(author)}/${encode(slug)}/endpoints`;
}

function endpointUptime(endpoint) {
  return {
    last_5m: endpoint?.uptime_last_5m ?? null,
    last_30m: endpoint?.uptime_last_30m ?? null,
    last_1d: endpoint?.uptime_last_1d ?? null,
  };
}

function endpointTextOk(endpoint) {
  const hasModality = endpoint
    && (
      endpoint.input_modalities != null
      || endpoint.output_modalities != null
      || endpoint.modality != null
      || endpoint.architecture
    );
  if (!hasModality) return true;
  return supportsTextChat({
    architecture: endpoint.architecture || {
      input_modalities: endpoint.input_modalities,
      output_modalities: endpoint.output_modalities,
      modality: endpoint.modality,
    },
  });
}

function endpointContextOk(endpoint) {
  return contextFitsRole({
    context_length: endpoint?.context_length,
    max_completion_tokens: endpoint?.max_completion_tokens,
  }, 'council');
}

/**
 * Decide from one provider list. A suitable route must itself be free,
 * text-capable, large enough, and status 0. Fields are never borrowed
 * from a different provider on the same model.
 */
export function classifyEndpoints(endpoints) {
  const blank = {
    uptime: null,
    status: null,
    provider_name: null,
    context_length: null,
    max_completion_tokens: null,
  };
  if (!Array.isArray(endpoints)) {
    return { state: 'unknown', reason: 'incomplete', ...blank };
  }
  if (!endpoints.length) {
    return { state: 'unavailable', reason: 'unsuitable-route', ...blank };
  }
  let proven = 0;
  for (const endpoint of endpoints) {
    if (!endpoint || typeof endpoint !== 'object') continue;
    const prices = priceVerdict(endpoint.pricing);
    const textOk = endpointTextOk(endpoint);
    const contextOk = endpointContextOk(endpoint);
    const unsuitable = prices === 'paid' || !textOk || !contextOk;
    if (unsuitable) {
      proven += 1;
      continue;
    }
    if (prices === 'free' && endpoint.status === 0) {
      return {
        state: 'available',
        reason: null,
        uptime: endpointUptime(endpoint),
        status: 0,
        provider_name: endpoint.provider_name ?? null,
        context_length: endpoint.context_length ?? null,
        max_completion_tokens: endpoint.max_completion_tokens ?? null,
      };
    }
  }
  if (proven === endpoints.length) {
    return { state: 'unavailable', reason: 'unsuitable-route', ...blank };
  }
  return { state: 'unknown', reason: 'unknown-health', ...blank };
}

function abortError(signal) {
  return signal?.reason || new DOMException('Aborted', 'AbortError');
}

function cachedCheck(modelId, now) {
  const hit = endpointCache.get(modelId);
  if (!hit) return null;
  if (now - hit.at >= ENDPOINT_CACHE_MS) {
    endpointCache.delete(modelId);
    return null;
  }
  return hit.result;
}

function rememberCheck(modelId, result, now) {
  if (result.state === 'unknown') return;
  endpointCache.set(modelId, { at: now, result });
}

export async function inspectFreeEndpoint(modelId, options = {}) {
  const now = options.now ?? Date.now();
  if (options.signal?.aborted) throw abortError(options.signal);
  const id = String(modelId || '');
  if (!id.endsWith(':free')) {
    return { state: 'unavailable', reason: 'unsuitable-route', id };
  }
  const cached = cachedCheck(id, now);
  if (cached) return { ...cached, id, cached: true };
  const url = freeEndpointsUrl(id);
  if (!url) return { state: 'unknown', reason: 'incomplete', id };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? ENDPOINT_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal.reason);
  if (options.signal) {
    if (options.signal.aborted) throw abortError(options.signal);
    options.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(timeoutReason()), timeoutMs);
  const apiKey = options.apiKey ?? settings.apiKey;
  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (options.signal?.aborted) throw abortError(options.signal);
    if (response.status === 404) {
      const result = { state: 'unavailable', reason: 'unsuitable-route', id, status: 404 };
      rememberCheck(id, result, options.now ?? Date.now());
      return result;
    }
    if (!response.ok) return { state: 'unknown', reason: 'unknown-health', id, status: response.status };
    let payload;
    try {
      payload = await response.json();
    } catch {
      return { state: 'unknown', reason: 'incomplete', id };
    }
    const endpoints = payload?.data?.endpoints ?? payload?.endpoints;
    const classified = classifyEndpoints(endpoints);
    const result = { ...classified, id };
    rememberCheck(id, result, options.now ?? Date.now());
    return result;
  } catch (exc) {
    if (options.signal?.aborted) throw abortError(options.signal);
    const timedOut = exc?.name === 'TimeoutError' || exc?.name === 'AbortError';
    return {
      state: 'unknown',
      reason: timedOut ? 'timeout' : 'unknown-health',
      id,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function liveObstacles(options) {
  return {
    blockedIds: options.blockedIds ?? readBlockedIds(),
    coolingIds: options.coolingIds ?? readCoolingIds(),
    quarantinedIds: options.quarantinedIds ?? readQuarantinedIds(),
    excludeIds: options.excludeIds,
    poolLimit: options.poolLimit,
  };
}

export async function collectAvailableFreeModels(models, options = {}) {
  const signal = options.signal;
  if (signal?.aborted) throw abortError(signal);
  const limit = Math.max(0, Math.trunc(Number(options.limit ?? 10)));
  const selected = selectFreeCandidateIds(models, liveObstacles(options));
  const excluded = [...selected.excluded];
  if (!limit || !selected.ids.length) {
    return { ...selected, ids: selected.ids.slice(0, limit), excluded, checks: [] };
  }
  const started = options.now ?? Date.now();
  const deadline = started + (options.budgetMs ?? SELECTION_BUDGET_MS);
  const queue = [...selected.ids];
  const ids = [];
  const unknown = [];
  const clock = () => options.now ?? Date.now();

  while (queue.length && ids.length < limit) {
    if (signal?.aborted) throw abortError(signal);
    const remaining = deadline - clock();
    if (remaining <= 0) break;
    const batch = queue.splice(0, Math.min(ENDPOINT_CONCURRENCY, queue.length));
    const timeoutMs = Math.min(options.timeoutMs ?? ENDPOINT_TIMEOUT_MS, remaining);
    const results = await Promise.all(batch.map((id) => inspectFreeEndpoint(id, {
      ...options,
      timeoutMs,
      signal,
    })));
    for (const result of results) {
      if (result.state === 'available') {
        if (ids.length < limit) ids.push(result.id);
        continue;
      }
      if (result.state === 'unknown') {
        unknown.push({ id: result.id, reason: result.reason || 'unknown-health' });
        continue;
      }
      excluded.push({ id: result.id, reason: result.reason || result.state });
    }
  }
  for (const row of unknown) {
    if (ids.length < limit) ids.push(row.id);
    else excluded.push(row);
  }
  for (const id of queue) excluded.push({ id, reason: 'unchecked' });
  return { ids, excluded, fallback: selected.fallback };
}

export async function selectHealthyFreeRoster(models, options = {}) {
  const collected = await collectAvailableFreeModels(models, options);
  const chairman = chooseFreeChairman(collected.ids, models);
  return {
    councilModels: collected.ids,
    chairmanModel: chairman.chairmanModel,
    chairmanBasis: chairman.basis,
    nSamples: 1,
    fallback: collected.fallback,
    excluded: collected.excluded,
  };
}

export function formatFreeRosterNote(roster) {
  const parts = [];
  if (roster?.fallback === 'size') {
    parts.push('Weekly popularity was unavailable, so this list uses the previous size ranking.');
  }
  if (roster?.chairmanBasis === 'intelligence') {
    parts.push('Chairman is the member with the highest published intelligence score among members that have one.');
  }
  const labels = {
    cooldown: 'Cooling down',
    quarantine: 'Quarantined after repeated upstream limits',
    blocked: 'Blocked',
    'unsuitable-route': 'No suitable free route',
    'unknown-health': 'Endpoint health unknown',
    timeout: 'Endpoint health unknown',
    incomplete: 'Endpoint health unknown',
    unchecked: 'Not checked within the time limit',
    'not-text': 'Not a text chat model',
    'paid-price': 'Not a free route',
    context: 'Context is too small',
    service: 'Safety or guard model',
  };
  const groups = new Map();
  for (const row of roster?.excluded || []) {
    if (!row?.id || !row.reason || row.reason === 'duplicate' || row.reason === 'not-free') continue;
    const label = labels[row.reason];
    if (!label) continue;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row.id);
  }
  for (const [label, ids] of groups) parts.push(`${label}: ${ids.join(', ')}.`);
  return parts.join(' ');
}

export function draftUnchanged(before, after) {
  return sameStringList(before?.councilModels, after?.councilModels)
    && (before?.chairmanModel || '') === (after?.chairmanModel || '');
}

function samePersistedRoster(left, right) {
  return draftUnchanged(
    { councilModels: left?.council_models, chairmanModel: left?.chairman_model },
    { councilModels: right?.council_models, chairmanModel: right?.chairman_model },
  );
}

export async function applyFreeTierDefaultRoster(models, before = null, options = {}) {
  const baseline = before || settings.readPersisted();
  if (baseline.use_free_tier_default !== true) return false;
  const roster = await selectHealthyFreeRoster(models, options);
  if (!roster.councilModels.length || !roster.chairmanModel) return false;
  const latest = settings.readPersisted();
  if (latest.use_free_tier_default !== true) return false;
  if (!samePersistedRoster(latest, baseline)) return false;
  settings.writeFreeTierDefaults(latest, roster);
  notifySettingsChanged();
  return true;
}

function readObstacles() {
  return {
    blocked: readBlockedIds(),
    cooling: readCoolingIds(),
    quarantined: readQuarantinedIds(),
  };
}

function unavailableReason(model, knownIds, obstacles) {
  const cid = catalogueId(model);
  if (!cid) return 'unsuitable-route';
  if (knownIds && !knownIds.has(cid)) return 'delisted';
  if (obstacles.blocked.has(cid)) return 'blocked';
  if (obstacles.cooling.has(cid)) return 'cooldown';
  if (obstacles.quarantined.has(cid)) return 'quarantine';
  return null;
}

/**
 * Fill holes in a preset-managed council. Healthy members and intact roles
 * stay put. Nothing here runs from an error handler.
 */
export async function replaceUnavailableManagedMembers(loadModels, knownIds, options = {}) {
  if (settings.freeRosterManaged !== true) return { changed: false, reason: null };
  const before = settings.readPersisted();
  if (before.free_roster_managed !== true) return { changed: false, reason: null };
  const council = [...(before.council_models || [])];
  const obstacles = readObstacles();
  const reasonFor = (model) => unavailableReason(model, knownIds, obstacles);
  const reasons = council.map(reasonFor);
  const chairmanReason = reasonFor(before.chairman_model);
  const redTeamReason = before.red_team_model ? reasonFor(before.red_team_model) : null;
  if (!reasons.some(Boolean) && !chairmanReason && !redTeamReason) {
    return { changed: false, reason: null };
  }
  const keep = new Set(
    council.filter((model, index) => !reasons[index]).map((model) => catalogueId(model)),
  );
  const needed = reasons.filter(Boolean).length;
  const models = typeof loadModels === 'function' ? loadModels() : loadModels;
  let replacements = [];
  if (needed) {
    const collected = await collectAvailableFreeModels(models, {
      ...options,
      excludeIds: keep,
      limit: needed,
    });
    if (options.signal?.aborted) throw abortError(options.signal);
    replacements = collected.ids;
  }
  let cursor = 0;
  const next = [];
  const missing = [];
  council.forEach((model, index) => {
    if (!reasons[index]) {
      next.push(model);
      return;
    }
    const replacement = replacements[cursor] || null;
    cursor += 1;
    if (replacement) next.push(replacement);
    else missing.push({ id: catalogueId(model), reason: reasons[index] });
  });
  if (!next.length) {
    throw new RosterEmpty(missing.map((row) => row.id));
  }
  let chairmanModel = before.chairman_model;
  if (chairmanReason || !next.some((model) => catalogueId(model) === catalogueId(chairmanModel))) {
    chairmanModel = chooseFreeChairman(next, models).chairmanModel || catalogueId(next[0]);
  }
  let redTeamModel = before.red_team_model;
  if (redTeamReason) redTeamModel = null;
  const latest = settings.readPersisted();
  if (latest.free_roster_managed !== true) return { changed: false, reason: null };
  if (!samePersistedRoster(latest, before)) return { changed: false, reason: null };
  storePrunedRoster({
    councilModels: next,
    chairmanModel,
    redTeamModel,
  });
  const reason = missing.length
    ? `Left ${missing.length} unavailable model${missing.length === 1 ? '' : 's'} out. No further free replacement was available.`
    : null;
  return {
    changed: true,
    reason,
    missing,
    councilModels: next,
    chairmanModel,
    redTeamModel,
  };
}

export function captureRunRoster(source = settings, runId = null) {
  const id = runId || (globalThis.crypto?.randomUUID?.() || `run-${Date.now()}`);
  return {
    runId: id,
    mode: normalizeMode(source.mode),
    councilModels: [...source.councilModels],
    chairmanModel: source.chairmanModel || '',
    redTeamModel: source.redTeamModel || null,
    nSamples: source.nSamples,
    topK: source.topK,
    selfExclusion: source.selfExclusion,
  };
}
