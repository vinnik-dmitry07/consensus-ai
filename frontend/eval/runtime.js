import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { canonicalCompletionRequest, setQueryHook } from '../src/engine/browser/openrouter.js';
import { catalogueId } from '../src/engine/browser/roster.js';
import { STORAGE_KEY, resetSettingsState } from '../src/engine/browser/settings.js';
import { ENGINE_RETRY_LIMIT } from './protocol.js';
import { attemptStore, isNetworkMessage } from './transport.js';
import { BudgetPaused } from './budget.js';
import { EvalInvariantError, isEvalInvariant } from './invariant.js';
import { activeQuestion } from './questionScope.js';
import { sha256, stableStringify } from './util.js';

const LOCAL_KEYS = [
  STORAGE_KEY,
  'llm-council-blocked-models',
  'llm-council-model-cooldowns',
  'llm-council-upstream-incidents',
];
const TERMINAL = new Set(['completed', 'failed', 'skipped']);
const NETWORK_BACKOFF_MS = 30_000;
// How long a route that answered "out of capacity" inside its stream is left
// alone. An upstream 429 brings its own cooldown from the transport.
export const CAPACITY_COOLDOWN_MS = 120_000;
const CAPACITY_TEXT = /temporarily (rate-limited|at cap|unavailable|overloaded)|rate-limited upstream|at capacity/i;

// A refusal before any generation because the route is out of capacity: the
// upstream 429 the engine reports as skipped, or an in-stream provider error
// such as "temporarily at cap" with no text. Rate limits are the provider's
// load, not the method's answer, so such a refusal is not a model attempt:
// the slot waits for the route's cooldown and is asked again.
export function isCapacityRefusal(result) {
  if (!result || result.ok) return false;
  if (String(result.content || '').trim()) return false;
  const text = `${result.error?.message || ''} ${result.error?.detail || ''}`;
  return CAPACITY_TEXT.test(text);
}

// A counting gate that hands a released place straight to the next waiter, so
// a caller arriving between release and wake-up cannot push it over the limit.
export function createGate(limit) {
  let active = 0;
  const waiters = [];
  return {
    async acquire() {
      if (!limit || active < limit) {
        active += 1;
        return;
      }
      await new Promise((resolve) => waiters.push(resolve));
    },
    release() {
      const next = waiters.shift();
      if (next) next();
      else active = Math.max(0, active - 1);
    },
    get active() {
      return active;
    },
  };
}

export function slotKey(slot) {
  const parts = [slot.questionId, slot.branch, slot.stage, slot.sample, slot.model, slot.requestHash];
  if ((slot.attempt || 0) > 0) parts.push(`a${slot.attempt}`);
  return parts.join('|');
}

function attemptLabel(slotMeta) {
  return slotMeta.attempt > 0 ? ` attempt ${slotMeta.attempt}` : '';
}

export function readSlotMap(file) {
  const slots = new Map();
  for (const event of readJsonl(file)) {
    if (event.kind !== 'slot' || !event.key) continue;
    const prev = slots.get(event.key) || {};
    slots.set(event.key, { ...prev, ...event.slot });
  }
  return slots;
}

export function networkOutageCount(file) {
  const byQuestion = new Map();
  for (const slot of readSlotMap(file).values()) {
    if (slot.meta?.branch !== 'council' || slot.meta?.stage !== 'stage1') continue;
    if (!String(slot.meta.questionId || '').startsWith('test:')) continue;
    const list = byQuestion.get(slot.meta.questionId) || [];
    list.push(slot);
    byQuestion.set(slot.meta.questionId, list);
  }
  let count = 0;
  for (const list of byQuestion.values()) {
    if (list.length && list.every((slot) => isNetworkMessage(slot.result?.error?.message))) count += 1;
  }
  return count;
}

// Slot map plus the number of HTTP attempts each slot reserved. A slot cut off
// mid-call never wrote its final count, so the reserve events decide.
export function readSlotJournal(file) {
  const slots = readSlotMap(file);
  const reserved = new Map();
  const ended = new Map();
  for (const event of readJsonl(file)) {
    if (event.kind !== 'http' || !event.key) continue;
    if (event.phase === 'reserved') reserved.set(event.key, (reserved.get(event.key) || 0) + 1);
    if (event.phase === 'finished' || event.phase === 'error') ended.set(event.key, (ended.get(event.key) || 0) + 1);
  }
  for (const [key, slot] of slots) {
    slot.httpAttempts = Math.max(slot.httpAttempts || 0, reserved.get(key) || 0);
    slot.cutAttempts = cutCount(reserved.get(key), ended.get(key));
  }
  return slots;
}

// POSTs a journal reserved but never closed: the runner stopped while they
// streamed. The model gave no answer and no error, so such a POST is not one
// of the call's attempts. It is read only from a journal no runner is writing.
function cutCount(reserved = 0, ended = 0) {
  return Math.max(0, reserved - ended);
}

// Attempts a call has used: every POST except refusals before generation and
// POSTs cut off by a stopped runner.
export function spentAttempts(slot) {
  return Math.max(0, (slot?.httpAttempts || 0) - (slot?.limitedAttempts || 0) - (slot?.cutAttempts || 0));
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

export function createSession({
  runDir,
  budget,
  log = console.log,
  replayFrom = null,
  aliasOf = null,
  replayTerminal = false,
  prepareOptions = null,
  retryLimit = null,
  maxInFlight = null,
  maxInFlightPerModel = null,
  priorAttempts = null,
  priorFreeAttempts = null,
  retainRoster = false,
  retryAfterCooldown = false,
}) {
  mkdirSync(runDir, { recursive: true });
  const bodyDir = path.join(runDir, 'bodies');
  mkdirSync(bodyDir, { recursive: true });
  const journalPath = path.join(runDir, 'events.jsonl');
  const cooldownPath = path.join(runDir, 'cooldowns.json');
  const slots = new Map();
  const inFlight = new Set();
  const cooldowns = new Map();
  let context = null;
  const ownFlight = { active: 0, idle: [] };
  let bodySeq = 0;
  if (existsSync(bodyDir)) {
    for (const name of readdirSync(bodyDir)) {
      const prefix = Number.parseInt(name, 10);
      if (Number.isFinite(prefix)) bodySeq = Math.max(bodySeq, prefix);
    }
  }
  let ordinal = 0;
  const httpGate = createGate(maxInFlight);
  const modelGates = new Map();
  let fatal = null;

  if (existsSync(cooldownPath)) {
    const saved = JSON.parse(readFileSync(cooldownPath, 'utf8'));
    for (const [id, until] of Object.entries(saved)) cooldowns.set(id, until);
  }
  // POSTs this journal opened and closed, counted apart from the slot records
  // so a slot event cannot overwrite them.
  const reservedHere = new Map();
  const endedHere = new Map();
  for (const event of readJsonl(journalPath)) applyEvent(event);
  for (const [key, slot] of slots) {
    if (slot.state === 'running') slot.state = 'unknown';
    // Nothing is in flight while the journal loads, so an open POST was cut
    // off when an earlier runner stopped.
    slot.cutAttempts = cutCount(reservedHere.get(key), endedHere.get(key));
  }

  function applyEvent(event) {
    if (event.kind === 'cooldown') {
      cooldowns.set(event.model, event.until);
      return;
    }
    if (event.kind === 'http' && event.key) {
      if (event.phase === 'reserved') reservedHere.set(event.key, (reservedHere.get(event.key) || 0) + 1);
      if (event.phase === 'finished' || event.phase === 'error') endedHere.set(event.key, (endedHere.get(event.key) || 0) + 1);
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
    const data = JSON.stringify(Object.fromEntries(cooldowns));
    const tmp = `${cooldownPath}.tmp`;
    writeFileSync(tmp, data, 'utf8');
    try {
      renameSync(tmp, cooldownPath);
    } catch (error) {
      const code = error?.code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
      writeFileSync(cooldownPath, data, 'utf8');
    }
  }

  function flight() {
    const scoped = activeQuestion();
    if (scoped) {
      if (scoped.active == null) scoped.active = 0;
      if (!scoped.idle) scoped.idle = [];
      return scoped;
    }
    return ownFlight;
  }

  function currentContext() {
    const scoped = activeQuestion();
    if (scoped) return scoped.context;
    return context;
  }

  function enter() {
    const slot = flight();
    slot.active += 1;
    return slot;
  }

  function leave(slot) {
    slot.active -= 1;
    if (slot.active <= 0) {
      slot.active = 0;
      const waiters = slot.idle.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  function emit(message) {
    const worker = activeQuestion()?.worker;
    const head = worker == null ? '' : `w${worker} `;
    log(`${head}${message}`);
  }

  async function drain() {
    const slot = flight();
    if (slot.active === 0) return;
    await new Promise((resolve) => slot.idle.push(resolve));
  }

  function onHttp(event) {
    if (event.phase === 'finished' && event.text) {
      bodySeq += 1;
      const name = `${String(bodySeq).padStart(6, '0')}.txt`;
      const file = path.join(bodyDir, name);
      if (existsSync(file)) throw new EvalInvariantError(`Refusing to overwrite ${name}`);
      writeFileSync(file, event.text, { encoding: 'utf8', flag: 'wx' });
      event = { ...event, bodyFile: name, text: undefined };
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

  function reusedSource(model, messages, options, slotMeta) {
    if (!replayFrom || !aliasOf) return null;
    if ((slotMeta.attempt || 0) > 0) return null;
    const sourceModel = aliasOf(model);
    // The source journal keyed each slot on the request it actually sent, so
    // the lookup has to apply the same per-stage shaping before hashing.
    const sourceOptions = prepareOptions
      ? prepareOptions(sourceModel, slotMeta.stage, options || {})
      : options;
    const sourceRequest = canonicalCompletionRequest(sourceModel, messages, sourceOptions);
    const sourceHash = sha256(stableStringify(sourceRequest));
    const sourceKey = slotKey({ ...slotMeta, model: sourceModel, requestHash: sourceHash });
    const source = replayFrom.get(sourceKey);
    if (!source) return null;
    if (source.request && stableStringify(source.request) !== stableStringify(sourceRequest)) {
      throw new EvalInvariantError(`Replay source ${sourceKey} stores a different request under the same hash`);
    }
    const answered = source.state === 'completed' && source.result?.ok;
    if (!answered && !(replayTerminal && TERMINAL.has(source.state))) return null;
    return { sourceKey, source };
  }

  function modelGate(model) {
    const id = catalogueId(model);
    if (!modelGates.has(id)) modelGates.set(id, createGate(maxInFlightPerModel));
    return modelGates.get(id);
  }

  async function hook({ model, messages, options, execute }) {
    const flightSlot = enter();
    let key = null;
    let heldHttp = false;
    let heldModel = null;
    try {
      if (fatal || budget.state?.fatal) {
        throw new EvalInvariantError(fatal || budget.state.fatal);
      }
      const slotContext = currentContext();
      if (!slotContext) throw new Error('Logical call context is not set');
      const effective = prepareOptions
        ? prepareOptions(model, slotContext.stage, options || {})
        : (options || {});
      const request = canonicalCompletionRequest(model, messages, effective);
      const requestHash = sha256(stableStringify(request));
      const slotMeta = {
        questionId: slotContext.questionId,
        branch: slotContext.branch,
        stage: slotContext.stage,
        sample: slotContext.sample ?? 1,
        model,
        requestHash,
      };
      if ((slotContext.attempt || 0) > 0) slotMeta.attempt = slotContext.attempt;
      key = slotKey(slotMeta);
      const existing = slots.get(key);
      const cooling = cooldowns.get(catalogueId(model)) || 0;
      // With retryAfterCooldown a skip is never final: the call is asked again,
      // or skipped again with a fresh time while its route still cools. A stored
      // skip handed back as it was looked like an old skip whose cooldown had
      // ended, so the question went on without that call.
      const askAgain = retryAfterCooldown && existing?.state === 'skipped';
      const retrySkip = existing?.state === 'skipped' && (slotMeta.attempt || 0) > 0;
      if (existing && TERMINAL.has(existing.state) && !retrySkip && !askAgain) return existing.result;
      const reused = reusedSource(model, messages, options, slotMeta);
      if (reused) {
        writeSlot(key, {
          key,
          meta: slotMeta,
          request,
          state: reused.source.state || 'completed',
          result: reused.source.result,
          finishReason: reused.source.finishReason || null,
          incompleteHttp: reused.source.incompleteHttp === true,
          reusedFrom: reused.sourceKey,
          usage: reused.source.usage ?? reused.source.result?.usage ?? null,
          occupiedMs: reused.source.occupiedMs ?? null,
          sourceOrdinal: reused.source.completedOrdinal ?? null,
          httpAttempts: 0,
        });
        emit(`${slotMeta.branch} ${slotMeta.stage} ${slotMeta.model} sample ${slotMeta.sample}${attemptLabel(slotMeta)} reused`);
        return reused.source.result;
      }
      if (inFlight.has(key)) throw new Error(`Duplicate in-flight logical slot ${key}`);
      if (budget.state.paused) {
        throw new BudgetPaused(budget.state.pauseReason, budget.state.resumeAfter);
      }
      const attemptBudget = retryLimit ?? ENGINE_RETRY_LIMIT;
      // Attempts already spent on this exact request in a replay source count
      // against the same per-call limit. `raw` numbers every POST, so attempt
      // ids stay unique; refusals before generation and POSTs cut off by a
      // stopped runner do not count as spent, here or in the source.
      const raw = Math.max(existing?.httpAttempts || 0, priorAttempts?.get(key) || 0);
      const limitedBefore = Math.max(existing?.limitedAttempts || 0, priorFreeAttempts?.get(key) || 0);
      const cutBefore = existing?.cutAttempts || 0;
      const spent = Math.max(0, raw - limitedBefore - cutBefore);
      const remaining = attemptBudget - spent;
      // The attempt budget is checked before the cooldown. A call with no
      // attempt left is a failure now; checked the other way round, it came
      // back skipped on every pass and held its question forever.
      if (remaining <= 0) {
        const last = existing?.result && !existing.result.skipped ? existing.result : null;
        const exhausted = last || {
          ok: false,
          error: { message: 'Retry budget exhausted', kind: 'retries', last: existing?.result?.error || null },
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
          request,
          state: 'skipped',
          result: skipped,
          skippedAt: Date.now(),
        });
        return skipped;
      }
      inFlight.add(key);
      writeSlot(key, {
        ...(existing || {}),
        key,
        meta: slotMeta,
        request,
        state: 'running',
        result: null,
        httpAttempts: raw,
        limitedAttempts: limitedBefore,
      });
      const started = Date.now();
      let result;
      try {
        heldModel = modelGate(model);
        await heldModel.acquire();
        await httpGate.acquire();
        heldHttp = true;
        result = await attemptStore.run(
          { key, expected: request, httpSeq: raw },
          () => execute({ ...effective, maxRetries: remaining, retainRoster }),
        );
      } catch (error) {
        if (isEvalInvariant(error)) {
          fatal = error.message;
          budget.lockFatal?.(error.message);
          writeSlot(key, {
            ...slots.get(key),
            state: 'fatal',
            result: null,
            fatal: error.message,
          });
          throw error;
        }
        if (error instanceof BudgetPaused || budget.state.paused) {
          writeSlot(key, { ...slots.get(key), state: 'pending', result: null });
          throw error;
        }
        writeSlot(key, { ...slots.get(key), state: 'unknown', result: null });
        throw error;
      } finally {
        if (heldHttp) httpGate.release();
        if (heldModel) heldModel.release();
      }
      const current = slots.get(key) || {};
      // A refusal before generation that came from a POST of this call: the
      // slot waits for the route's cooldown, and the POST is not a model
      // attempt. An in-stream refusal sets the cooldown here; an upstream 429
      // already set it in the transport.
      if (isCapacityRefusal(result) && (current.httpAttempts || 0) > raw && !budget.state.paused) {
        if (!result.skipped) onCooldown(model, Date.now() + CAPACITY_COOLDOWN_MS);
        const refused = { ...result, skipped: true };
        writeSlot(key, {
          ...current,
          key,
          meta: slotMeta,
          request,
          state: 'skipped',
          result: refused,
          limitedAttempts: limitedBefore + 1,
          skippedAt: Date.now(),
          occupiedMs: Date.now() - started,
        });
        emit(`${slotMeta.branch} ${slotMeta.stage} ${slotMeta.model} sample ${slotMeta.sample}${attemptLabel(slotMeta)} refused for capacity; waits for the cooldown`);
        return refused;
      }
      const transportDrop = (isNetworkMessage(result?.error?.message) || isNetworkMessage(result?.error?.kind))
        && result?.error?.status == null;
      if (transportDrop) {
        // With every allowed attempt spent there is nothing left to retry, so
        // the drop is the slot's final outcome instead of an endless unknown.
        const exhausted = spentAttempts(current) >= attemptBudget;
        const dropState = exhausted ? 'failed' : 'unknown';
        writeSlot(key, {
          ...current,
          key,
          meta: slotMeta,
          request,
          state: dropState,
          result,
          occupiedMs: Date.now() - started,
        });
        if (!budget.state.paused) budget.pause('network', Date.now() + NETWORK_BACKOFF_MS);
        emit(`${slotMeta.branch} ${slotMeta.stage} ${slotMeta.model} sample ${slotMeta.sample}${attemptLabel(slotMeta)} ${dropState}`);
        return result;
      }
      if (budget.state.paused && !result?.ok) {
        writeSlot(key, { ...current, state: 'pending', result: null, occupiedMs: Date.now() - started });
        return result;
      }
      if (result && result.finishReason == null && current.finishReason) {
        result = { ...result, finishReason: current.finishReason };
      }
      // A POST that failed without an answer (a provider error, a stream the
      // provider closed early, a deadline) while the call still has an attempt
      // left. The engine does not retry these, so the slot is skipped with a
      // fresh time: its question waits and the next pass asks again. Only the
      // last allowed attempt can fail for good.
      if (
        retryAfterCooldown
        && result && !result.ok && !result.skipped
        && (current.httpAttempts || 0) > raw
        && spentAttempts(current) < attemptBudget
      ) {
        const retry = { ...result, ok: false, skipped: true, retryable: true };
        writeSlot(key, {
          ...current,
          key,
          meta: slotMeta,
          request,
          state: 'skipped',
          result: retry,
          skippedAt: Date.now(),
          finishReason: result.finishReason ?? current.finishReason ?? null,
          occupiedMs: Date.now() - started,
        });
        emit(`${slotMeta.branch} ${slotMeta.stage} ${slotMeta.model} sample ${slotMeta.sample}${attemptLabel(slotMeta)} failed (${result.error?.kind || result.error?.message || 'error'}); asked again on a later pass`);
        return retry;
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
        ...(state === 'skipped' ? { skippedAt: Date.now() } : {}),
        // A loop stop has no provider finish_reason; the engine names it.
        finishReason: result?.finishReason ?? current.finishReason ?? null,
        completedOrdinal: ordinal,
        occupiedMs: Date.now() - started,
        usageKnown: current.usageKnown === true,
      });
      emit(`${slotMeta.branch} ${slotMeta.stage} ${slotMeta.model} sample ${slotMeta.sample}${attemptLabel(slotMeta)} ${state}`);
      return result;
    } finally {
      if (key) inFlight.delete(key);
      leave(flightSlot);
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
      const scoped = activeQuestion();
      if (scoped) scoped.context = next;
      else context = next;
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
    get fatal() {
      return fatal;
    },
  };
}
