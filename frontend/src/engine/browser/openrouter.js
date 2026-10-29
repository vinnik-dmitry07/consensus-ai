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
  isUpstreamLimited,
  UPSTREAM_LIMIT,
  MODEL_COOLDOWN_MAX_MS,
  MODEL_COOLDOWN_MS,
  modelUnavailable,
  readBlockedIds,
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
export const STREAM_TOTAL_SECONDS = 600;
export const HEADER_WAIT_SECONDS = 120;
export const IDLE_WAIT_SECONDS = 120;
export const CATALOGUE_FAILURE_COOLDOWN_MS = 30000;

const CACHE_TTL_SECONDS = 300;
const APP_TITLE = 'consensus.ai';

let modelsCache = null;
let modelsCacheTime = 0;
let modelsInFlight = null;
let modelsGeneration = 0;
let modelsCooldownUntil = 0;
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

async function admitFreePost(extraWaitMs, signal) {
  const backoffUntil = monotonicNow() + Math.max(0, extraWaitMs || 0);
  for (;;) {
    if (signal?.aborted) {
      throw signal.reason || new DOMException('Aborted', 'AbortError');
    }
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
    freeStarts.push(now);
    return;
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

let queryHook = null;

export function setQueryHook(hook) {
  queryHook = typeof hook === 'function' ? hook : null;
}

export function canonicalCompletionRequest(model, messages, options = {}) {
  const baseModel = catalogueModelId(model);
  const isAnthropic = modelFamily(model) === 'anthropic';
  const payload = {
    model: baseModel,
    messages,
    max_tokens: resolveMaxTokens(model, options.maxTokens),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (String(model).endsWith('-reasoning-high')) {
    payload.reasoning = { effort: isAnthropic ? 'xhigh' : 'high' };
  } else if (String(model).endsWith('-reasoning')) {
    payload.reasoning = { effort: 'high' };
  }
  return payload;
}

function invalidateModelsCache() {
  modelsCache = null;
  modelsCacheTime = 0;
  modelsInFlight = null;
  modelsCooldownUntil = 0;
  modelsGeneration += 1;
}

export function clearModelsCache() {
  invalidateModelsCache();
}

export function resolveMaxTokens(model, override = null) {
  if (override != null) return Math.max(1, Math.trunc(Number(override)));
  if (String(model).endsWith('-reasoning-high')) return OPENROUTER_MAX_TOKENS_HIGH;
  return OPENROUTER_MAX_TOKENS;
}

export function parseRetryAfter(raw, fallback, limit = MAX_RETRY_AFTER_SECONDS) {
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
  return Math.max(0, Math.min(Number(wait), limit));
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
    if (String(item.type || '').includes('encrypted')) continue;
    for (const key of ['text', 'summary', 'content']) {
      if (typeof item[key] === 'string' && item[key].trim()) {
        parts.push(item[key].trim());
        break;
      }
    }
  }
  return parts.join('\n\n');
}

function failResult(message, status = null, detail = '', kind = null) {
  const error = { status, message, detail };
  if (kind) error.kind = kind;
  return { ok: false, error };
}

function skipReason(model) {
  if (readBlockedIds().has(catalogueModelId(model))) return 'blocked';
  return 'cooldown';
}

function skipMessage(reason) {
  if (reason === 'blocked') return 'OpenRouter will not serve this model';
  if (reason === 'cooldown') return 'Temporarily unavailable (cooldown)';
  if (reason === 'upstream-429') return 'Temporarily rate-limited upstream';
  if (reason === 'provider-429') return 'Provider returned an error';
  if (reason === 'harness-403') return 'Only available on agentic harnesses';
  return 'Skipped';
}

function limitedSkipReason(detail) {
  const lowered = String(detail || '').toLowerCase();
  if (lowered.includes(UPSTREAM_LIMIT)) return 'upstream-429';
  return 'provider-429';
}

function skippedResult(message = 'Skipped') {
  return {
    ok: false,
    skipped: true,
    error: { status: 403, message, detail: '' },
  };
}

function enqueueFree(task) {
  const run = freeTail.then(() => task());
  freeTail = run.then(() => {}, () => {});
  return run;
}

function httpErrorFromText(status, text) {
  let detail = '';
  try {
    const data = JSON.parse(text);
    const err = data?.error;
    if (err && typeof err === 'object') {
      const message = err.message ? String(err.message) : '';
      let raw = '';
      if (err.metadata && typeof err.metadata === 'object' && err.metadata.raw != null && err.metadata.raw !== '') {
        if (typeof err.metadata.raw === 'string') {
          raw = err.metadata.raw;
        } else {
          try {
            raw = JSON.stringify(err.metadata.raw);
          } catch {
            raw = String(err.metadata.raw);
          }
        }
      }
      const parts = [message, raw].filter(Boolean);
      detail = parts.length ? parts.join(' ') : JSON.stringify(err);
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

export async function parseHttpError(response) {
  const text = await response.text();
  return httpErrorFromText(response.status, text);
}

function catalogueFresh(nowMs) {
  return Boolean(
    modelsCache
    && Object.keys(modelsCache).length
    && (nowMs / 1000 - modelsCacheTime) < CACHE_TTL_SECONDS,
  );
}

export function getModelsPricing(options = {}) {
  if (options.refresh) invalidateModelsCache();
  const now = Date.now();
  if (catalogueFresh(now)) return Promise.resolve(modelsCache);
  if (modelsCooldownUntil > now) return Promise.resolve({});
  if (modelsInFlight) return modelsInFlight;
  const generation = modelsGeneration;
  let flight;
  flight = loadModelsPricing(generation).finally(() => {
    if (modelsInFlight === flight) modelsInFlight = null;
  });
  modelsInFlight = flight;
  return flight;
}

function rememberCatalogueFailure(generation) {
  if (generation !== modelsGeneration) return;
  modelsCooldownUntil = Date.now() + CATALOGUE_FAILURE_COOLDOWN_MS;
}

async function loadModelsPricing(generation) {
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(30000),
    });
    if (generation !== modelsGeneration) return modelsCache || {};
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (generation !== modelsGeneration) return modelsCache || {};
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
    if (!Object.keys(built).length) {
      rememberCatalogueFailure(generation);
      return built;
    }
    modelsCache = built;
    modelsCacheTime = Date.now() / 1000;
    modelsCooldownUntil = 0;
    return modelsCache;
  } catch (exc) {
    console.error('Error fetching models:', exc);
    rememberCatalogueFailure(generation);
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
  if (!apiKey) return null;

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

function timeoutReason() {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

function attemptLimits(timeoutSeconds) {
  const timeout = Number(timeoutSeconds);
  const attempt = timeout === HEADER_WAIT_SECONDS ? STREAM_TOTAL_SECONDS : timeout;
  return {
    attempt,
    header: Math.min(HEADER_WAIT_SECONDS, attempt),
    idle: Math.min(IDLE_WAIT_SECONDS, attempt),
  };
}

function openAttempt(attemptSeconds, headerSeconds, idleSeconds, parent) {
  const controller = new AbortController();
  const started = Date.now();
  let timer = null;
  let kind = null;
  let stopped = false;

  const abortWith = (nextKind) => {
    if (controller.signal.aborted) return;
    kind = nextKind;
    const reason = nextKind === 'aborted'
      ? (parent?.reason || new DOMException('Aborted', 'AbortError'))
      : timeoutReason();
    controller.abort(reason);
  };

  const clearPhaseTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const arm = (seconds, nextKind) => {
    clearPhaseTimer();
    const remaining = attemptSeconds * 1000 - (Date.now() - started);
    if (remaining <= 0) {
      abortWith('total');
      return;
    }
    const wait = Math.min(seconds * 1000, remaining);
    const fired = wait < seconds * 1000 ? 'total' : nextKind;
    timer = setTimeout(() => abortWith(fired), wait);
  };

  arm(headerSeconds, 'first-response');

  const onParent = () => abortWith('aborted');
  if (parent) {
    if (parent.aborted) onParent();
    else parent.addEventListener('abort', onParent, { once: true });
  }

  return {
    signal: controller.signal,
    kind: () => kind,
    headersArrived() {
      if (controller.signal.aborted) return;
      arm(idleSeconds, 'idle');
    },
    noteBytes() {
      if (controller.signal.aborted) return;
      arm(idleSeconds, 'idle');
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearPhaseTimer();
      if (parent) parent.removeEventListener('abort', onParent);
    },
  };
}

function usageCounts(usage) {
  const source = usage || {};
  return {
    prompt_tokens: source.prompt_tokens || 0,
    completion_tokens: source.completion_tokens || 0,
    total_tokens: source.total_tokens || 0,
  };
}

function isEventStream(response) {
  const type = response.headers.get('content-type') || '';
  return type.includes('text/event-stream');
}

function emptyTarget() {
  return {
    content: '',
    reasoning: '',
    reasoningContent: '',
    details: new Map(),
    detailSeq: 0,
  };
}

function detailKey(item) {
  const type = item.type ?? '';
  const index = item.index ?? '';
  const id = item.id ?? '';
  if (type === '' && index === '' && id === '') return null;
  return `${type}\0${index}\0${id}`;
}

function mergeDetail(target, item) {
  if (!item || typeof item !== 'object') return;
  const key = detailKey(item) ?? `anon\0${target.detailSeq}`;
  target.detailSeq += 1;
  const prev = target.details.get(key);
  if (!prev) {
    target.details.set(key, { ...item });
    return;
  }
  const next = { ...prev };
  for (const [field, value] of Object.entries(item)) {
    if (
      (field === 'text' || field === 'summary' || field === 'content')
      && typeof prev[field] === 'string'
      && typeof value === 'string'
    ) {
      next[field] = value.startsWith(prev[field]) ? value : prev[field] + value;
    } else if (value != null) {
      next[field] = value;
    }
  }
  target.details.set(key, next);
}

function applyDelta(target, delta) {
  if (typeof delta.content === 'string') target.content += delta.content;
  if (typeof delta.reasoning === 'string') target.reasoning += delta.reasoning;
  if (typeof delta.reasoning_content === 'string') target.reasoningContent += delta.reasoning_content;
  if (Array.isArray(delta.reasoning_details)) {
    for (const item of delta.reasoning_details) mergeDetail(target, item);
  }
}

function applySnapshot(target, message) {
  target.content = typeof message.content === 'string' ? message.content : '';
  target.reasoning = typeof message.reasoning === 'string' ? message.reasoning : '';
  target.reasoningContent = typeof message.reasoning_content === 'string'
    ? message.reasoning_content
    : '';
  target.details = new Map();
  target.detailSeq = 0;
  if (Array.isArray(message.reasoning_details)) {
    for (const item of message.reasoning_details) mergeDetail(target, item);
  }
}

function visibleStreamText(target) {
  if (hasVisibleContent(target.content)) return target.content;
  if (hasVisibleContent(target.reasoning)) return target.reasoning;
  if (hasVisibleContent(target.reasoningContent)) return target.reasoningContent;
  return visibleReasoningText({ reasoning_details: [...target.details.values()] });
}

function successFromTarget(target, content, usage) {
  const details = [...target.details.values()];
  return {
    ok: true,
    content,
    reasoning_details: details.length ? details : undefined,
    usage: usageCounts(usage),
  };
}

function providerFailure(err) {
  const detail = typeof err === 'string' ? err : String(err?.message || 'Stream error');
  const status = err && typeof err === 'object' && err.code != null ? err.code : null;
  return failResult(detail, status, detail, 'provider');
}

function protocolFailure(detail) {
  return failResult('protocol', null, detail, 'protocol');
}

function toolCallFailure() {
  return protocolFailure('Tool calls are not a council answer');
}

function providerFinish(reason) {
  if (reason === 'content_filter') return providerFailure('content_filter');
  if (reason === 'error') return providerFailure('finish_reason error');
  return null;
}

function createStreamParser() {
  let carry = '';
  let dataLines = [];
  let eventName = '';
  let sawDelta = false;
  const target = emptyTarget();
  let usage = null;

  const consumeParsed = (parsed) => {
    if (parsed?.error) return providerFailure(parsed.error);
    if (parsed?.usage && typeof parsed.usage === 'object') usage = parsed.usage;
    const choice = parsed?.choices?.[0];
    if (!choice || typeof choice !== 'object') return null;
    if (choice.error) return providerFailure(choice.error);
    const finished = providerFinish(choice.finish_reason);
    if (finished) return finished;
    if (choice.delta && typeof choice.delta === 'object') {
      sawDelta = true;
      if (choice.delta.tool_calls) return toolCallFailure();
      applyDelta(target, choice.delta);
      return null;
    }
    if (choice.message && typeof choice.message === 'object' && !sawDelta) {
      if (choice.message.tool_calls) return toolCallFailure();
      applySnapshot(target, choice.message);
    }
    return null;
  };

  const dispatch = () => {
    const data = dataLines.join('\n');
    const name = eventName;
    dataLines = [];
    eventName = '';
    if (!data) return null;
    if (name === 'error') {
      try {
        const parsed = JSON.parse(data);
        if (parsed?.error) return providerFailure(parsed.error);
        if (parsed?.message) return providerFailure(parsed.message);
      } catch {
        // The event body is the provider text.
      }
      return providerFailure(data);
    }
    if (data.trim() === '[DONE]') {
      const content = visibleStreamText(target);
      if (!hasVisibleContent(content)) return failResult('Empty model response');
      return successFromTarget(target, content, usage);
    }
    try {
      return consumeParsed(JSON.parse(data));
    } catch {
      return protocolFailure('Invalid stream data');
    }
  };

  const consumeLine = (line) => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
    return null;
  };

  return {
    push(chunk) {
      carry += chunk;
      const lines = carry.split(/\r\n|\n|\r/);
      carry = lines.pop() ?? '';
      for (const line of lines) {
        const result = consumeLine(line);
        if (result) return result;
      }
      return null;
    },
    finish() {
      return protocolFailure('Stream ended before [DONE]');
    },
  };
}

function readChunk(reader, signal) {
  if (signal.aborted) {
    return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then((part) => {
      signal.removeEventListener('abort', onAbort);
      resolve(part);
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

async function readHttpBody(response, lifetime) {
  const streamed = response.ok && isEventStream(response);
  if (!response.body) {
    return streamed
      ? { stream: protocolFailure('Stream ended before [DONE]') }
      : { text: '' };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = streamed ? createStreamParser() : null;
  let text = '';
  let terminal = null;
  try {
    while (true) {
      const part = await readChunk(reader, lifetime.signal);
      if (part.done) break;
      if (!part.value || part.value.byteLength === 0) continue;
      lifetime.noteBytes();
      const chunk = decoder.decode(part.value, { stream: true });
      if (!streamed) {
        text += chunk;
        continue;
      }
      terminal = parser.push(chunk);
      if (terminal) break;
    }
    if (streamed && !terminal) {
      const flushed = parser.push(decoder.decode());
      terminal = flushed || parser.finish();
    }
    if (!streamed) text += decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Cleanup must not replace the result.
    }
    try {
      reader.releaseLock();
    } catch {
      // The reader was already released.
    }
  }
  if (streamed) return { stream: terminal };
  return { text };
}

function jsonCompletion(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return protocolFailure('Invalid JSON response');
  }
  if (data?.error) return providerFailure(data.error);
  const choice = data.choices?.[0];
  if (!choice || typeof choice !== 'object') return failResult('Empty model response');
  if (choice.error) return providerFailure(choice.error);
  const finished = providerFinish(choice.finish_reason);
  if (finished) return finished;
  const message = choice.message;
  if (!message || typeof message !== 'object') return failResult('Empty model response');
  if (message.tool_calls) return toolCallFailure();
  let content = message.content;
  if (!hasVisibleContent(content)) content = visibleReasoningText(message);
  if (!hasVisibleContent(content)) return failResult('Empty model response');
  return {
    ok: true,
    content,
    reasoning_details: message.reasoning_details,
    usage: usageCounts(data.usage),
  };
}

async function queryModelAttempts(model, messages, options) {
  const timeout = options.timeout ?? 120;
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

  const payload = canonicalCompletionRequest(model, messages, options);
  const requestedRetries = Number(options.maxRetries);
  const maxRetries = Number.isInteger(requestedRetries) && requestedRetries > 0
    ? requestedRetries
    : 5;
  const free = isFreeModel(model);
  let extraWaitMs = 0;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const outcome = await runModelAttempt({
      model,
      payload,
      headers,
      timeout,
      signal,
      free,
      extraWaitMs,
      attempt,
      maxRetries,
    });
    if (outcome.retry) {
      extraWaitMs = outcome.extraWaitMs;
      continue;
    }
    return outcome;
  }
}

async function runModelAttempt({
  model,
  payload,
  headers,
  timeout,
  signal,
  free,
  extraWaitMs,
  attempt,
  maxRetries,
}) {
  let lifetime = null;
  try {
    if (modelUnavailable(model)) {
      return skippedResult(skipMessage(skipReason(model)));
    }
    if (signal?.aborted) return failResult('aborted', null, '', 'aborted');
    if (free) await admitFreePost(extraWaitMs, signal);
    const limits = attemptLimits(timeout);
    lifetime = openAttempt(limits.attempt, limits.header, limits.idle, signal);
    if (lifetime.signal.aborted) {
      const abortKind = lifetime.kind();
      return failResult(abortKind, null, '', abortKind);
    }
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: lifetime.signal,
    });
    lifetime.headersArrived();
    const loaded = await readHttpBody(response, lifetime);
    if (loaded.stream) return loaded.stream;

    if (response.status === 429) {
      const error = httpErrorFromText(response.status, loaded.text);
      const detail = `${error.message || ''} ${error.detail || ''}`;
      const freeLimited = detail.includes('free-models-per-min');
      const header = response.headers.get('Retry-After');
      let wait;
      if (freeLimited) {
        wait = parseRetryAfter(header, FREE_MINUTE_MS / 1000);
        extendFreeCooldown(wait);
      } else if (isUpstreamLimited(detail)) {
        wait = parseRetryAfter(
          header,
          MODEL_COOLDOWN_MS / 1000,
          MODEL_COOLDOWN_MAX_MS / 1000,
        );
        rememberModelCooldown(model, wait);
        return skippedResult(skipMessage(limitedSkipReason(detail)));
      } else {
        wait = parseRetryAfter(header, 2 ** attempt);
      }
      if (attempt < maxRetries - 1) {
        console.error(`Rate limited for ${model}, retrying in ${wait}s...`);
        lifetime.stop();
        if (free && !freeLimited) return { retry: true, extraWaitMs: wait * 1000 };
        if (!free) await delay(wait, signal);
        return { retry: true, extraWaitMs: 0 };
      }
      return { ok: false, error };
    }

    if (!response.ok) {
      const error = httpErrorFromText(response.status, loaded.text);
      if (response.status === 402) {
        console.error(`Payment required for ${model} (402): ${error.detail || error.message}`);
      } else if (response.status === 404) {
        console.error(`Model ${model} not found (404)`);
      } else if (
        response.status === 403
        && isHarnessOnlyMessage(`${error.message || ''} ${error.detail || ''}`)
      ) {
        dropBlockedModel(model);
        console.error(`Error querying model ${model}: HTTP 403`);
        return skippedResult(skipMessage('harness-403'));
      } else {
        console.error(`Error querying model ${model}: HTTP ${response.status}`);
      }
      return { ok: false, error };
    }

    return jsonCompletion(loaded.text);
  } catch (exc) {
    const kind = lifetime?.kind();
    if (kind === 'first-response' || kind === 'idle' || kind === 'total' || kind === 'aborted') {
      return failResult(kind, null, '', kind);
    }
    if (signal?.aborted) return failResult('aborted', null, '', 'aborted');
    const message = exc instanceof Error ? exc.message : String(exc);
    console.error(`Error querying model ${model}: ${message}`);
    return failResult(message);
  } finally {
    lifetime?.stop();
  }
}

async function queryModelResultLive(model, messages, options = {}) {
  if (modelUnavailable(model)) {
    return skippedResult(skipMessage(skipReason(model)));
  }
  const run = () => queryModelAttempts(model, messages, options);
  if (isFreeModel(model)) return enqueueFree(run);
  return run();
}

export async function queryModelResult(model, messages, options = {}) {
  if (queryHook) {
    return queryHook({
      model,
      messages,
      options,
      execute: (overrides) => queryModelResultLive(
        model,
        messages,
        { ...options, ...overrides },
      ),
    });
  }
  return queryModelResultLive(model, messages, options);
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
