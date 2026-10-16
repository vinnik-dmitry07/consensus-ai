/**
 * Browser port of backend/openrouter.py.
 * Calls openrouter.ai directly. Retry-After is often hidden from browsers
 * (not a CORS-exposed header), so a missing header falls back to exponential
 * backoff clamped at 60s.
 */

import {
  catalogueId,
  dropBlockedModel,
  isFreeModel,
  isHarnessOnlyMessage,
  readBlockedIds,
  readBlockedError,
  readModelCooldown,
  rememberModelCooldown,
} from './roster.js';
import { settings } from './settings.js';

export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';

export const OPENROUTER_MAX_TOKENS = 16000;
export const OPENROUTER_MAX_TOKENS_HIGH = 32000;
export const MAX_RETRY_AFTER_SECONDS = 60;
export const FREE_START_GAP_MS = 3000;
export const FREE_MINUTE_MS = 60000;
export const FREE_MAX_STARTS_PER_MINUTE = 16;

const CACHE_TTL_SECONDS = 300;
const APP_TITLE = 'consensus.ai';

let modelsCache = null;
let modelsCacheTime = 0;
let freeTail = Promise.resolve();
let freeStarts = [];
let freeCooldownUntil = 0;

export function resetFreeQueueForTests() {
  freeTail = Promise.resolve();
  freeStarts = [];
  freeCooldownUntil = 0;
}

function monotonicNow() {
  return performance.now();
}

export function extendFreeCooldown(seconds) {
  const until = monotonicNow() + Math.max(0, seconds) * 1000;
  freeCooldownUntil = Math.max(freeCooldownUntil, until);
}

function dropExpiredStarts(now) {
  const cutoff = now - FREE_MINUTE_MS;
  while (freeStarts.length && freeStarts[0] <= cutoff) freeStarts.shift();
}

async function admitFreePost(extraWaitMs, signal, model) {
  const backoffUntil = monotonicNow() + Math.max(0, extraWaitMs || 0);
  for (;;) {
    if (signal?.aborted) {
      throw signal.reason || new DOMException('Aborted', 'AbortError');
    }
    const unavailable = unavailableResult(model);
    if (unavailable) return unavailable;
    const now = monotonicNow();
    dropExpiredStarts(now);
    let earliest = now;
    if (freeStarts.length) {
      earliest = Math.max(earliest, freeStarts[freeStarts.length - 1] + FREE_START_GAP_MS);
    }
    if (freeStarts.length >= FREE_MAX_STARTS_PER_MINUTE) {
      earliest = Math.max(earliest, freeStarts[0] + FREE_MINUTE_MS);
    }
    if (freeCooldownUntil) earliest = Math.max(earliest, freeCooldownUntil);
    earliest = Math.max(earliest, backoffUntil);
    if (earliest > now) {
      await delay((earliest - now) / 1000, signal);
      continue;
    }
    return null;
  }
}

export class CatalogueUnavailable extends Error {
  constructor(message = 'OpenRouter model catalogue unavailable') {
    super(message);
    this.name = 'CatalogueUnavailable';
  }
}

export function getApiKey() {
  return settings.apiKey;
}

export function clearModelsCache() {
  modelsCache = null;
  modelsCacheTime = 0;
}

export function resolveMaxTokens(model, override = null) {
  if (override != null) return Math.max(1, Math.trunc(Number(override)));
  if (String(model).endsWith('-reasoning-high')) return OPENROUTER_MAX_TOKENS_HIGH;
  return OPENROUTER_MAX_TOKENS;
}

export function parseRetryAfter(raw, fallback, maxSeconds = MAX_RETRY_AFTER_SECONDS) {
  let wait = null;
  if (raw != null) {
    const text = String(raw).trim();
    const asNumber = Number(text);
    if (text !== '' && Number.isFinite(asNumber)) {
      wait = asNumber;
    } else {
      const when = Date.parse(text);
      if (!Number.isNaN(when)) wait = (when - Date.now()) / 1000;
    }
  }
  if (wait == null) wait = fallback;
  return Math.max(0, Math.min(Number(wait), maxSeconds));
}

export function catalogueModelId(model) {
  return catalogueId(String(model));
}

export function modelFamily(model) {
  const base = catalogueModelId(String(model || '')).trim().replace(/^~+/, '').toLowerCase();
  const slash = base.indexOf('/');
  if (slash > 0) return base.slice(0, slash);
  return base;
}

export function appReferer() {
  if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') {
    return location.origin;
  }
  return 'http://localhost:5173';
}

export function hasVisibleContent(content) {
  return typeof content === 'string' && Boolean(content.trim());
}

export function visibleReasoningText(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
    return message.reasoning.trim();
  }
  if (!Array.isArray(message.reasoning_details)) return '';
  const parts = [];
  for (const item of message.reasoning_details) {
    if (!item || typeof item !== 'object') continue;
    for (const key of ['text', 'summary', 'content']) {
      if (typeof item[key] === 'string' && item[key].trim()) {
        parts.push(item[key].trim());
        break;
      }
    }
  }
  return parts.join('\n\n');
}

function failResult(message, status = null, detail = '') {
  return {
    ok: false,
    error: { status, message, detail },
  };
}

function skippedResult(error, skipReason, retryAt = null) {
  return {
    ok: false,
    skipped: true,
    skip_reason: skipReason,
    error,
    ...(retryAt == null ? {} : { retry_at: retryAt }),
  };
}

function unavailableResult(model) {
  if (readBlockedIds().has(catalogueModelId(model))) {
    return skippedResult(readBlockedError(model) || {
      status: 403,
      message: 'Skipped: model is only available on agentic harnesses',
      detail: '',
    }, 'harness_only');
  }
  const cooldown = readModelCooldown(model);
  return cooldown
    ? skippedResult(cooldown.error, 'provider_cooldown', cooldown.retry_at)
    : null;
}

function enqueueFree(task) {
  const run = freeTail.then(() => task());
  freeTail = run.then(() => {}, () => {});
  return run;
}

export async function parseHttpError(response) {
  const status = response.status;
  let detail = '';
  let rawDetail = '';
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    const err = data?.error;
    if (err && typeof err === 'object') {
      detail = String(err.message || JSON.stringify(err));
      const raw = err.metadata?.raw;
      if (raw != null) rawDetail = typeof raw === 'string' ? raw : JSON.stringify(raw);
    } else if (err) {
      detail = String(err);
    } else {
      detail = text || '';
    }
  } catch {
    detail = text || '';
  }

  let message;
  if (status === 402) {
    message = '402: cannot afford reserved tokens';
  } else if (status === 404) {
    message = 'Model not found (404)';
  } else {
    message = `HTTP ${status}`;
    if (detail) message = `${message}: ${detail}`;
  }

  if (rawDetail && rawDetail !== detail) detail = `${detail}\n${rawDetail}`.trim();
  return { status, message, detail };
}

export async function getModelsPricing() {
  if (modelsCache && (Date.now() / 1000 - modelsCacheTime) < CACHE_TTL_SECONDS) {
    return modelsCache;
  }

  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const built = {};
    for (const model of data.data || []) {
      const modelId = model?.id;
      if (modelId) {
        built[modelId] = {
          name: model.name,
          pricing: model.pricing || {},
          description: model.description || '',
        };
      }
    }
    modelsCache = built;
    modelsCacheTime = Date.now() / 1000;
    return modelsCache;
  } catch (exc) {
    console.error('Error fetching models:', exc);
    return {};
  }
}

export async function unknownCatalogueIds(models) {
  const pricing = await getModelsPricing();
  if (!pricing || Object.keys(pricing).length === 0) {
    throw new CatalogueUnavailable('OpenRouter model catalogue unavailable');
  }
  const unknown = [];
  const seen = new Set();
  for (const model of models) {
    if (!model || !String(model).trim()) continue;
    const cid = catalogueModelId(String(model).trim());
    if (seen.has(cid)) continue;
    seen.add(cid);
    if (!(cid in pricing)) unknown.push(cid);
  }
  return unknown;
}

async function authGetData(url, label, timeout = 10) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error(`Error fetching ${label}: No API key configured`);
    return null;
  }

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeout * 1000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.data ?? null;
  } catch (exc) {
    console.error(`Error fetching ${label}:`, exc);
    return null;
  }
}

export function getCredits() {
  return authGetData(OPENROUTER_CREDITS_URL, 'credits');
}

export function getKeyInfo() {
  return authGetData(OPENROUTER_KEY_URL, 'key info', 2);
}

function delay(seconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, seconds * 1000);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function combinedSignal(timeoutSeconds, parent) {
  const timeout = AbortSignal.timeout(timeoutSeconds * 1000);
  if (!parent) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, parent]);
  return timeout;
}

async function queryModelAttempts(model, messages, options) {
  const timeout = options.timeout ?? 120;
  const maxTokens = options.maxTokens ?? null;
  const signal = options.signal ?? null;

  const apiKey = getApiKey();
  if (!apiKey) {
    console.error(`Error querying model ${model}: No API key configured`);
    return failResult('No API key configured');
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': appReferer(),
    'X-Title': APP_TITLE,
  };

  const baseModel = catalogueModelId(model);
  const isAnthropic = modelFamily(model) === 'anthropic';
  const payload = {
    model: baseModel,
    messages,
    max_tokens: resolveMaxTokens(model, maxTokens),
  };
  if (String(model).endsWith('-reasoning-high')) {
    payload.reasoning = { effort: isAnthropic ? 'xhigh' : 'high' };
  } else if (String(model).endsWith('-reasoning')) {
    payload.reasoning = { effort: 'high' };
  }

  const maxRetries = 5;
  const free = isFreeModel(model);
  let extraWaitMs = 0;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const unavailable = unavailableResult(model);
      if (unavailable) return unavailable;
      if (free) {
        const skipped = await admitFreePost(extraWaitMs, signal, model);
        if (skipped) return skipped;
        extraWaitMs = 0;
      }
      // Admission awaits a timer: another tab may have refused this model while
      // we waited. Only an actual transport attempt spends a free start.
      const beforeDispatch = unavailableResult(model);
      if (beforeDispatch) return beforeDispatch;
      if (signal?.aborted) return failResult('aborted');
      const requestSignal = combinedSignal(timeout, signal);
      if (free) freeStarts.push(monotonicNow());
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: requestSignal,
      });

      if (response.status === 429) {
        const error = await parseHttpError(response);
        const detail = `${error.message || ''} ${error.detail || ''}`.toLowerCase();
        const freeLimited = detail.includes('free-models-per-min');
        const header = response.headers.get('Retry-After');
        const upstreamLimited = detail.includes('temporarily rate-limited upstream')
          || /provider returned error/i.test(error.message);
        if (free && !freeLimited && upstreamLimited) {
          const wait = Math.max(600, parseRetryAfter(header, 600, 3600));
          const cooldown = rememberModelCooldown(baseModel, wait, error);
          return skippedResult(error, 'provider_cooldown', cooldown.retry_at);
        }
        const wait = freeLimited
          ? parseRetryAfter(header, FREE_MINUTE_MS / 1000)
          : parseRetryAfter(header, 2 ** attempt);
        if (freeLimited) extendFreeCooldown(wait);
        if (attempt < maxRetries - 1) {
          console.error(`Rate limited for ${model}, retrying in ${wait}s...`);
          if (free && !freeLimited) extraWaitMs = wait * 1000;
          else if (!free) await delay(wait, signal);
          continue;
        }
        return { ok: false, error };
      }

      if (!response.ok) {
        const error = await parseHttpError(response);
        if (response.status === 402) {
          console.error(`Payment required for ${model} (402): ${error.detail || error.message}`);
        } else if (response.status === 404) {
          console.error(`Model ${model} not found (404)`);
        } else if (
          response.status === 403
          && isHarnessOnlyMessage(`${error.message || ''} ${error.detail || ''}`)
        ) {
          try {
            dropBlockedModel(model, error);
          } catch (exc) {
            // The refusal is already remembered in memory. A storage failure
            // must not turn this known skip back into a Stage 1 error tab.
            console.error('Could not persist the pruned council:', exc);
          }
          return skippedResult(error, 'harness_only');
        } else {
          console.error(`Error querying model ${model}: HTTP ${response.status}`);
        }
        return { ok: false, error };
      }

      const data = await response.json();
      const message = data.choices?.[0]?.message;
      if (!message) return failResult('Empty model response');
      const usage = data.usage || {};
      let content = message?.content;
      if (!hasVisibleContent(content)) content = visibleReasoningText(message);
      if (!hasVisibleContent(content)) return failResult('Empty model response');

      return {
        ok: true,
        content,
        reasoning_details: message.reasoning_details,
        usage: {
          prompt_tokens: usage.prompt_tokens || 0,
          completion_tokens: usage.completion_tokens || 0,
          total_tokens: usage.total_tokens || 0,
        },
      };
    } catch (exc) {
      if (signal?.aborted) return failResult('aborted');
      console.error(`Error querying model ${model}:`, exc);
      return failResult(exc instanceof Error ? exc.message : String(exc));
    }
  }
}

export async function queryModelResult(model, messages, options = {}) {
  const unavailable = unavailableResult(model);
  if (unavailable) return unavailable;
  const run = () => queryModelAttempts(model, messages, options);
  if (isFreeModel(model)) return enqueueFree(run);
  return run();
}

export async function queryModel(model, messages, options = {}) {
  const result = await queryModelResult(model, messages, options);
  if (!result.ok) return null;
  return {
    content: result.content,
    reasoning_details: result.reasoning_details,
    usage: result.usage || {},
  };
}
