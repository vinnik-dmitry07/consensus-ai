import { CONSERVATIVE_DAILY_POSTS, TOTAL_POST_CAP } from './protocol.js';

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

export function classifyLimitMessage(text) {
  const lowered = String(text || '').toLowerCase();
  if (lowered.includes('free-models-per-min')) return 'platform_minute';
  if (
    lowered.includes('free-models-per-day')
    || lowered.includes('per-day')
    || (lowered.includes('daily') && lowered.includes('limit'))
  ) {
    return 'platform_day';
  }
  return null;
}
