import { AsyncLocalStorage } from 'node:async_hooks';

import { parseRetryAfter } from '../src/engine/browser/openrouter.js';
import {
  MODEL_COOLDOWN_MAX_MS,
  MODEL_COOLDOWN_MS,
  isUpstreamLimited,
} from '../src/engine/browser/roster.js';
import { BudgetPaused, classifyCreditResponse, classifyLimitMessage, nextUtcMidnight } from './budget.js';
import { EvalInvariantError } from './invariant.js';
import { promptTokenCeiling } from './paid.js';
import { stableStringify } from './util.js';

export const attemptStore = new AsyncLocalStorage();

const NETWORK_MARKERS = [
  'fetch failed',
  'terminated',
  'econnreset',
  'enotfound',
  'eai_again',
  'etimedout',
  'socket hang up',
  'other side closed',
];

export function isNetworkMessage(message) {
  const lowered = String(message || '').toLowerCase();
  return NETWORK_MARKERS.some((part) => lowered.includes(part));
}

const ALLOWED_GET = new Set([
  '/api/v1/models',
  '/api/v1/key',
  '/api/v1/credits',
  '/api/v1/generation',
]);

// OpenRouter puts the generation id on every SSE chunk and on a JSON body.
// The id lets a later reconcile ask what an aborted attempt really cost.
export function generationIdFrom(text) {
  const match = String(text || '').match(/"id"\s*:\s*"(gen-[^"\s]+)"/);
  return match ? match[1] : null;
}

function headerObject(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== 'function') return out;
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'authorization') return;
    out[key] = value;
  });
  return out;
}

function teeResponse(response, onDone) {
  if (!response.body) {
    onDone({ text: '', incomplete: false });
    return response;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let finished = false;
  const finish = (incomplete, error = null) => {
    if (finished) return;
    finished = true;
    text += decoder.decode();
    onDone({ text, incomplete, error });
  };
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          finish(false);
          controller.close();
          return;
        }
        text += decoder.decode(part.value, { stream: true });
        controller.enqueue(part.value);
      } catch (error) {
        finish(true, error instanceof Error ? error.message : String(error));
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish(true, reason ? String(reason) : null);
      try {
        await reader.cancel(reason);
      } catch {
        // The consumer already stopped.
      }
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function bodyLooksComplete(text, contentType) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  if (String(contentType || '').includes('text/event-stream') || raw.includes('\ndata:') || raw.startsWith('data:')) {
    return raw.includes('[DONE]');
  }
  try {
    const parsed = JSON.parse(raw);
    return Boolean(parsed && (parsed.choices || parsed.error));
  } catch {
    return false;
  }
}

function usageFromText(text, contentType) {
  if (!text) return { usage: null, finishReason: null, known: false };
  if (String(contentType || '').includes('text/event-stream') || text.includes('data:')) {
    let usage = null;
    let finishReason = null;
    const lines = text.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0 && (usage == null || finishReason == null); index -= 1) {
      const line = lines[index];
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (usage == null && parsed?.usage && typeof parsed.usage === 'object') usage = parsed.usage;
        if (finishReason == null) {
          const reason = parsed?.choices?.[0]?.finish_reason;
          if (reason) finishReason = reason;
        }
      } catch {
        // Incomplete SSE lines are recorded, not parsed.
      }
    }
    return { usage, finishReason, known: usage != null };
  }
  try {
    const parsed = JSON.parse(text);
    const usage = parsed?.usage && typeof parsed.usage === 'object' ? parsed.usage : null;
    const finishReason = parsed?.choices?.[0]?.finish_reason || null;
    return { usage, finishReason, known: usage != null };
  } catch {
    return { usage: null, finishReason: null, known: false };
  }
}

export function installTransport({
  nativeFetch,
  allowModels,
  allowPaid = false,
  rejectFree = false,
  budget,
  onHttp,
  onCooldown,
  maxCooldownMs = null,
}) {
  const native = nativeFetch || globalThis.fetch;
  const wrapped = async (url, init = {}) => {
    const target = new URL(String(url));
    if (target.origin !== 'https://openrouter.ai') {
      throw new Error(`Blocked URL ${target.origin}`);
    }
    const method = String(init.method || 'GET').toUpperCase();
    if (method === 'GET' && ALLOWED_GET.has(target.pathname)) {
      return native(url, init);
    }
    if (method !== 'POST' || target.pathname !== '/api/v1/chat/completions') {
      throw new Error(`Blocked request ${method} ${target.pathname}`);
    }
    let body = {};
    try {
      body = JSON.parse(init.body || '{}');
    } catch {
      throw new Error('Blocked request with an unreadable body');
    }
    const model = String(body.model || '');
    if (rejectFree && model.endsWith(':free')) {
      throw new EvalInvariantError(`Refusing a free route ${model}`);
    }
    if ((!allowPaid && !model.endsWith(':free')) || !allowModels.has(model)) {
      throw new Error(`Blocked model ${model || '(missing)'}`);
    }
    const store = attemptStore.getStore();
    if (!store?.key) throw new Error('Completion posted outside a logical slot');
    if (store.expected && stableStringify(store.expected) !== stableStringify(body)) {
      throw new EvalInvariantError('POST body does not match the canonical request');
    }
    store.httpSeq = (store.httpSeq || 0) + 1;
    const attemptId = `${store.key}#${store.httpSeq}`;
    let promptTokens = 0;
    let maxTokens = 0;
    if (typeof budget.admit === 'function') {
      promptTokens = promptTokenCeiling(body.messages);
      maxTokens = Number(body.max_tokens);
      let decision;
      for (;;) {
        decision = budget.admit({
          attemptId,
          model,
          promptTokens,
          maxTokens,
        });
        if (decision.ok || decision.reason !== 'wait') break;
        await budget.waitForChange();
      }
        if (!decision.ok) {
          if (decision.reason === 'spent-attempt') {
            throw new EvalInvariantError(`Attempt ${attemptId} was already settled`);
          }
          throw new BudgetPaused(decision.reason || budget.state.pauseReason, budget.state.resumeAfter);
        }
      store.attemptId = attemptId;
    } else if (budget.state.paused || !budget.tryReserve(Date.now(), model)) {
      throw new BudgetPaused(budget.state.pauseReason, budget.state.resumeAfter);
    }
    const headers = headerObject(init.headers);
    const started = Date.now();
    const finishObserved = (status, text, error, contentType, retryAfter) => {
      const parsed = usageFromText(text, contentType);
      const incomplete = !bodyLooksComplete(text, contentType);
      const limit = status === 429 ? classifyLimitMessage(text) : null;
      if (status === 429 && limit === 'platform_day') {
        budget.pause('platform_day', nextUtcMidnight());
      }
      if (status === 429 && isUpstreamLimited(text)) {
        let wait = parseRetryAfter(
          retryAfter,
          MODEL_COOLDOWN_MS / 1000,
          MODEL_COOLDOWN_MAX_MS / 1000,
        );
        if (maxCooldownMs != null) wait = Math.min(wait, maxCooldownMs / 1000);
        onCooldown?.(model, Date.now() + wait * 1000);
      }
      onHttp?.({
        phase: 'finished',
        key: store.key,
        attemptId: store.attemptId,
        model,
        status,
        text,
        incomplete,
        error,
        usage: parsed.usage,
        usageKnown: parsed.known,
        promptTokens: parsed.usage?.prompt_tokens ?? null,
        completionTokens: parsed.usage?.completion_tokens ?? null,
        finishReason: parsed.finishReason,
        generationId: generationIdFrom(text),
        cancelReason: incomplete ? (error || null) : null,
        limit,
        serviceMs: Date.now() - started,
      });
      budget.charge?.(model, parsed.usage, parsed.known, body.max_tokens);
      const credit = classifyCreditResponse(status, text);
      const released = credit?.preProvider === true && !parsed.known;
      budget.settle?.({
        attemptId: store.attemptId,
        usage: released ? { cost: 0, releaseReason: credit.kind } : parsed.usage,
        incomplete: released ? false : (incomplete || !parsed.known),
        reason: credit?.kind || null,
      });
      if (credit?.kind === 'in_flight_budget' && store.inFlightRetried) {
        budget.pause?.('in_flight_budget', null);
      } else if (credit?.pause) {
        budget.pause?.(credit.kind, null);
      }
    };
    onHttp?.({
      phase: 'reserved',
      key: store.key,
      model,
      headers,
      body,
    });
    let response;
    try {
      response = await native(url, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onHttp?.({
        phase: 'error',
        key: store.key,
        attemptId: store.attemptId,
        model,
        error: message,
        network: isNetworkMessage(message),
        serviceMs: Date.now() - started,
      });
      budget.settle?.({ attemptId: store.attemptId, incomplete: true });
      throw error;
    }
    if ((response.status === 401 || response.status === 402 || response.status === 403) && typeof budget.admit === 'function') {
      const text = await response.text();
      const credit = classifyCreditResponse(response.status, text);
      onHttp?.({
        phase: 'finished',
        key: store.key,
        attemptId: store.attemptId,
        model,
        status: response.status,
        text,
        incomplete: false,
        usage: null,
        usageKnown: false,
        serviceMs: Date.now() - started,
      });
      const released = credit?.preProvider === true;
      budget.settle?.({
        attemptId: store.attemptId,
        usage: released ? { cost: 0, releaseReason: credit.kind } : null,
        incomplete: !released,
        reason: credit?.kind || null,
      });
      if (credit?.retryOnce && !store.inFlightRetried) {
        store.inFlightRetried = true;
        const wait = parseRetryAfter(response.headers.get('Retry-After'), 2);
        await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 30) * 1000));
        const retryId = `${store.key}#${store.httpSeq + 1}`;
        store.httpSeq += 1;
        let again;
        for (;;) {
          again = budget.admit({
            attemptId: retryId,
            model,
            promptTokens,
            maxTokens,
          });
          if (again.ok || again.reason !== 'wait') break;
          await budget.waitForChange();
        }
        if (!again.ok && again.reason === 'spent-attempt') {
          throw new EvalInvariantError(`Attempt ${retryId} was already settled`);
        }
        if (again.ok) {
          store.attemptId = retryId;
          const retried = await native(url, init);
          onHttp?.({ phase: 'response', key: store.key, status: retried.status });
          return teeResponse(retried, ({ text: retryText, error }) => finishObserved(
            retried.status,
            retryText,
            error,
            retried.headers.get('content-type') || '',
            retried.headers.get('Retry-After'),
          ));
        }
      }
      if (credit?.pause || credit?.retryOnce) budget.pause?.(credit.kind, null);
      return new Response(text, { status: response.status, headers: response.headers });
    }
    onHttp?.({ phase: 'response', key: store.key, status: response.status });
    return teeResponse(response, ({ text, error }) => finishObserved(
      response.status,
      text,
      error,
      response.headers.get('content-type') || '',
      response.headers.get('Retry-After'),
    ));
  };
  globalThis.fetch = wrapped;
  return () => {
    globalThis.fetch = native;
  };
}
