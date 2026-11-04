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

// Runs fn as one branch of the current question: it shares the question's
// localStorage overlay and settings, but has its own logical-call context and
// its own drain counter, so parallel branches cannot overwrite each other's
// slot metadata or wait on each other's calls.
export function runBranch(context, fn) {
  const parent = activeQuestion();
  const child = parent
    ? Object.create(parent, {
      settingsState: {
        get() { return parent.settingsState; },
        set(value) { parent.settingsState = value; },
        enumerable: true,
      },
    })
    : { local: null, settingsState: null, worker: null };
  child.context = context;
  child.active = 0;
  child.idle = [];
  return questionStore.run(child, fn);
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
