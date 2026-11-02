/**
 * Drop council models OpenRouter will not serve: absent from the live
 * catalogue, or previously refused with a harness-only 403.
 * catalogueId lives here so this module does not import openrouter.js.
 */

import { notifySettingsChanged, settings } from './settings.js';

const BLOCKED_KEY = 'llm-council-blocked-models';
const COOLDOWN_KEY = 'llm-council-model-cooldowns';
const HARNESS_ONLY = 'only available on agentic harnesses';
export const UPSTREAM_LIMIT = 'temporarily rate-limited upstream';
const PROVIDER_RETURNED = 'provider returned error';
export const MODEL_COOLDOWN_MS = 10 * 60 * 1000;
export const MODEL_COOLDOWN_MAX_MS = 60 * 60 * 1000;

export function catalogueId(model) {
  return String(model || '').replace(/-reasoning(?:-high)?$/, '');
}

export function isFreeModel(model) {
  return catalogueId(model).endsWith(':free');
}

export function isAllFreeCouncil(councilModels) {
  const models = councilModels || [];
  if (!models.length) return false;
  return models.every((model) => isFreeModel(model));
}

export function stage1SampleLimit(councilModels, requested) {
  if (isAllFreeCouncil(councilModels)) return 1;
  return requested;
}

export function runAllowedBySettings(data) {
  return data?.has_api_key === true;
}

const SPECIALIZED_FREE = /code|coder|codestral|devstral|starcoder|safety|guard|omni|-fin(?=:|$)|-sante(?=:|$)/i;
const SERVICE_FREE = /(?:^|[/_:.-])(?:safety|guard)(?:$|[/_:.-])/i;
const PRICE_FIELDS = ['prompt', 'completion', 'request', 'image', 'internal_reasoning', 'web_search'];

export const COUNCIL_MIN_CONTEXT = 8000;
export const CHAIRMAN_MIN_CONTEXT = 32000;
export const MIN_COMPLETION_TOKENS = 1024;
export const UPSTREAM_STRIKE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const UPSTREAM_STRIKE_LIMIT = 3;
export const UPSTREAM_QUARANTINE_MS = 60 * 60 * 1000;

const INCIDENT_KEY = 'llm-council-upstream-incidents';

export function isSpecializedFreeId(model) {
  return SPECIALIZED_FREE.test(String(model || ''));
}

export function isServiceFreeId(model) {
  return SERVICE_FREE.test(String(model || ''));
}

export function priceIsZero(value) {
  if (typeof value === 'number') return value === 0;
  if (typeof value !== 'string' || value.trim() === '') return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === 0;
}

export function priceVerdict(pricing) {
  if (!pricing || typeof pricing !== 'object') return 'unknown';
  for (const field of PRICE_FIELDS) {
    const value = pricing[field];
    if (value == null || value === '') continue;
    if (!priceIsZero(value)) return 'paid';
  }
  if (priceIsZero(pricing.prompt) && priceIsZero(pricing.completion)) return 'free';
  return 'unknown';
}

export function knownPricesAreFree(pricing) {
  return priceVerdict(pricing) === 'free';
}

export function supportsTextChat(model) {
  const arch = model?.architecture;
  if (!arch || typeof arch !== 'object') return true;
  const input = arch.input_modalities;
  const output = arch.output_modalities;
  if (Array.isArray(input) && !input.includes('text')) return false;
  if (Array.isArray(output) && !output.includes('text')) return false;
  if (!Array.isArray(input) && !Array.isArray(output) && typeof arch.modality === 'string' && arch.modality.includes('->')) {
    const [left, right] = arch.modality.split('->');
    if (left && right) return left.includes('text') && right.includes('text');
  }
  return true;
}

function numericOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function contextFitsRole(model, role) {
  const minContext = role === 'chairman' ? CHAIRMAN_MIN_CONTEXT : COUNCIL_MIN_CONTEXT;
  const context = numericOrNull(model?.context_length);
  if (context != null && context < minContext) return false;
  const cap = numericOrNull(model?.max_completion_tokens);
  if (cap != null && cap < MIN_COMPLETION_TOKENS) return false;
  return true;
}

export function supportsReasoningHigh(model) {
  if (!model || !Object.prototype.hasOwnProperty.call(model, 'reasoning')) return false;
  const reasoning = model.reasoning;
  if (!reasoning || typeof reasoning !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(reasoning, 'supported_efforts')) return false;
  return Array.isArray(reasoning.supported_efforts) && reasoning.supported_efforts.includes('high');
}

export function intelligenceScore(model) {
  return numericOrNull(model?.benchmarks?.artificial_analysis?.intelligence);
}

export function weeklyOrderAvailable(models) {
  return (Array.isArray(models) ? models : []).some(
    (model) => Number.isInteger(model?.weeklyRank) && model.weeklyRank > 0,
  );
}

function idSet(value) {
  return value instanceof Set ? value : new Set(value || []);
}

function obstacleReason(cid, options) {
  if (idSet(options.blockedIds).has(cid)) return 'blocked';
  if (idSet(options.coolingIds).has(cid)) return 'cooldown';
  if (idSet(options.quarantinedIds).has(cid)) return 'quarantine';
  return null;
}

export function freeEligibilityReason(model) {
  const id = model?.id;
  if (!id || !String(id).endsWith(':free')) return 'not-free';
  if (isServiceFreeId(id)) return 'service';
  if (!knownPricesAreFree(model.pricing)) return 'paid-price';
  if (!supportsTextChat(model)) return 'not-text';
  if (!contextFitsRole(model, 'council')) return 'context';
  return null;
}

function compareWeekly(left, right) {
  if (left.weeklyRank !== right.weeklyRank) return left.weeklyRank - right.weeklyRank;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/**
 * Eligible free ids ordered by weekly popularity, then id.
 * Without a weekly order, falls back to the size ranking and says so.
 * Known blocks, cooldowns, and quarantines are left out either way.
 */
export function selectFreeCandidateIds(models, options = {}) {
  const list = Array.isArray(models) ? models : [];
  const excluded = [];
  const excludeIds = idSet(options.excludeIds);
  if (!weeklyOrderAvailable(list)) {
    const byId = new Map();
    for (const model of list) {
      if (model?.id && !byId.has(model.id)) byId.set(model.id, model);
    }
    const ranked = rankTopFreeModels(list, options.blockedIds, options.poolLimit ?? 50);
    const ids = [];
    const seen = new Set();
    for (const id of ranked) {
      const cid = catalogueId(id);
      if (!cid || seen.has(cid) || excludeIds.has(cid)) continue;
      const model = byId.get(id) || byId.get(cid);
      const why = model ? freeEligibilityReason(model) : 'not-free';
      if (why) {
        if (why !== 'not-free') excluded.push({ id, reason: why });
        continue;
      }
      const reason = obstacleReason(cid, options);
      if (reason) {
        excluded.push({ id, reason });
        continue;
      }
      seen.add(cid);
      ids.push(id);
    }
    return { ids, excluded, fallback: 'size' };
  }

  const eligible = [];
  const seen = new Set();
  for (const model of list) {
    const id = model?.id;
    if (!id) continue;
    const cid = catalogueId(id);
    if (!cid || seen.has(cid) || excludeIds.has(cid)) {
      if (cid && seen.has(cid)) excluded.push({ id, reason: 'duplicate' });
      continue;
    }
    const why = freeEligibilityReason(model);
    if (why) {
      if (why !== 'not-free') excluded.push({ id, reason: why });
      continue;
    }
    const block = obstacleReason(cid, options);
    if (block) {
      excluded.push({ id, reason: block });
      continue;
    }
    seen.add(cid);
    eligible.push(model);
  }
  eligible.sort(compareWeekly);
  return {
    ids: eligible.map((model) => model.id),
    excluded,
    fallback: null,
  };
}

export function chooseFreeChairman(memberIds, models) {
  const byId = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    if (model?.id && !byId.has(model.id)) byId.set(model.id, model);
  }
  const capable = [];
  const relaxed = [];
  for (const id of memberIds || []) {
    const model = byId.get(catalogueId(id)) || byId.get(id);
    if (!model) continue;
    relaxed.push(model);
    if (contextFitsRole(model, 'chairman')) capable.push(model);
  }
  const pool = capable.length ? capable : relaxed;
  if (!pool.length) {
    return { chairmanModel: '', basis: 'none' };
  }
  const scored = pool.filter((model) => intelligenceScore(model) != null);
  let chosen;
  let basis;
  if (scored.length) {
    scored.sort((left, right) => {
      const diff = intelligenceScore(right) - intelligenceScore(left);
      if (diff !== 0) return diff;
      return compareWeekly(left, right);
    });
    chosen = scored[0];
    basis = 'intelligence';
  } else {
    chosen = pool[0];
    basis = 'order';
  }
  const base = catalogueId(chosen.id);
  return {
    chairmanModel: supportsReasoningHigh(chosen) ? `${base}-reasoning-high` : base,
    basis,
  };
}

function parseSizeFromText(text) {
  let max = 0;
  for (const match of String(text).matchAll(/(\d+(?:\.\d+)?)\s*([bt])\b/gi)) {
    const value = parseFloat(match[1]);
    const size = match[2].toLowerCase() === 't' ? value * 1000 : value;
    if (size > max) max = size;
  }
  return max;
}

export function publishedModelSize(model) {
  for (const source of [model?.id, model?.name, model?.description]) {
    const size = parseSizeFromText(source);
    if (size > 0) return size;
  }
  return 0;
}

function freeSlugFamily(id) {
  const slug = String(id || '').replace(/:free$/i, '').split('/').pop().toLowerCase();
  const match = slug.match(/^[a-z]+/);
  return match ? match[0] : slug;
}

/**
 * Up to `limit` free catalogue ids. One model per slug family first, then
 * the next largest ids if that is short. A size tie inside a family keeps
 * the greater display name; published order uses the lesser name.
 */
export function rankTopFreeModels(models, blockedIds, limit = 10) {
  const cap = Math.trunc(Number(limit));
  if (!Number.isFinite(cap) || cap <= 0) return [];
  const blocked = idSet(blockedIds);
  const eligible = [];
  const seen = new Set();
  for (const model of Array.isArray(models) ? models : []) {
    const id = model?.id;
    if (!id || !isFreeModel(id)) continue;
    const cid = catalogueId(id);
    if (blocked.has(cid) || seen.has(cid)) continue;
    if (isSpecializedFreeId(id)) continue;
    seen.add(cid);
    eligible.push({
      id,
      size: publishedModelSize(model),
      name: model.name || id,
      index: eligible.length,
    });
  }

  const familyBest = new Map();
  for (const model of eligible) {
    const family = freeSlugFamily(model.id);
    const current = familyBest.get(family);
    if (!current) {
      familyBest.set(family, { ...model, familyIndex: familyBest.size });
      continue;
    }
    const largerName = model.name.localeCompare(current.name) > 0;
    if (model.size > current.size || (model.size === current.size && largerName)) {
      familyBest.set(family, { ...model, familyIndex: current.familyIndex });
    }
  }

  const representatives = [...familyBest.values()].sort((a, b) => (
    b.size - a.size
    || a.name.localeCompare(b.name)
    || a.familyIndex - b.familyIndex
  ));
  const picked = representatives.slice(0, cap);
  if (picked.length >= cap) return picked.map((model) => model.id);

  const pickedIds = new Set(picked.map((model) => model.id));
  const rest = eligible
    .filter((model) => !pickedIds.has(model.id))
    .sort((a, b) => (
      b.size - a.size
      || a.name.localeCompare(b.name)
      || a.index - b.index
    ));
  picked.push(...rest.slice(0, cap - picked.length));
  return picked.map((model) => model.id);
}

export function freeTierDefaultRoster(models, blockedIds) {
  const councilModels = rankTopFreeModels(models, blockedIds);
  return {
    councilModels,
    chairmanModel: withVariant(councilModels[0], 'reasoning-high'),
    nSamples: 1,
  };
}

export function isHarnessOnlyMessage(text) {
  return String(text || '').toLowerCase().includes(HARNESS_ONLY);
}

export function isUpstreamLimited(text) {
  const lowered = String(text || '').toLowerCase();
  if (lowered.includes('free-models-per-min')) return false;
  if (lowered.includes(UPSTREAM_LIMIT)) return true;
  return lowered.includes(PROVIDER_RETURNED);
}

function readCooldownMap() {
  try {
    const raw = localStorage.getItem(COOLDOWN_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function modelIsCooling(model) {
  const cid = catalogueId(model);
  const map = readCooldownMap();
  const until = Number(map[cid]);
  if (!cid || !Number.isFinite(until)) return false;
  if (Date.now() >= until) {
    delete map[cid];
    localStorage.setItem(COOLDOWN_KEY, JSON.stringify(map));
    return false;
  }
  return true;
}

export function rememberModelCooldown(model, seconds) {
  const cid = catalogueId(model);
  if (!cid) return;
  const requested = Math.max(0, Number(seconds) || 0) * 1000;
  const wait = Math.min(Math.max(requested, MODEL_COOLDOWN_MS), MODEL_COOLDOWN_MAX_MS);
  const until = Date.now() + wait;
  const map = readCooldownMap();
  const previous = Number(map[cid]) || 0;
  if (until > previous) map[cid] = until;
  localStorage.setItem(COOLDOWN_KEY, JSON.stringify(map));
}

export function clearModelCooldowns() {
  localStorage.removeItem(COOLDOWN_KEY);
}

function emptyIncidentStore() {
  return { incidents: [], quarantine: {} };
}

function readIncidentStore() {
  try {
    const raw = localStorage.getItem(INCIDENT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyIncidentStore();
    return {
      incidents: Array.isArray(parsed.incidents) ? parsed.incidents : [],
      quarantine: parsed.quarantine && typeof parsed.quarantine === 'object' && !Array.isArray(parsed.quarantine)
        ? parsed.quarantine
        : {},
    };
  } catch {
    return emptyIncidentStore();
  }
}

function writeIncidentStore(store) {
  localStorage.setItem(INCIDENT_KEY, JSON.stringify(store));
}

function expireQuarantine(store, now) {
  for (const [cid, until] of Object.entries(store.quarantine)) {
    if (!(Number(until) > now)) delete store.quarantine[cid];
  }
}

export function clearUpstreamIncidents() {
  localStorage.removeItem(INCIDENT_KEY);
}

export function readQuarantinedIds(now = Date.now()) {
  const store = readIncidentStore();
  const before = Object.keys(store.quarantine).length;
  expireQuarantine(store, now);
  if (Object.keys(store.quarantine).length !== before) writeIncidentStore(store);
  return new Set(Object.keys(store.quarantine));
}

export function modelIsQuarantined(model, now = Date.now()) {
  const cid = catalogueId(model);
  if (!cid) return false;
  return readQuarantinedIds(now).has(cid);
}

export function recordUpstreamIncident(model, runId, now = Date.now()) {
  const cid = catalogueId(model);
  if (!cid || !runId) return { quarantined: false, strikes: 0 };
  const store = readIncidentStore();
  expireQuarantine(store, now);
  if (Number(store.quarantine[cid]) > now) {
    writeIncidentStore(store);
    return { quarantined: true, strikes: 0 };
  }
  const windowStart = now - UPSTREAM_STRIKE_WINDOW_MS;
  store.incidents = store.incidents.filter((row) => (
    row
    && row.cid
    && row.runId
    && Number(row.at) >= windowStart
  ));
  const duplicate = store.incidents.some((row) => row.cid === cid && row.runId === String(runId));
  if (!duplicate) store.incidents.push({ cid, at: now, runId: String(runId) });
  const strikes = store.incidents.filter((row) => row.cid === cid).length;
  let quarantined = false;
  if (strikes >= UPSTREAM_STRIKE_LIMIT) {
    store.quarantine[cid] = now + UPSTREAM_QUARANTINE_MS;
    store.incidents = store.incidents.filter((row) => row.cid !== cid);
    quarantined = true;
  }
  writeIncidentStore(store);
  return { quarantined, strikes: quarantined ? UPSTREAM_STRIKE_LIMIT : strikes };
}

export function confirmedUpstreamLimit(text, metadata = null) {
  const source = String(metadata?.limit_source || '').toLowerCase();
  if (source.includes('upstream')) return true;
  return String(text || '').toLowerCase().includes(UPSTREAM_LIMIT);
}

export function accountRateLimitKind(text, metadata = null) {
  const blob = `${text || ''} ${metadata?.limit_source || ''}`.toLowerCase();
  if (blob.includes('free-models-per-min')) return 'minute';
  if (blob.includes('free-models-per-day')) return 'day';
  return null;
}

export function readCoolingIds(now = Date.now()) {
  const map = readCooldownMap();
  const ids = new Set();
  let dirty = false;
  for (const [cid, until] of Object.entries(map)) {
    if (Number(until) > now) ids.add(cid);
    else {
      delete map[cid];
      dirty = true;
    }
  }
  if (dirty) localStorage.setItem(COOLDOWN_KEY, JSON.stringify(map));
  return ids;
}

export function modelUnavailable(model) {
  const cid = catalogueId(model);
  if (!cid) return false;
  return readBlockedIds().has(cid) || modelIsCooling(model) || modelIsQuarantined(model);
}

export function readBlockedIds() {
  try {
    const raw = localStorage.getItem(BLOCKED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((id) => String(id)));
  } catch {
    return new Set();
  }
}

export function rememberBlockedId(model) {
  const cid = catalogueId(model);
  if (!cid) return;
  const ids = readBlockedIds();
  ids.add(cid);
  localStorage.setItem(BLOCKED_KEY, JSON.stringify([...ids]));
}

export function clearBlockedIds() {
  localStorage.removeItem(BLOCKED_KEY);
}

export function removedModelsMessage(ids, empty = false) {
  const listed = ids.join(', ');
  if (empty) {
    return `OpenRouter will not serve ${listed}. Pick the council again.`;
  }
  return `Removed models OpenRouter will not serve: ${listed}.`;
}

export class RosterEmpty extends Error {
  constructor(removed) {
    super(removedModelsMessage(removed, true));
    this.name = 'RosterEmpty';
    this.removed = removed;
  }
}

export function variantOf(model) {
  const text = String(model || '');
  if (text.endsWith('-reasoning-high')) return 'reasoning-high';
  if (text.endsWith('-reasoning')) return 'reasoning';
  return 'base';
}

function withVariant(baseId, variant) {
  if (!baseId) return '';
  if (variant === 'reasoning-high') return `${baseId}-reasoning-high`;
  if (variant === 'reasoning') return `${baseId}-reasoning`;
  return baseId;
}

export function pruneRoster(roster, knownIds, blockedIds = null) {
  const known = idSet(knownIds);
  const blocked = blockedIds instanceof Set
    ? blockedIds
    : new Set(blockedIds || readBlockedIds());
  const removed = [];
  const seen = new Set();

  const unusable = (model) => {
    if (!model || !String(model).trim()) return false;
    const cid = catalogueId(model);
    if (!blocked.has(cid) && known.has(cid)) return false;
    if (!seen.has(cid)) {
      seen.add(cid);
      removed.push(cid);
    }
    return true;
  };

  const councilModels = (roster.councilModels || []).filter((model) => !unusable(model));

  const retarget = (model, empty) => {
    if (!model || !unusable(model)) return model || empty;
    if (!councilModels.length) return empty;
    return withVariant(catalogueId(councilModels[0]), variantOf(model));
  };

  return {
    councilModels,
    chairmanModel: retarget(roster.chairmanModel, ''),
    redTeamModel: retarget(roster.redTeamModel, null),
    removed,
  };
}

export function selectedCatalogueIds() {
  const known = new Set();
  for (const model of settings.councilModels) known.add(catalogueId(model));
  if (settings.chairmanModel) known.add(catalogueId(settings.chairmanModel));
  if (settings.redTeamModel) known.add(catalogueId(settings.redTeamModel));
  return known;
}

export function storePrunedRoster(pruned) {
  settings.writeRoster(pruned);
  notifySettingsChanged();
}

export function dropBlockedModel(model) {
  rememberBlockedId(model);
  const pruned = pruneRoster({
    councilModels: settings.councilModels,
    chairmanModel: settings.chairmanModel,
    redTeamModel: settings.redTeamModel,
  }, selectedCatalogueIds(), readBlockedIds());
  storePrunedRoster(pruned);
  if (!pruned.councilModels.length) return;
  const capped = stage1SampleLimit(pruned.councilModels, settings.nSamples);
  if (capped !== settings.nSamples) settings.nSamples = capped;
}
