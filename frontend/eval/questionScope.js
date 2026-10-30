import { AsyncLocalStorage } from 'node:async_hooks';

export const questionStore = new AsyncLocalStorage();

globalThis.__consensusEvalQuestion = questionStore;

export function activeQuestion() {
  const scope = globalThis.__consensusEvalQuestion;
  if (!scope || typeof scope.getStore !== 'function') return null;
  return scope.getStore() || null;
}

export function createOverlayStorage() {
  const memory = new Map();
  const storage = {
    getItem(key) {
      const local = activeQuestion()?.local;
      if (local) return local.has(key) ? local.get(key) : null;
      return memory.has(key) ? memory.get(key) : null;
    },
    setItem(key, value) {
      const text = String(value);
      const local = activeQuestion()?.local;
      if (local) local.set(key, text);
      else memory.set(key, text);
    },
    removeItem(key) {
      const local = activeQuestion()?.local;
      if (local) local.delete(key);
      else memory.delete(key);
    },
    clear() {
      const local = activeQuestion()?.local;
      if (local) local.clear();
      else memory.clear();
    },
    key(index) {
      const local = activeQuestion()?.local;
      const keys = local ? [...local.keys()] : [...memory.keys()];
      return keys[index] ?? null;
    },
    get length() {
      const local = activeQuestion()?.local;
      return local ? local.size : memory.size;
    },
  };
  return {
    storage,
    clearGlobal() {
      memory.clear();
    },
  };
}

export function runIsolated(snapshot, worker, fn) {
  const local = new Map();
  if (snapshot && typeof snapshot === 'object') {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value != null) local.set(key, String(value));
    }
  }
  return questionStore.run({
    local,
    settingsState: null,
    context: null,
    active: 0,
    idle: [],
    worker,
  }, fn);
}
