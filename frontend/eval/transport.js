import { AsyncLocalStorage } from 'node:async_hooks';

import { parseRetryAfter } from '../src/engine/browser/openrouter.js';
import {
  MODEL_COOLDOWN_MAX_MS,
  MODEL_COOLDOWN_MS,
  isUpstreamLimited,
} from '../src/engine/browser/roster.js';
import { BudgetPaused, classifyLimitMessage, nextUtcMidnight } from './budget.js';

export const attemptStore = new AsyncLocalStorage();

const ALLOWED_GET = new Set([
  '/api/v1/models',
  '/api/v1/key',
  '/api/v1/credits',
]);

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
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed?.usage && typeof parsed.usage === 'object') usage = parsed.usage;
        const reason = parsed?.choices?.[0]?.finish_reason;
        if (reason) finishReason = reason;
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
  budget,
  onHttp,
  onCooldown,
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
    if (!model.endsWith(':free') || !allowModels.has(model)) {
      throw new Error(`Blocked model ${model || '(missing)'}`);
    }
    const store = attemptStore.getStore();
    if (!store?.key) throw new Error('Completion posted outside a logical slot');
    if (budget.state.paused || !budget.tryReserve()) {
      throw new BudgetPaused(budget.state.pauseReason, budget.state.resumeAfter);
    }
    const headers = headerObject(init.headers);
    const started = Date.now();
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
      onHttp?.({
        phase: 'error',
        key: store.key,
        model,
        error: error instanceof Error ? error.message : String(error),
        serviceMs: Date.now() - started,
      });
      throw error;
    }
    onHttp?.({ phase: 'response', key: store.key, status: response.status });
    return teeResponse(response, ({ text, error }) => {
      const contentType = response.headers.get('content-type') || '';
      const parsed = usageFromText(text, contentType);
      const incomplete = !bodyLooksComplete(text, contentType);
      const limit = classifyLimitMessage(text);
      if (response.status === 429 && limit === 'platform_day') {
        budget.pause('platform_day', nextUtcMidnight());
      }
      if (response.status === 429 && isUpstreamLimited(text)) {
        const wait = parseRetryAfter(
          response.headers.get('Retry-After'),
          MODEL_COOLDOWN_MS / 1000,
          MODEL_COOLDOWN_MAX_MS / 1000,
        );
        onCooldown?.(model, Date.now() + wait * 1000);
      }
      onHttp?.({
        phase: 'finished',
        key: store.key,
        model,
        status: response.status,
        text,
        incomplete,
        error,
        usage: parsed.usage,
        usageKnown: parsed.known,
        finishReason: parsed.finishReason,
        limit,
        serviceMs: Date.now() - started,
        provider: response.headers.get('x-openrouter-provider') || response.headers.get('openrouter-provider') || null,
        requestId: response.headers.get('x-request-id') || null,
      });
    });
  };
  globalThis.fetch = wrapped;
  return () => {
    globalThis.fetch = native;
  };
}
