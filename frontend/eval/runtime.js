import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { canonicalCompletionRequest, setQueryHook } from '../src/engine/browser/openrouter.js';
import { catalogueId } from '../src/engine/browser/roster.js';
import { STORAGE_KEY, resetSettingsState } from '../src/engine/browser/settings.js';
import { ENGINE_RETRY_LIMIT } from './protocol.js';
import { attemptStore } from './transport.js';
import { BudgetPaused } from './budget.js';
import { sha256, stableStringify } from './util.js';

const LOCAL_KEYS = [
  STORAGE_KEY,
  'llm-council-blocked-models',
  'llm-council-model-cooldowns',
];
const TERMINAL = new Set(['completed', 'failed', 'skipped']);

export function slotKey(slot) {
  return [slot.questionId, slot.branch, slot.stage, slot.sample, slot.model, slot.requestHash].join('|');
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split(/\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A torn final line is ignored until a later append completes it.
    }
  }
  return rows;
}

export function snapshotLocal() {
  const data = {};
  for (const key of LOCAL_KEYS) data[key] = localStorage.getItem(key);
  return data;
}

export function restoreLocal(snapshot) {
  for (const key of LOCAL_KEYS) {
    if (snapshot?.[key] == null) localStorage.removeItem(key);
    else localStorage.setItem(key, snapshot[key]);
  }
  resetSettingsState();
}

export function createSession({ runDir, budget, log = console.log }) {
  mkdirSync(runDir, { recursive: true });
  mkdirSync(path.join(runDir, 'bodies'), { recursive: true });
  const journalPath = path.join(runDir, 'events.jsonl');
  const cooldownPath = path.join(runDir, 'cooldowns.json');
  const slots = new Map();
  const inFlight = new Set();
  const cooldowns = new Map();
  let context = null;
  let active = 0;
  const idleWaiters = [];
  let bodySeq = 0;
  let ordinal = 0;

  if (existsSync(cooldownPath)) {
    const saved = JSON.parse(readFileSync(cooldownPath, 'utf8'));
    for (const [id, until] of Object.entries(saved)) cooldowns.set(id, until);
  }
  for (const event of readJsonl(journalPath)) applyEvent(event);
  for (const [key, slot] of slots) {
    if (slot.state === 'running') {
      slot.state = 'unknown';
      slots.set(key, slot);
    }
  }

  function applyEvent(event) {
    if (event.kind === 'cooldown') {
      cooldowns.set(event.model, event.until);
      return;
    }
    if (event.kind === 'http') {
      const slot = slots.get(event.key) || { key: event.key, httpAttempts: 0, serviceMs: 0 };
      if (event.phase === 'reserved') slot.httpAttempts = (slot.httpAttempts || 0) + 1;
      if (event.phase === 'response') slot.responseSeen = true;
      if (event.phase === 'finished' || event.phase === 'error') {
        slot.usageKnown = event.usageKnown === true;
        slot.usage = event.usage || null;
        slot.finishReason = event.finishReason || null;
        slot.serviceMs = (slot.serviceMs || 0) + (event.serviceMs || 0);
        slot.incompleteHttp = event.incomplete === true;
        slot.httpStatus = event.status ?? slot.httpStatus ?? null;
      }
      slots.set(event.key, slot);
      return;
    }
    if (event.kind === 'slot') {
      const prev = slots.get(event.key) || {};
      const next = { ...prev, ...event.slot };
      next.httpAttempts = Math.max(prev.httpAttempts || 0, event.slot?.httpAttempts || 0);
      next.serviceMs = Math.max(prev.serviceMs || 0, event.slot?.serviceMs || 0);
      next.responseSeen = Boolean(prev.responseSeen || event.slot?.responseSeen);
      next.usageKnown = prev.usageKnown === true || event.slot?.usageKnown === true;
      slots.set(event.key, next);
      if (next.completedOrdinal > ordinal) ordinal = next.completedOrdinal;
    }
  }

  function append(event) {
    appendFileSync(journalPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  function writeSlot(key, slot) {
    slots.set(key, slot);
    append({ kind: 'slot', key, slot });
  }

  function persistCooldowns() {
    const data = Object.fromEntries(cooldowns);
    const tmp = `${cooldownPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, cooldownPath);
  }

  function enter() {
    active += 1;
  }

  function leave() {
    active -= 1;
    if (active === 0) {
      const waiters = idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  async function drain() {
    if (active === 0) return;
    await new Promise((resolve) => idleWaiters.push(resolve));
  }

  function onHttp(event) {
    if (event.phase === 'finished' && event.text) {
      bodySeq += 1;
      const file = path.join(runDir, 'bodies', `${bodySeq}.txt`);
      writeFileSync(file, event.text, 'utf8');
      event = { ...event, bodyFile: path.basename(file), text: undefined };
    }
    append({ kind: 'http', ...event, headers: event.headers || undefined });
    applyEvent({ kind: 'http', ...event });
  }

  function onCooldown(model, until) {
    const id = catalogueId(model);
    const current = cooldowns.get(id) || 0;
    if (until > current) cooldowns.set(id, until);
    append({ kind: 'cooldown', model: id, until: cooldowns.get(id) });
    persistCooldowns();
  }

  async function hook({ model, messages, options, execute }) {
    enter();
    let key = null;
    try {
      if (!context) throw new Error('Logical call context is not set');
      const request = canonicalCompletionRequest(model, messages, options);
      const requestHash = sha256(stableStringify(request));
      const slotMeta = {
        questionId: context.questionId,
        branch: context.branch,
        stage: context.stage,
        sample: context.sample ?? 1,
        model,
        requestHash,
      };
      key = slotKey(slotMeta);
      const existing = slots.get(key);
      if (existing && TERMINAL.has(existing.state)) return existing.result;
      if (inFlight.has(key)) throw new Error(`Duplicate in-flight logical slot ${key}`);
      if (budget.state.paused) {
        throw new BudgetPaused(budget.state.pauseReason, budget.state.resumeAfter);
      }
      const cooling = cooldowns.get(catalogueId(model)) || 0;
      if (cooling > Date.now()) {
        const skipped = {
          ok: false,
          skipped: true,
          error: { status: 429, message: 'Temporarily unavailable (cooldown)', kind: 'cooldown' },
        };
        writeSlot(key, {
          ...(existing || {}),
          key,
          meta: slotMeta,
          state: 'skipped',
          result: skipped,
        });
        return skipped;
      }
      const remaining = ENGINE_RETRY_LIMIT - (existing?.httpAttempts || 0);
      if (remaining <= 0) {
        const exhausted = existing?.result || {
          ok: false,
          error: { message: 'Retry budget exhausted', kind: 'retries' },
        };
        writeSlot(key, {
          ...(existing || {}),
          key,
          meta: slotMeta,
          request,
          state: 'failed',
          result: exhausted,
        });
        return exhausted;
      }
      inFlight.add(key);
      writeSlot(key, {
        ...(existing || {}),
        key,
        meta: slotMeta,
        request,
        state: 'running',
        result: null,
        httpAttempts: existing?.httpAttempts || 0,
      });
      const started = Date.now();
      let result;
      try {
        result = await attemptStore.run({ key }, () => execute({ maxRetries: remaining }));
      } catch (error) {
        if (error instanceof BudgetPaused || budget.state.paused) {
          writeSlot(key, { ...slots.get(key), state: 'pending', result: null });
          throw error;
        }
        writeSlot(key, { ...slots.get(key), state: 'unknown', result: null });
        throw error;
      }
      const current = slots.get(key) || {};
      if (budget.state.paused && !result?.ok) {
        writeSlot(key, { ...current, state: 'pending', result: null, occupiedMs: Date.now() - started });
        return result;
      }
      if (result && result.finishReason == null && current.finishReason) {
        result = { ...result, finishReason: current.finishReason };
      }
      ordinal += 1;
      const state = result?.skipped ? 'skipped' : result?.ok ? 'completed' : 'failed';
      writeSlot(key, {
        ...current,
        key,
        meta: slotMeta,
        request,
        state,
        result,
        completedOrdinal: ordinal,
        occupiedMs: Date.now() - started,
        usageKnown: current.usageKnown === true,
      });
      log(`${slotMeta.branch} ${slotMeta.stage} ${slotMeta.model} sample ${slotMeta.sample} ${state}`);
      return result;
    } finally {
      if (key) inFlight.delete(key);
      leave();
    }
  }

  function install() {
    setQueryHook(hook);
  }

  function uninstall() {
    setQueryHook(null);
  }

  return {
    budget,
    log,
    install,
    uninstall,
    drain,
    onHttp,
    onCooldown,
    setContext(next) {
      context = next;
    },
    snapshotLocal,
    restoreLocal,
    slot(key) {
      return slots.get(key) || null;
    },
    slots() {
      return [...slots.values()];
    },
    cooldowns,
  };
}
