import { catalogueId, isFreeModel } from '../src/engine/browser/roster.js';
import { CONSERVATIVE_DAILY_POSTS, TOTAL_POST_CAP } from './protocol.js';
import { quoteReservation, usageCost } from './paid.js';

const DURABLE_PAUSE = new Set([
  'auth',
  'insufficient_funds',
  'key_budget',
  'payment_unknown',
]);

export class BudgetPaused extends Error {
  constructor(reason, resumeAfter = null) {
    super(reason || 'paused');
    this.name = 'BudgetPaused';
    this.reason = reason || 'paused';
    this.resumeAfter = resumeAfter;
  }
}

export function nextUtcMidnight(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export function createBudget(options = {}) {
  const state = {
    totalCap: options.totalCap ?? TOTAL_POST_CAP,
    dailyLimit: options.dailyLimit ?? null,
    conservativeDaily: options.conservativeDaily ?? CONSERVATIVE_DAILY_POSTS,
    attempted: options.attempted ?? 0,
    attemptedToday: options.attemptedToday ?? 0,
    utcDay: options.utcDay ?? new Date().toISOString().slice(0, 10),
    paused: false,
    pauseReason: null,
    resumeAfter: null,
    serverRemaining: options.serverRemaining ?? null,
  };

  function rollDay(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day === state.utcDay) return false;
    state.utcDay = day;
    state.attemptedToday = 0;
    // Yesterday's remaining and limit are not today's counter.
    state.serverRemaining = null;
    state.dailyLimit = null;
    return true;
  }

  function dailyCeiling() {
    if (state.dailyLimit != null) return state.dailyLimit;
    return state.conservativeDaily;
  }

  return {
    state,
    rollDay,
    noteServer(info) {
      if (!info) return;
      const bucket = info.free_model_daily_requests || info.freeModelDailyRequests || null;
      if (bucket && bucket.remaining != null) state.serverRemaining = Number(bucket.remaining);
      else if (bucket && bucket.limit != null && bucket.used != null) {
        state.serverRemaining = Number(bucket.limit) - Number(bucket.used);
      } else {
        state.serverRemaining = null;
      }
      if (bucket && bucket.limit != null) state.dailyLimit = Number(bucket.limit);
    },
    tryReserve(now = Date.now()) {
      rollDay(now);
      if (state.paused) return false;
      if (state.attempted >= state.totalCap) {
        state.paused = true;
        state.pauseReason = 'total_cap';
        state.resumeAfter = null;
        return false;
      }
      const remainingKnown = state.serverRemaining != null;
      const dayExhausted = remainingKnown
        ? state.serverRemaining <= 0
        : state.attemptedToday >= dailyCeiling();
      if (dayExhausted) {
        state.paused = true;
        state.pauseReason = 'platform_day';
        state.resumeAfter = nextUtcMidnight(now);
        return false;
      }
      state.attempted += 1;
      state.attemptedToday += 1;
      if (remainingKnown) state.serverRemaining -= 1;
      return true;
    },
    pause(reason, resumeAfter = null) {
      state.paused = true;
      state.pauseReason = reason;
      state.resumeAfter = resumeAfter;
    },
    resumeIfDue(now = Date.now()) {
      if (!state.paused) return false;
      if (state.resumeAfter != null && now >= state.resumeAfter) {
        state.paused = false;
        state.pauseReason = null;
        state.resumeAfter = null;
        rollDay(now);
        return true;
      }
      return false;
    },
    snapshot() {
      return { ...state };
    },
    restore(saved) {
      Object.assign(state, saved);
    },
  };
}

export function createSpendBudget(options = {}) {
  const pricing = options.pricing || new Map();
  const state = {
    maxPosts: options.maxPosts ?? 1500,
    maxUsd: options.maxUsd ?? 15,
    posts: options.posts ?? 0,
    attempted: options.posts ?? 0,
    usd: options.usd ?? 0,
    usageUnknownCharged: options.usageUnknownCharged ?? 0,
    freePostsToday: options.freePostsToday ?? 0,
    freeRemaining: options.freeRemaining ?? null,
    freeLimit: options.freeLimit ?? null,
    conservativeDaily: options.conservativeDaily ?? CONSERVATIVE_DAILY_POSTS,
    utcDay: options.utcDay ?? new Date().toISOString().slice(0, 10),
    paused: false,
    pauseReason: null,
    resumeAfter: null,
  };

  function rollDay(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day === state.utcDay) return false;
    state.utcDay = day;
    state.freePostsToday = 0;
    state.freeRemaining = null;
    state.freeLimit = null;
    return true;
  }

  function pauseSpend() {
    state.paused = true;
    state.pauseReason = 'spend_cap';
    state.resumeAfter = null;
  }

  return {
    state,
    rollDay,
    noteServer(info) {
      if (!info) return;
      const bucket = info.free_model_daily_requests || info.freeModelDailyRequests || null;
      if (bucket && bucket.remaining != null) state.freeRemaining = Number(bucket.remaining);
      else if (bucket && bucket.limit != null && bucket.used != null) {
        state.freeRemaining = Number(bucket.limit) - Number(bucket.used);
      } else {
        state.freeRemaining = null;
      }
      if (bucket && bucket.limit != null) state.freeLimit = Number(bucket.limit);
    },
    tryReserve(now = Date.now(), model = '') {
      rollDay(now);
      if (state.paused) return false;
      if (state.posts >= state.maxPosts || state.usd >= state.maxUsd) {
        pauseSpend();
        return false;
      }
      if (isFreeModel(model)) {
        const dayExhausted = state.freeRemaining != null
          ? state.freeRemaining <= 0
          : state.freePostsToday >= state.conservativeDaily;
        if (dayExhausted) {
          state.paused = true;
          state.pauseReason = 'platform_day';
          state.resumeAfter = nextUtcMidnight(now);
          return false;
        }
      }
      state.posts += 1;
      state.attempted += 1;
      if (isFreeModel(model)) {
        state.freePostsToday += 1;
        if (state.freeRemaining != null) state.freeRemaining -= 1;
      }
      return true;
    },
    charge(model, usage, usageKnown, maxTokens = 0) {
      const price = pricing.get(catalogueId(model)) || { prompt: 0, completion: 0 };
      let cost = 0;
      if (usageKnown && usage) {
        cost = Number(usage.prompt_tokens || 0) * price.prompt
          + Number(usage.completion_tokens || 0) * price.completion;
      } else {
        cost = Number(maxTokens || 0) * price.completion;
        state.usageUnknownCharged += 1;
      }
      state.usd += Number.isFinite(cost) ? cost : 0;
      if (state.usd >= state.maxUsd || state.posts >= state.maxPosts) pauseSpend();
    },
    pause(reason, resumeAfter = null) {
      state.paused = true;
      state.pauseReason = reason;
      state.resumeAfter = resumeAfter;
    },
    resumeIfDue(now = Date.now()) {
      if (!state.paused) return false;
      if (state.resumeAfter != null && now >= state.resumeAfter) {
        state.paused = false;
        state.pauseReason = null;
        state.resumeAfter = null;
        rollDay(now);
        return true;
      }
      return false;
    },
    snapshot() {
      return { ...state };
    },
    restore(saved) {
      if (!saved) return;
      Object.assign(state, saved);
    },
  };
}

export function createCampaignBudget(options = {}) {
  const prices = options.prices instanceof Map
    ? options.prices
    : new Map(Object.entries(options.prices || {}));
  const state = {
    maxUsd: options.maxUsd ?? 60,
    maxPosts: options.maxPosts ?? 4000,
    posts: 0,
    settledUsd: 0,
    unresolvedUsd: 0,
    paused: false,
    pauseReason: null,
    resumeAfter: null,
    fatal: null,
    reservations: {},
  };
  const waiters = [];
  let applyingJournal = false;

  function held() {
    return state.settledUsd + state.unresolvedUsd;
  }

  function notify() {
    const pending = waiters.splice(0);
    for (const resolve of pending) resolve();
  }

  function openCount() {
    return Object.values(state.reservations).filter((row) => row && row.open).length;
  }

  function remember(event) {
    if (typeof options.onEvent === 'function' && !applyingJournal) options.onEvent(event);
  }

  return {
    state,
    quote(model, promptTokens, maxTokens) {
      return quoteReservation({
        pricing: prices.get(catalogueId(model)),
        promptTokens,
        maxTokens,
      });
    },
    admit({ attemptId, model, promptTokens, maxTokens }) {
      if (state.fatal) return { ok: false, reason: 'fatal' };
      if (state.paused && state.pauseReason) return { ok: false, reason: state.pauseReason };
      if (!attemptId) return { ok: false, reason: 'missing-attempt' };
      if (state.reservations[attemptId]?.settled) return { ok: false, reason: 'spent-attempt' };
      if (state.reservations[attemptId]?.open) {
        return { ok: true, usd: state.reservations[attemptId].usd, duplicate: true };
      }
      const quote = this.quote(model, promptTokens, maxTokens);
      if (!quote) return { ok: false, reason: 'unbounded_price' };
      if (state.posts + 1 > state.maxPosts || held() + quote.usd > state.maxUsd + 1e-12) {
        if (openCount() > 0) return { ok: false, reason: 'wait' };
        state.paused = true;
        state.pauseReason = 'budget_blocked';
        state.resumeAfter = null;
        return { ok: false, reason: 'budget_blocked' };
      }
      state.posts += 1;
      state.unresolvedUsd += quote.usd;
      state.reservations[attemptId] = {
        open: true,
        settled: false,
        usd: quote.usd,
        model: catalogueId(model),
        promptTokens,
        maxTokens,
      };
      remember({
        kind: 'reserve',
        attemptId,
        model: catalogueId(model),
        usd: quote.usd,
        promptTokens,
        maxTokens,
        posts: state.posts,
      });
      return { ok: true, usd: quote.usd };
    },
    settle({ attemptId, usage, incomplete = false, pricing = null }) {
      const row = state.reservations[attemptId];
      if (!row || row.settled) return { duplicate: Boolean(row?.settled) };
      row.open = false;
      row.settled = true;
      state.unresolvedUsd = Math.max(0, state.unresolvedUsd - row.usd);
      let cost = null;
      if (!incomplete && usage) {
        const table = pricing || prices.get(row.model);
        cost = usageCost(table, usage);
      }
      if (cost == null) {
        state.unresolvedUsd += row.usd;
        row.unresolved = true;
        row.cost = null;
      } else {
        state.settledUsd += cost;
        row.unresolved = false;
        row.cost = cost;
      }
      remember({
        kind: 'settle',
        attemptId,
        cost: row.cost,
        unresolved: row.unresolved === true,
        settledUsd: state.settledUsd,
        unresolvedUsd: state.unresolvedUsd,
      });
      notify();
      if (state.settledUsd >= state.maxUsd - 1e-12) {
        state.paused = true;
        state.pauseReason = 'budget_blocked';
      }
      return { cost: row.cost, unresolved: row.unresolved === true };
    },
    // Replaces an unresolved reserve with the cost OpenRouter reports for that
    // attempt's generation. Only an unresolved row changes, so a second
    // reconcile of the same attempt does nothing. POST counts never change.
    resettle({ attemptId, cost, source = null }) {
      const row = state.reservations[attemptId];
      const value = Number(cost);
      if (!row || !row.settled || !row.unresolved) return { applied: false };
      if (cost == null || !Number.isFinite(value) || value < 0) return { applied: false };
      state.unresolvedUsd = Math.max(0, state.unresolvedUsd - row.usd);
      state.settledUsd += value;
      row.unresolved = false;
      row.cost = value;
      row.resettled = true;
      remember({
        kind: 'resettle',
        attemptId,
        cost: value,
        source,
        settledUsd: state.settledUsd,
        unresolvedUsd: state.unresolvedUsd,
      });
      notify();
      return { applied: true, cost: value };
    },
    // Key-level spend snapshot. It is an audit only: other requests on the
    // key and billing delay make it unusable for releasing one reserve.
    audit(snapshot = {}) {
      const event = { kind: 'audit', at: new Date().toISOString(), ...snapshot };
      state.lastAudit = event;
      remember(event);
      return event;
    },
    unresolvedAttempts() {
      return Object.entries(state.reservations)
        .filter(([, row]) => row && row.settled && row.unresolved)
        .map(([attemptId, row]) => ({ attemptId, ...row }));
    },
    waitForChange() {
      return new Promise((resolve) => waiters.push(resolve));
    },
    lockFatal(reason) {
      state.fatal = reason || 'fatal';
      state.paused = true;
      state.pauseReason = 'fatal';
      state.resumeAfter = null;
      notify();
    },
    applyJournal(events) {
      applyingJournal = true;
      try {
        for (const event of events || []) {
          if (event.kind === 'reserve') {
            if (state.reservations[event.attemptId]) continue;
            const usd = Number(event.usd);
            state.posts += 1;
            state.unresolvedUsd += usd;
            state.reservations[event.attemptId] = {
              open: true,
              settled: false,
              usd,
              model: event.model,
              promptTokens: event.promptTokens,
              maxTokens: event.maxTokens,
            };
          } else if (event.kind === 'settle') {
            const row = state.reservations[event.attemptId];
            if (!row || row.settled) continue;
            row.open = false;
            row.settled = true;
            state.unresolvedUsd = Math.max(0, state.unresolvedUsd - row.usd);
            if (event.unresolved || event.cost == null) {
              state.unresolvedUsd += row.usd;
              row.unresolved = true;
              row.cost = null;
            } else {
              state.settledUsd += Number(event.cost);
              row.unresolved = false;
              row.cost = Number(event.cost);
            }
          } else if (event.kind === 'resettle') {
            const row = state.reservations[event.attemptId];
            if (!row || !row.settled || !row.unresolved) continue;
            state.unresolvedUsd = Math.max(0, state.unresolvedUsd - row.usd);
            state.settledUsd += Number(event.cost);
            row.unresolved = false;
            row.cost = Number(event.cost);
            row.resettled = true;
          } else if (event.kind === 'audit') {
            state.lastAudit = event;
          } else if (event.kind === 'pause' && DURABLE_PAUSE.has(event.reason)) {
            state.paused = true;
            state.pauseReason = event.reason;
            state.resumeAfter = event.resumeAfter ?? null;
          } else if (event.kind === 'resume' && state.paused && !state.fatal && state.pauseReason === event.reason) {
            state.paused = false;
            state.pauseReason = null;
            state.resumeAfter = null;
          }
        }
      } finally {
        applyingJournal = false;
      }
    },
    pause(reason, resumeAfter = null) {
      state.paused = true;
      state.pauseReason = reason;
      state.resumeAfter = resumeAfter;
      if (DURABLE_PAUSE.has(reason)) remember({ kind: 'pause', reason, resumeAfter });
    },
    // Lifts a durable pause (auth, key budget, funds) once a person fixed its
    // cause and the caller has evidence of that. The evidence goes into the
    // journal, so a restart replays the lift. A fatal stop never lifts.
    resumeDurable({ reason, evidence }) {
      if (!state.paused || state.fatal || state.pauseReason !== reason || !DURABLE_PAUSE.has(reason)) return { applied: false };
      state.paused = false;
      state.pauseReason = null;
      state.resumeAfter = null;
      remember({ kind: 'resume', reason, evidence: evidence || null, at: new Date().toISOString() });
      return { applied: true };
    },
    isTransientPause() {
      return state.paused && !state.fatal && isTransientReason(state.pauseReason);
    },
    // Lifts a pause that waiting can cure (a dropped connection, the key's
    // in-flight budget). Credit, auth, spend-cap and fatal stops stay.
    resumeTransient() {
      if (!this.isTransientPause()) return false;
      state.paused = false;
      state.pauseReason = null;
      state.resumeAfter = null;
      notify();
      return true;
    },
  };
}

export function isTransientReason(reason) {
  return Boolean(reason) && !DURABLE_PAUSE.has(reason) && reason !== 'budget_blocked' && reason !== 'fatal';
}

export function classifyCreditResponse(status, text) {
  if (status === 401) return { kind: 'auth', preProvider: true, retryOnce: false, pause: true };
  if (status === 402) {
    const raw = String(text || '').toLowerCase();
    const inFlight = raw.includes('openrouter_in_flight_budget')
      || raw.includes('in-flight')
      || raw.includes('in flight');
    if (inFlight) return { kind: 'in_flight_budget', preProvider: true, retryOnce: true, pause: false };
    const short = raw.includes('weight_exceeds_budget')
      || raw.includes('maximum cost')
      || raw.includes('insufficient')
      || raw.includes('add credits')
      || raw.includes('cannot afford');
    if (short) return { kind: 'insufficient_funds', preProvider: true, retryOnce: false, pause: true };
    return { kind: 'payment_unknown', preProvider: false, retryOnce: false, pause: true };
  }
  if (status === 403) {
    const raw = String(text || '').toLowerCase();
    const budget = raw.includes('guardrail')
      || raw.includes('key limit')
      || raw.includes('key_limit')
      || raw.includes("key's limit")
      || raw.includes('workspace');
    if (budget) return { kind: 'key_budget', preProvider: true, retryOnce: false, pause: true };
    return { kind: 'forbidden', preProvider: false, retryOnce: false, pause: false };
  }
  return null;
}

export function classifyLimitMessage(text) {
  const lowered = String(text || '').toLowerCase();
  if (lowered.includes('free-models-per-min')) return 'platform_minute';
  if (lowered.includes('free-models-per-day')) return 'platform_day';
  return null;
}
