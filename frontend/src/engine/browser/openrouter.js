/**
 * Browser port of backend/openrouter.py.
 * Calls openrouter.ai directly. Retry-After is often hidden from browsers
 * (not a CORS-exposed header), so a missing header falls back to exponential
 * backoff clamped at 60s.
 */

import { settings } from './settings.js';

export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';

export const OPENROUTER_MAX_TOKENS = 16000;
export const OPENROUTER_MAX_TOKENS_HIGH = 32000;
export const MAX_RETRY_AFTER_SECONDS = 60;

const CACHE_TTL_SECONDS = 300;
const APP_TITLE = 'consensus.ai';

let modelsCache = null;
let modelsCacheTime = 0;

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

export function parseRetryAfter(raw, fallback) {
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
  return Math.max(0, Math.min(Number(wait), MAX_RETRY_AFTER_SECONDS));
}

export function catalogueModelId(model) {
  return String(model).replace(/-reasoning(?:-high)?$/, '');
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

function failResult(message, status = null, detail = '') {
  return {
    ok: false,
    error: { status, message, detail },
  };
}

export async function parseHttpError(response) {
  const status = response.status;
  let detail = '';
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    const err = data?.error;
    if (err && typeof err === 'object') {
      detail = String(err.message || JSON.stringify(err));
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

export async function queryModelResult(model, messages, options = {}) {
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
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: combinedSignal(timeout, signal),
      });

      if (response.status === 429 && attempt < maxRetries - 1) {
        const wait = parseRetryAfter(
          response.headers.get('Retry-After'),
          2 ** attempt,
        );
        console.error(`Rate limited for ${model}, retrying in ${wait}s...`);
        await delay(wait, signal);
        continue;
      }

      if (!response.ok) {
        const error = await parseHttpError(response);
        if (response.status === 402) {
          console.error(`Payment required for ${model} (402): ${error.detail || error.message}`);
        } else if (response.status === 404) {
          console.error(`Model ${model} not found (404)`);
        } else {
          console.error(`Error querying model ${model}: HTTP ${response.status}`);
        }
        return { ok: false, error };
      }

      const data = await response.json();
      const message = data.choices?.[0]?.message;
      if (!message) return failResult('Empty model response');
      const usage = data.usage || {};
      const content = message?.content;
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
  return failResult('HTTP 429: Rate limit exceeded', 429);
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
