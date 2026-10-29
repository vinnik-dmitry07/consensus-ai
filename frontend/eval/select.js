import { modelFamily } from '../src/engine/browser/openrouter.js';
import {
  catalogueId,
  isFreeModel,
  isSpecializedFreeId,
  publishedModelSize,
} from '../src/engine/browser/roster.js';
import { COUNCIL_SIZE, POOL_LIMIT } from './protocol.js';

export function supportsHigh(model) {
  const parameters = model?.supported_parameters || model?.supportedParameters || [];
  return Array.isArray(parameters) && parameters.includes('reasoning');
}

export function selectSearchPool(models, limit = POOL_LIMIT) {
  const best = new Map();
  for (const model of models || []) {
    const id = model?.id;
    if (!id || !isFreeModel(id) || String(id).startsWith('openrouter/')) continue;
    if (isSpecializedFreeId(id)) continue;
    const vendor = modelFamily(id);
    const size = publishedModelSize(model);
    const candidate = { ...model, id: catalogueId(id), vendor, size };
    const current = best.get(vendor);
    if (!current || size > current.size || (size === current.size && candidate.id < current.id)) {
      best.set(vendor, candidate);
    }
  }
  return [...best.values()]
    .sort((left, right) => right.size - left.size || left.vendor.localeCompare(right.vendor))
    .slice(0, limit);
}

export function configsFor(model) {
  const base = catalogueId(model.id);
  const configs = [{
    configId: base,
    model: base,
    baseId: base,
    vendor: model.vendor || modelFamily(base),
    reasoning: 'default',
  }];
  if (supportsHigh(model)) {
    configs.push({
      configId: `${base}#high`,
      model: `${base}-reasoning-high`,
      baseId: base,
      vendor: model.vendor || modelFamily(base),
      reasoning: 'high',
    });
  }
  return configs;
}

export function selectFromDev(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const current = grouped.get(row.configId) || {
      ...row,
      correct: 0,
      attempts: 0,
      successes: 0,
      latencyMs: 0,
      latencyCount: 0,
    };
    current.correct += row.correct ? 1 : 0;
    current.attempts += 1;
    if (row.success) current.successes += 1;
    if (row.latencyMs != null) {
      current.latencyMs += row.latencyMs;
      current.latencyCount += 1;
    }
    grouped.set(row.configId, current);
  }
  const ranked = [...grouped.values()].map((row) => ({
    ...row,
    accuracy: row.attempts ? row.correct / row.attempts : 0,
    completion: row.attempts ? row.successes / row.attempts : 0,
    latency: row.latencyCount ? row.latencyMs / row.latencyCount : Number.POSITIVE_INFINITY,
  })).sort((left, right) => (
    right.accuracy - left.accuracy
    || right.completion - left.completion
    || left.latency - right.latency
    || left.configId.localeCompare(right.configId)
  ));
  if (!ranked.length) throw new Error('Dev selection has no rows');
  const best = ranked[0];
  const chosen = [];
  const seen = new Set();
  for (const row of ranked) {
    if (seen.has(row.vendor)) continue;
    seen.add(row.vendor);
    chosen.push(row);
    if (chosen.length === COUNCIL_SIZE) break;
  }
  if (!chosen.some((row) => row.configId === best.configId)) chosen.unshift(best);
  const high = ranked.find((row) => row.baseId === best.baseId && row.reasoning === 'high');
  const chairman = best.reasoning === 'high' || !high ? best : high;
  return {
    b: best,
    council: chosen.slice(0, COUNCIL_SIZE),
    chairman,
    devSelected: true,
    label: ranked.some((row) => row.reasoning === 'high')
      ? 'dev-selected'
      : 'best among the checked default configurations',
  };
}
