/**
 * Drop council models OpenRouter will not serve: absent from the live
 * catalogue, or previously refused with a harness-only 403.
 * catalogueId lives here so this module does not import openrouter.js.
 */

import { notifySettingsChanged, sameStringList, settings } from './settings.js';

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

export function isSpecializedFreeId(model) {
  return SPECIALIZED_FREE.test(String(model || ''));
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

function blockedIdSet(blockedIds) {
  return blockedIds instanceof Set ? blockedIds : new Set(blockedIds || []);
}

/**
 * Up to `limit` free catalogue ids. One model per slug family first, then
 * the next largest ids if that is short. A size tie inside a family keeps
 * the greater display name; published order uses the lesser name.
 */
export function rankTopFreeModels(models, blockedIds, limit = 10) {
  const cap = Math.trunc(Number(limit));
  if (!Number.isFinite(cap) || cap <= 0) return [];
  const blocked = blockedIdSet(blockedIds);
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

export function applyFreeTierDefaultRoster(models, before = null) {
  const baseline = before || settings.readPersisted();
  if (baseline.use_free_tier_default !== true) return false;
  const roster = freeTierDefaultRoster(models, readBlockedIds());
  if (!roster.councilModels.length) return false;
  const latest = settings.readPersisted();
  if (latest.use_free_tier_default !== true) return false;
  if (!sameStringList(latest.council_models, baseline.council_models)) return false;
  if ((latest.chairman_model || '') !== (baseline.chairman_model || '')) return false;
  settings.writeFreeTierDefaults(latest, roster);
  notifySettingsChanged();
  return true;
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

export function modelUnavailable(model) {
  const cid = catalogueId(model);
  if (!cid) return false;
  return readBlockedIds().has(cid) || modelIsCooling(model);
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

function variantOf(model) {
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
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
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
