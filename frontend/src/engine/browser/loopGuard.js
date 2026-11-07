// Detects a completion that has started repeating itself.
//
// The check runs at fixed positions of the accumulated text of one channel,
// so the decision does not depend on how the network split the stream into
// chunks. A position is checked once; an empty chunk adds no new decision.

export const LOOP_GUARD_DEFAULTS = Object.freeze({
  tailChars: 4000,
  historyChars: 24000,
  shingleChars: 40,
  stride: 8,
  threshold: 0.8,
  checkEvery: 2000,
  consecutive: 2,
});

const POSITIVE_FIELDS = ['tailChars', 'historyChars', 'shingleChars', 'stride', 'checkEvery', 'consecutive'];

export function loopGuardConfig(config) {
  if (!config) return null;
  const merged = { ...LOOP_GUARD_DEFAULTS, ...(config === true ? {} : config) };
  for (const field of POSITIVE_FIELDS) {
    if (!Number.isInteger(merged[field]) || merged[field] < 1) {
      throw new Error(`loopGuard ${field} must be a positive integer`);
    }
  }
  if (!(merged.threshold > 0 && merged.threshold <= 1)) {
    throw new Error('loopGuard threshold must be in (0, 1]');
  }
  return merged;
}

// Share of the tail's shingles that already occur in the text before the
// tail, or null when there is not enough text before it to compare.
export function repeatShare(text, end, config) {
  const cfg = loopGuardConfig(config);
  const tailStart = end - cfg.tailChars;
  if (tailStart < 0) return null;
  const history = text.slice(Math.max(0, tailStart - cfg.historyChars), tailStart);
  if (history.length < cfg.shingleChars) return null;
  const seen = new Set();
  for (let index = 0; index + cfg.shingleChars <= history.length; index += 1) {
    seen.add(history.substr(index, cfg.shingleChars));
  }
  const tail = text.slice(tailStart, end);
  let total = 0;
  let hits = 0;
  for (let index = 0; index + cfg.shingleChars <= tail.length; index += cfg.stride) {
    total += 1;
    if (seen.has(tail.substr(index, cfg.shingleChars))) hits += 1;
  }
  return total ? hits / total : null;
}

// Watches one growing text. `observe` takes the whole accumulated text and
// returns the first trigger once `consecutive` checks in a row see the tail
// repeating what came before it.
export function createLoopDetector(config) {
  const cfg = loopGuardConfig(config);
  if (!cfg) return null;
  let next = cfg.tailChars + cfg.checkEvery;
  let hot = 0;
  let fired = null;
  return {
    config: cfg,
    get next() {
      return next;
    },
    observe(text) {
      if (fired) return fired;
      const value = String(text || '');
      while (next <= value.length) {
        const at = next;
        next += cfg.checkEvery;
        const share = repeatShare(value, at, cfg);
        if (share == null) {
          hot = 0;
          continue;
        }
        hot = share >= cfg.threshold ? hot + 1 : 0;
        if (hot >= cfg.consecutive) {
          fired = { position: at, share };
          return fired;
        }
      }
      return null;
    },
  };
}

// Whole-text check, for tests and for replaying saved outputs offline.
export function detectLoop(text, config = true) {
  return createLoopDetector(config).observe(text);
}
