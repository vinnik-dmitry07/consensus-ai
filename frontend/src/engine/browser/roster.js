/**
 * Drop council models OpenRouter will not serve: absent from the live
 * catalogue, or previously refused with a harness-only 403.
 * catalogueId lives here so this module does not import openrouter.js.
 */

import { settings } from './settings.js';

const BLOCKED_KEY = 'llm-council-blocked-models';
const COOLDOWN_KEY = 'llm-council-model-cooldowns';
const HARNESS_ONLY = 'only available on agentic harnesses';
const UPSTREAM_LIMIT = 'temporarily rate-limited upstream';
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
  settings.councilModels = pruned.councilModels;
  settings.chairmanModel = pruned.chairmanModel;
  settings.redTeamModel = pruned.redTeamModel;
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
