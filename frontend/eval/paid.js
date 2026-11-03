/**
 * A missing capability score stays unknown. Order is the catalogue order.
 */

import { modelFamily } from '../src/engine/browser/openrouter.js';
import {
  isServiceFreeId,
  supportsTextChat,
} from '../src/engine/browser/roster.js';
import {
  COUNCIL_SIZE,
  MIN_COMPLETION,
  MIN_CONTEXT,
  QUALITY_SOURCE,
  RESERVE_LIMIT,
  SHORTLIST_LIMIT,
  TEMPERATURE,
  TOP_P,
} from './a8Profile.js';

const ROUTER_VENDOR = new Set(['openrouter']);

export function priceNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function intelligenceIndex(model) {
  const block = model?.benchmarks?.artificial_analysis;
  if (!block || typeof block !== 'object') return null;
  const value = Object.prototype.hasOwnProperty.call(block, 'intelligence_index')
    ? block.intelligence_index
    : block.intelligence;
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function promptTokenCeiling(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const chars = JSON.stringify(list).length;
  return chars + (16 * Math.max(1, list.length));
}

function optionalRate(raw) {
  if (raw == null || raw === '') return 0;
  return priceNumber(raw);
}

function tierPrice(pricing, promptTokens) {
  const basePrompt = priceNumber(pricing?.prompt);
  const baseCompletion = priceNumber(pricing?.completion);
  if (basePrompt == null || baseCompletion == null) return null;
  let prompt = basePrompt;
  let completion = baseCompletion;
  let cacheWrite = optionalRate(pricing?.input_cache_write);
  const request = optionalRate(pricing?.request);
  const internalReasoning = optionalRate(pricing?.internal_reasoning);
  if (cacheWrite == null || request == null || internalReasoning == null) return null;
  const overrides = Array.isArray(pricing?.overrides) ? pricing.overrides : [];
  for (const tier of overrides) {
    if (!tier || typeof tier !== 'object') return null;
    const min = priceNumber(tier.min_prompt_tokens);
    if (min != null && promptTokens < min) continue;
    const tierPrompt = tier.prompt == null || tier.prompt === '' ? null : priceNumber(tier.prompt);
    const tierCompletion = tier.completion == null || tier.completion === '' ? null : priceNumber(tier.completion);
    const tierCache = tier.input_cache_write == null || tier.input_cache_write === ''
      ? null
      : priceNumber(tier.input_cache_write);
    if ((tier.prompt != null && tier.prompt !== '' && tierPrompt == null)
      || (tier.completion != null && tier.completion !== '' && tierCompletion == null)
      || (tier.input_cache_write != null && tier.input_cache_write !== '' && tierCache == null)) {
      return null;
    }
    if (tierPrompt != null) prompt = Math.max(prompt, tierPrompt);
    if (tierCompletion != null) completion = Math.max(completion, tierCompletion);
    if (tierCache != null) cacheWrite = Math.max(cacheWrite, tierCache);
  }
  return {
    prompt,
    completion,
    cacheWrite,
    request,
    internalReasoning,
  };
}

export function quoteReservation({ pricing, promptTokens, maxTokens }) {
  if (!Number.isFinite(promptTokens) || promptTokens < 0) return null;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return null;
  const tier = tierPrice(pricing, promptTokens);
  if (!tier) return null;
  const inputRate = Math.max(tier.prompt, tier.cacheWrite);
  const usd = (promptTokens * inputRate)
    + (maxTokens * tier.completion)
    + (maxTokens * Math.max(0, tier.internalReasoning))
    + Math.max(0, tier.request);
  if (!Number.isFinite(usd)) return null;
  return {
    usd,
    promptPerToken: tier.prompt,
    completionPerToken: tier.completion,
    promptPerMillion: tier.prompt * 1_000_000,
    completionPerMillion: tier.completion * 1_000_000,
  };
}

export function usageCost(pricing, usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (usage.cost != null && usage.cost !== '' && Number.isFinite(Number(usage.cost))) {
    return Number(usage.cost);
  }
  const promptTokens = Number(usage.prompt_tokens);
  const completionTokens = Number(usage.completion_tokens);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) return null;
  const tier = tierPrice(pricing, promptTokens);
  if (!tier) return null;
  const inputRate = Math.max(tier.prompt, tier.cacheWrite);
  const request = Math.max(0, tier.request);
  return (promptTokens * inputRate)
    + (completionTokens * tier.completion)
    + (completionTokens * Math.max(0, tier.internalReasoning))
    + request;
}

export function paidCatalogueReason(model) {
  const id = model?.id;
  if (!id || typeof id !== 'string') return 'missing-id';
  if (id.endsWith(':free')) return 'free-only';
  if (id.includes(':')) return 'free-or-variant';
  const weights = model?.hugging_face_id;
  if (typeof weights !== 'string' || weights.trim() === '') return 'open-weight-unverified';
  const vendor = modelFamily(id);
  if (!vendor || ROUTER_VENDOR.has(vendor)) return 'router';
  if (isServiceFreeId(id) || isServiceFreeId(model?.name || '')) return 'service';
  if (!supportsTextChat(model)) return 'not-text';
  const prompt = priceNumber(model?.pricing?.prompt);
  const completion = priceNumber(model?.pricing?.completion);
  if (prompt == null || completion == null) return 'unknown-price';
  if (prompt === 0 && completion === 0) return 'zero-price';
  const context = priceNumber(model?.context_length);
  if (context == null || context < MIN_CONTEXT) return 'context';
  const cap = priceNumber(model?.top_provider?.max_completion_tokens);
  if (cap != null && cap < MIN_COMPLETION) return 'completion-cap';
  return null;
}

export function selectPaidShortlist(models, options = {}) {
  const limit = options.limit ?? SHORTLIST_LIMIT;
  const reserves = options.reserveLimit ?? RESERVE_LIMIT;
  const excluded = [];
  const seen = new Set();
  const unique = [];
  for (const model of Array.isArray(models) ? models : []) {
    const reason = paidCatalogueReason(model);
    if (reason) {
      if (model?.id) excluded.push({ id: model.id, reason });
      continue;
    }
    const vendor = modelFamily(model.id);
    if (seen.has(vendor)) continue;
    seen.add(vendor);
    unique.push({
      id: model.id,
      vendor,
      score: intelligenceIndex(model),
      weeklyRank: Number.isInteger(model.weeklyRank) ? model.weeklyRank : null,
      supportedParameters: Array.isArray(model.supported_parameters)
        ? [...model.supported_parameters]
        : [],
    });
  }
  return {
    candidates: unique.slice(0, limit),
    reserves: unique.slice(limit, limit + reserves),
    excluded,
    qualitySource: QUALITY_SOURCE,
  };
}

function endpointTextOk(endpoint) {
  if (!endpoint || typeof endpoint !== 'object') return false;
  const hasModality = endpoint.input_modalities != null
    || endpoint.output_modalities != null
    || endpoint.modality != null
    || endpoint.architecture;
  if (!hasModality) return true;
  return supportsTextChat({
    architecture: endpoint.architecture || {
      input_modalities: endpoint.input_modalities,
      output_modalities: endpoint.output_modalities,
      modality: endpoint.modality,
    },
  });
}

export function qualifyEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'object') return 'incomplete';
  if (!endpoint.tag || typeof endpoint.tag !== 'string') return 'missing-tag';
  if (endpoint.status !== 0) return 'status';
  if (!endpointTextOk(endpoint)) return 'not-text';
  const context = priceNumber(endpoint.context_length);
  if (context == null || context < MIN_CONTEXT) return 'context';
  const cap = priceNumber(endpoint.max_completion_tokens);
  if (cap == null || cap < MIN_COMPLETION) return 'completion-cap';
  const promptLimit = priceNumber(endpoint.max_prompt_tokens);
  if (promptLimit != null && promptLimit < 1) return 'prompt-cap';
  const promptPrice = priceNumber(endpoint.pricing?.prompt);
  const completionPrice = priceNumber(endpoint.pricing?.completion);
  if (promptPrice == null || completionPrice == null) return 'unknown-price';
  if (promptPrice <= 0 || completionPrice <= 0) return 'zero-price';
  const supported = Array.isArray(endpoint.supported_parameters) ? endpoint.supported_parameters : [];
  if (supported.length && !supported.includes('max_tokens') && !supported.includes('max_completion_tokens')) {
    return 'max-tokens';
  }
  return null;
}

export function chooseEndpoint(endpoints) {
  const qualified = [];
  const rejected = [];
  for (const endpoint of Array.isArray(endpoints) ? endpoints : []) {
    const reason = qualifyEndpoint(endpoint);
    if (reason) {
      rejected.push({ tag: endpoint?.tag || null, reason });
      continue;
    }
    qualified.push(endpoint);
  }
  qualified.sort((left, right) => {
    const rank = (endpoint) => {
      const quantization = String(endpoint.quantization || '').toLowerCase();
      const quantized = /(mxfp|int4|int8|fp4|fp8|awq|gptq)/.test(quantization) ? 1 : 0;
      const flex = String(endpoint.tag || '').includes('flex') ? 1 : 0;
      return quantized * 2 + flex;
    };
    const penalty = rank(left) - rank(right);
    if (penalty !== 0) return penalty;
    const cost = (priceNumber(left.pricing?.completion) ?? 0) - (priceNumber(right.pricing?.completion) ?? 0);
    if (cost !== 0) return cost;
    if (left.tag < right.tag) return -1;
    if (left.tag > right.tag) return 1;
    return 0;
  });
  return { endpoint: qualified[0] || null, rejected };
}

export function routePolicy(model, endpoint) {
  const supported = new Set(
    (endpoint?.supported_parameters || model?.supportedParameters || []).map((item) => String(item)),
  );
  const worst = tierPrice(endpoint.pricing, Number.MAX_SAFE_INTEGER);
  if (!worst) return null;
  const provider = {
    order: [endpoint.tag],
    allow_fallbacks: false,
    max_price: {
      prompt: Math.max(worst.prompt, worst.cacheWrite) * 1_000_000,
      completion: (worst.completion + Math.max(0, worst.internalReasoning)) * 1_000_000,
    },
  };
  const supports = {
    temperature: supported.has('temperature'),
    top_p: supported.has('top_p'),
    reasoning: supported.has('reasoning') || supported.has('reasoning_effort'),
    max_tokens: supported.has('max_tokens') || supported.has('max_completion_tokens'),
  };
  return {
    id: model.id,
    vendor: model.vendor || modelFamily(model.id),
    tag: endpoint.tag,
    providerName: endpoint.provider_name || null,
    quantization: endpoint.quantization ?? null,
    context: priceNumber(endpoint.context_length),
    maxCompletion: priceNumber(endpoint.max_completion_tokens),
    maxPrompt: priceNumber(endpoint.max_prompt_tokens),
    pricing: endpoint.pricing,
    score: model.score ?? intelligenceIndex(model),
    weeklyRank: model.weeklyRank ?? null,
    provider,
    temperature: supports.temperature ? TEMPERATURE : null,
    topP: supports.top_p ? TOP_P : null,
    reasoning: null,
    decoding: {
      temperature: supports.temperature ? TEMPERATURE : 'provider default / unknown',
      top_p: supports.top_p ? TOP_P : 'provider default / unknown',
      effort: 'provider default / unknown',
      seed: null,
    },
    supports,
  };
}

export function selectFromDev(rows) {
  const ranked = [...rows].map((row) => {
    const denom = row.expected ?? row.attempts;
    return {
      ...row,
      accuracy: denom ? row.correct / denom : 0,
      completion: denom ? row.successes / denom : 0,
      latency: row.latencyMs == null ? Number.POSITIVE_INFINITY : row.latencyMs,
    };
  }).sort((left, right) => {
    if (right.accuracy !== left.accuracy) return right.accuracy - left.accuracy;
    if (right.completion !== left.completion) return right.completion - left.completion;
    if (left.latency !== right.latency) return left.latency - right.latency;
    const leftId = left.configId || left.id;
    const rightId = right.configId || right.id;
    if (leftId < rightId) return -1;
    if (leftId > rightId) return 1;
    return 0;
  });
  if (ranked.length < COUNCIL_SIZE) return null;
  const council = ranked.slice(0, COUNCIL_SIZE);
  const best = council[0];
  return {
    b: best,
    h: best,
    council,
    ranked,
    basis: 'Best among the checked candidates on this dev set',
  };
}
