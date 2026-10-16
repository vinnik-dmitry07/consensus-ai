/**
 * Drop council models OpenRouter will not serve: absent from the live
 * catalogue, or previously refused with a harness-only 403.
 * catalogueId lives here so this module does not import openrouter.js.
 */

import { settings } from './settings.js';

const BLOCKED_KEY = 'llm-council-blocked-models';
const COOLDOWNS_KEY = 'llm-council-model-cooldowns';
const HARNESS_ONLY = 'only available on agentic harnesses';
const blockedMemory = new Set();
const blockedErrors = new Map();
const modelCooldowns = new Map();

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

export function readBlockedIds() {
  try {
    const raw = localStorage.getItem(BLOCKED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const id of parsed) blockedMemory.add(catalogueId(id));
    }
  } catch { /* Keep refusals for this tab when storage is unavailable. */ }
  return new Set(blockedMemory);
}

export function rememberBlockedId(model, error = null) {
  const cid = catalogueId(model);
  if (!cid) return;
  const ids = readBlockedIds();
  ids.add(cid);
  blockedMemory.add(cid);
  if (error) blockedErrors.set(cid, { ...error });
  try {
    localStorage.setItem(BLOCKED_KEY, JSON.stringify([...ids]));
  } catch { /* The in-memory block still prevents another request. */ }
}

export function clearBlockedIds() {
  blockedMemory.clear();
  blockedErrors.clear();
  try {
    localStorage.removeItem(BLOCKED_KEY);
  } catch { /* Storage can be disabled. */ }
}

export function readBlockedError(model) {
  const error = blockedErrors.get(catalogueId(model));
  return error ? { ...error } : null;
}

function refreshModelCooldowns() {
  const now = Date.now() / 1000;
  try {
    const raw = localStorage.getItem(COOLDOWNS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [model, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry !== 'object'
            || !Number.isFinite(entry.retry_at) || entry.retry_at <= now) continue;
        const cid = catalogueId(model);
        if (!cid || !isFreeModel(cid)) continue;
        if ((modelCooldowns.get(cid)?.retry_at || 0) >= entry.retry_at) continue;
        modelCooldowns.set(cid, {
          retry_at: entry.retry_at,
          error: {
            status: 429,
            message: typeof entry.error?.message === 'string'
              ? entry.error.message : 'HTTP 429: Provider returned error',
            detail: typeof entry.error?.detail === 'string' ? entry.error.detail : '',
          },
        });
      }
    }
  } catch { /* Malformed or unavailable storage must not break model calls. */ }
  for (const [cid, entry] of modelCooldowns) {
    if (entry.retry_at <= now) modelCooldowns.delete(cid);
  }
}

export function readModelCooldown(model) {
  refreshModelCooldowns();
  const entry = modelCooldowns.get(catalogueId(model));
  return entry ? { ...entry, error: { ...entry.error } } : null;
}

export function rememberModelCooldown(model, durationSeconds, error = null) {
  const cid = catalogueId(model);
  if (!isFreeModel(cid)) return null;
  refreshModelCooldowns();
  const duration = Number(durationSeconds);
  const seconds = Number.isFinite(duration) ? Math.max(600, Math.min(duration, 3600)) : 600;
  const retryAt = Date.now() / 1000 + seconds;
  if ((modelCooldowns.get(cid)?.retry_at || 0) < retryAt) {
    modelCooldowns.set(cid, {
      retry_at: retryAt,
      error: {
        status: 429,
        message: error?.message || 'HTTP 429: Provider returned error',
        detail: error?.detail || '',
      },
    });
  }
  try {
    localStorage.setItem(COOLDOWNS_KEY, JSON.stringify(Object.fromEntries(modelCooldowns)));
  } catch { /* Keep the cooldown in memory if persistence is not available. */ }
  return readModelCooldown(cid);
}

export function isModelUnavailable(model) {
  return readBlockedIds().has(catalogueId(model)) || readModelCooldown(model) !== null;
}

export function clearModelCooldownsForTests() {
  modelCooldowns.clear();
  try {
    localStorage.removeItem(COOLDOWNS_KEY);
  } catch { /* Storage can be disabled. */ }
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

export function dropBlockedModel(model, error = null) {
  rememberBlockedId(model, error);
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
