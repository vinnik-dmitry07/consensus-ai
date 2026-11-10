// finish-probe-v3: a new exploratory round on the same 115 cut texts, after the
// design faults that finish-probe-v2 described. Rules in
// finish-probe-v3-protocol.md. StepFun F goes first and is stopped early when
// it cannot pass; the other routes, the control, and labelling are paid only
// when it passes. Every number, bound, verdict, and the decision come from the
// code below. Labels and the analysis text come from OpenRouter models.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalCompletionRequest } from '../src/engine/browser/openrouter.js';
import { catalogueId } from '../src/engine/browser/roster.js';
import { settings } from '../src/engine/browser/settings.js';
import { gitState, reconcileBudget, sourceHash } from './a8.js';
import { comparePair } from './a8Report.js';
import { createCampaignBudget } from './budget.js';
import {
  SENSITIVITY_DROP, STAGE, STREAM_SECONDS,
  acceptFinish, audit, cellKey, finishMessage, inspectSource, loadSource, lock, mergeLabels,
  orderCells, policyArms, prepareProbe, probeRoutes, runCells, voteOf,
} from './finishProbe.js';
import {
  allPass, decideV3, evaluateBounded, isConfirmed, leaveOneOutBounded,
} from './finishProbeCriteria.js';
import {
  LABEL_EFFORT, LABEL_MAX_TOKENS, LABEL_MODELS, LABEL_INSTRUCTION, EXCERPT_NOTE, FULL_NOTE,
  LabelBudgetStop, labelSpend, openRouterPost, runLabelPass, stageIndex,
} from './finishProbeV2.js';
import { pinnedListed, routeUnavailable } from './finishProbeV2Report.js';
import { CHECKER, WRITER, poster, writeChecked } from './finishProbeAnalysis.js';
import { promptTokenCeiling, quoteReservation } from './paid.js';
import { replaceSection } from './report.js';
import { createSession, readSlotJournal } from './runtime.js';
import { installTransport, refusedBeforeGeneration } from './transport.js';
import { sha256 } from './util.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(EVAL_ROOT, '.runs');
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';

export const V3_RUN = 'finish-probe-v3';
export const SOURCE_RUN = 'a8-open-v5e';
export const V3_LIMITS = Object.freeze({ maxUsd: 10, maxPosts: 500 });
export const STEPFUN = 'stepfun/step-5-preview';
export const HY4 = 'tencent/hy4-preview';
export const DEEPSEEK = 'deepseek/deepseek-v4.1-flash-1017';
export const COUNCIL = Object.freeze([STEPFUN, HY4, DEEPSEEK]);
// StepFun gets a quarter of its original 32768; the other routes keep 2048.
export const V3_CAPS = Object.freeze({ [STEPFUN]: 8192, [HY4]: 2048, [DEEPSEEK]: 2048 });
export const V3_ORDER_SEED = 'finish-probe-v3-order';
export const V3_CONDITIONS = Object.freeze(['F', 'C']);
export const BATCH = 6;
// A refusal before generation is asked again after its cooldown, up to three
// POSTs per cell; the count lives in the slot journal and survives a restart.
export const REFUSAL_LIMIT = 3;
// 80 - 9 < 72: after nine confirmed failures StepFun can no longer pass.
export const STAGE1 = Object.freeze({ model: STEPFUN, n: 80, need: 72, stopAt: 9 });
export const REQUIRED_PARAMETERS = Object.freeze(['max_tokens', 'temperature', 'top_p', 'reasoning']);
export const PROBE = Object.freeze({ maxPosts: 3, maxTokens: 16, prompt: 'Reply with one word: ready.' });
export const MAX_WAIT_MS = 45 * 60_000;
export const ARMS = Object.freeze(['B8', 'P8', 'V5', 'A8', 'S8']);
export const LABEL_TEXTS = 64;
const PROTOCOL_V3 = 'finish-probe-v3-protocol.md';
const LABELS_V2 = 'finish-probe-v2-labels.json';
export const LABELS_V3 = 'finish-probe-v3-labels.json';
const SUBSET_FILE = 'finish-probe-subset.json';
const GOLD_FILE = 'gold-corrections-a8-open-v5e.json';
// Frozen with the first live phase. The v3 labels and the run folder are not.
export const V3_FILES = Object.freeze([
  'finishProbeV3.js', 'finishProbeV3.test.js', PROTOCOL_V3, 'finishProbeCriteria.js', 'finishProbeCli.js',
  'finishProbe.js', 'finishProbeV2.js', 'finishProbeV2Report.js', 'finishProbeAnalysis.js',
  'finish-probe-protocol.md', 'finish-probe-v2-protocol.md', 'finish-probe-v2-addendum.md',
  SUBSET_FILE, LABELS_V2, GOLD_FILE,
]);
const README = path.join(EVAL_ROOT, 'README.md');
export const README_START = '<!-- finish-probe-v3:start -->';
export const README_END = '<!-- finish-probe-v3:end -->';
export const ANALYSIS_START = '<!-- finish-probe-v3-analysis:start -->';
export const ANALYSIS_END = '<!-- finish-probe-v3-analysis:end -->';
const AFTER_V2 = '<!-- finish-probe-v2-analysis:end -->';

// Small helpers.

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function appendJsonl(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function fileSha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : (argv[index + 1] ?? null);
}

function paidKey() {
  const key = String(process.env.or_key || process.env.OR_KEY || '').trim();
  if (!key) throw new Error('or_key is missing');
  return key;
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function v3Paths(root = RUNS_ROOT) {
  const dir = path.join(root, V3_RUN);
  const v1 = path.join(RUNS_ROOT, 'finish-probe-v1');
  const v2 = path.join(RUNS_ROOT, 'finish-probe-v2');
  return {
    dir,
    budget: path.join(dir, 'budget.jsonl'),
    manifest: path.join(dir, 'manifest.json'),
    inspect: path.join(dir, 'inspect.json'),
    route: path.join(dir, 'route.json'),
    stops: path.join(dir, 'stops.jsonl'),
    main: path.join(dir, 'main'),
    events: path.join(dir, 'main', 'events.jsonl'),
    labels: path.join(dir, 'labels'),
    analysis: path.join(dir, 'analysis'),
    report: path.join(dir, 'report.json'),
    reportMd: path.join(dir, 'report.md'),
    readme: path.join(dir, 'readme-block.md'),
    v1: {
      main: path.join(v1, 'main', 'events.jsonl'),
      budget: path.join(v1, 'budget.jsonl'),
      settings: path.join(v1, 'settings.json'),
      manifest: path.join(v1, 'manifest.json'),
      round1: path.join(v1, 'pilot', 'round1', 'events.jsonl'),
      round2: path.join(v1, 'pilot', 'round2', 'events.jsonl'),
    },
    v2: {
      main: path.join(v2, 'main', 'events.jsonl'),
      budget: path.join(v2, 'budget.jsonl'),
      manifest: path.join(v2, 'manifest.json'),
      labels: path.join(v2, 'labels', 'calls.jsonl'),
    },
  };
}

function journalIndex(file) {
  return existsSync(file) ? stageIndex([...readSlotJournal(file).values()]) : new Map();
}

// Cells.

export function allCells(sources, seed = V3_ORDER_SEED) {
  return orderCells(sources, seed, V3_CONDITIONS);
}

// Stage 1: StepFun F. Stage 2: StepFun C, and hy4 and DeepSeek with F and C of
// one text next to each other. Stage 3: F on the cut syntheses.
export function stageCells(stage, sources, seed = V3_ORDER_SEED) {
  const inputs = sources.filter((item) => item.kind === 'input');
  if (stage === 1) return orderCells(inputs.filter((item) => item.model === STAGE1.model), seed, ['F']);
  if (stage === 2) return orderCells(inputs, seed, V3_CONDITIONS).filter((cell) => !(cell.model === STAGE1.model && cell.condition === 'F'));
  if (stage === 3) return orderCells(sources.filter((item) => item.kind === 'synthesis'), seed, ['F']);
  throw new Error(`Unknown stage ${stage}`);
}

// The provider object of the hy4 route chosen by the route phase.
export function providerOf(route, chosen) {
  if (chosen.pinnedRoute) return { ...route.provider };
  return { order: [chosen.tag], allow_fallbacks: false, max_price: route.provider.max_price };
}

export function v3Routes(selectionRoutes, routeRecord) {
  return COUNCIL.map((id) => {
    const route = selectionRoutes.find((item) => item.id === id);
    if (!route) throw new Error(`Route ${id} is not in the campaign selection`);
    if (id !== HY4 || !routeRecord?.chosen) return route;
    return { ...route, provider: providerOf(route, routeRecord.chosen) };
  });
}

// Cell states.

function generated(slot) {
  return Number(slot?.usage?.completion_tokens) > 0
    || Boolean(String(slot?.result?.content || '').trim())
    || slot?.finishReason != null;
}

// accepted, rejected (a generation came back without an accepted answer),
// unmeasured (refused before generation, refusals used up, or no route),
// unknown (a POST without an outcome), pending (not sent, or refused and
// waiting for its cooldown).
export function v3StateOf(slot, limit = REFUSAL_LIMIT) {
  if (!slot) return { v3: 'pending', reason: 'not_sent' };
  if (slot.state === 'completed') return { v3: 'completed', reason: null };
  if ((slot.cutAttempts || 0) > 0) return { v3: 'unknown', reason: 'cut_post' };
  if (slot.state === 'failed') {
    const kind = slot.result?.error?.kind;
    if (routeUnavailable(slot)) return { v3: 'unmeasured', reason: 'route_unavailable' };
    if (kind === 'total' || kind === 'idle') return { v3: 'rejected', reason: 'deadline' };
    if (kind === 'first-response' || kind === 'aborted') return { v3: 'unknown', reason: 'no_response' };
    if (slot.httpStatus == null && !slot.responseSeen) return { v3: 'unknown', reason: 'no_response' };
    if (slot.incompleteHttp) return { v3: 'unknown', reason: 'incomplete_stream' };
    if (generated(slot)) return { v3: 'rejected', reason: 'failed' };
    return { v3: 'unmeasured', reason: 'refused_before_generation' };
  }
  if (slot.state === 'skipped') {
    return (slot.limitedAttempts || 0) >= limit
      ? { v3: 'unmeasured', reason: 'refusals_used_up' }
      : { v3: 'pending', reason: 'refused_waiting' };
  }
  if (slot.state === 'pending') return { v3: 'pending', reason: 'not_sent' };
  return { v3: 'unknown', reason: slot.state || 'unknown' };
}

// One outcome per cell. `state` keeps the v1 vocabulary for code that reads it.
export function outcomeOf(task, slot) {
  const stats = {
    promptTokens: slot?.usage?.prompt_tokens ?? null,
    completionTokens: slot?.usage?.completion_tokens ?? null,
    cost: Number.isFinite(slot?.usage?.cost) ? slot.usage.cost : null,
    serviceMs: slot?.serviceMs ?? null,
    posts: slot?.httpAttempts || 0,
    refusals: slot?.limitedAttempts || 0,
  };
  const state = v3StateOf(slot);
  if (state.v3 === 'completed') {
    const read = acceptFinish(task, slot);
    return {
      ...stats, v3: read.accepted ? 'accepted' : 'rejected', state: 'done', accepted: read.accepted,
      extracted: read.extracted, correct: read.correct, reason: read.reason, finishReason: read.finishReason ?? null,
    };
  }
  if (state.v3 === 'rejected') {
    return { ...stats, v3: 'rejected', state: 'done', accepted: false, extracted: null, correct: 0, reason: state.reason, finishReason: slot?.finishReason ?? null };
  }
  return { ...stats, v3: state.v3, state: state.v3 === 'unknown' ? 'unknown' : 'pending', accepted: false, extracted: null, correct: 0, reason: state.reason, finishReason: null };
}

export function outcomesFor(cells, tasks, index) {
  const out = new Map();
  for (const cell of cells) out.set(cell.id, outcomeOf(tasks.get(cell.questionId), index.get(cellKey(cell))));
  return out;
}

export function countStates(cells, outcome) {
  const counts = { n: cells.length, accepted: 0, rejected: 0, unknown: 0, unmeasured: 0, pending: 0 };
  for (const cell of cells) counts[outcome(cell.id)?.v3 || 'pending'] += 1;
  return counts;
}

// Stage 1 after each batch: fail at nine confirmed failures; insufficient when
// a pass can no longer be confirmed; pass when nothing is pending and 72 hold.
export function stage1Status(counts, rule = STAGE1) {
  if (counts.rejected >= rule.stopAt) return { ...counts, status: 'fail' };
  if (counts.accepted + counts.pending < rule.need) return { ...counts, status: 'insufficient' };
  if (counts.pending === 0) return { ...counts, status: 'pass' };
  return { ...counts, status: 'running' };
}

// Sends `cells` in batches of at most `batch`. Only a pending cell is sent;
// a cell whose route cools waits. Before each batch `stop(index)` may end the
// stage. A route that answers 404 "No endpoints found" is not asked again in
// this launch. Returns why the stage ended.
export async function runStage({
  cells, tasks, session, stop = () => null, blocked = new Set(), batch = BATCH,
  sleep = sleepFor, maxWaitMs = MAX_WAIT_MS, log = () => {},
}) {
  const closed = new Set(blocked);
  let waited = 0;
  let idle = 0;
  for (let round = 1; ; round += 1) {
    const index = stageIndex(session.slots());
    const halt = stop(index);
    if (halt) return { end: halt, blocked: [...closed] };
    const { budget } = session;
    if (budget.state.paused) {
      if (!budget.isTransientPause()) return { end: budget.state.pauseReason === 'budget_blocked' ? 'budget' : `paused:${budget.state.pauseReason}`, blocked: [...closed] };
      const ms = Math.max(5_000, (budget.state.resumeAfter ?? Date.now()) - Date.now());
      if (waited + ms > maxWaitMs) return { end: 'waiting', blocked: [...closed] };
      await sleep(ms);
      waited += ms;
      budget.resumeTransient();
      continue;
    }
    const pending = cells.filter((cell) => v3StateOf(index.get(cellKey(cell))).v3 === 'pending');
    if (!pending.length) return { end: 'done', blocked: [...closed] };
    const open = pending.filter((cell) => !closed.has(cell.model));
    if (!open.length) return { end: 'route_unavailable', blocked: [...closed] };
    const now = Date.now();
    const until = (model) => session.cooldowns.get(catalogueId(model)) || 0;
    const ready = open.filter((cell) => until(cell.model) <= now).slice(0, batch);
    if (!ready.length) {
      const ms = Math.max(1_000, Math.min(...open.map((cell) => until(cell.model))) - now + 1_000);
      if (waited + ms > maxWaitMs) return { end: 'waiting', blocked: [...closed] };
      await sleep(ms);
      waited += ms;
      continue;
    }
    const before = session.slots().reduce((sum, slot) => sum + (slot.httpAttempts || 0), 0);
    await runCells({ cells: ready, tasks, session, concurrency: ready.length });
    const after = stageIndex(session.slots());
    for (const cell of ready) if (routeUnavailable(after.get(cellKey(cell)))) closed.add(cell.model);
    const posts = session.slots().reduce((sum, slot) => sum + (slot.httpAttempts || 0), 0) - before;
    idle = posts > 0 ? 0 : idle + 1;
    if (idle >= 3) return { end: 'stuck', blocked: [...closed] };
    log(round, ready, after);
  }
}

// The hy4 route.

const PRECISION = Object.freeze({ fp32: 32, bf16: 16, fp16: 16, fp8: 8, int8: 8, fp6: 6, fp4: 4, int4: 4 });

export function precisionRank(quantization) {
  return PRECISION[String(quantization || '').toLowerCase()] ?? -1;
}

function priceList(pricing) {
  return [pricing, ...(pricing?.overrides || [])].filter(Boolean);
}

// Why an endpoint cannot carry the cells; empty when it can.
export function endpointProblems(endpoint, { route, needPrompt, cap }) {
  const problems = [];
  const params = endpoint.supported_parameters || [];
  const missing = REQUIRED_PARAMETERS.filter((name) => !params.includes(name));
  if (missing.length) problems.push(`parameters: ${missing.join(', ')}`);
  if (!(Number(endpoint.context_length) >= needPrompt + cap)) problems.push('context');
  if (endpoint.max_completion_tokens != null && Number(endpoint.max_completion_tokens) < cap) problems.push('max completion');
  if (endpoint.max_prompt_tokens != null && Number(endpoint.max_prompt_tokens) < needPrompt) problems.push('max prompt');
  const over = priceList(endpoint.pricing).some((price) => Number(price.prompt) > Number(route.pricing.prompt) || Number(price.completion) > Number(route.pricing.completion));
  if (over || !endpoint.pricing) problems.push('price');
  return problems;
}

// The pinned provider when it is listed and fits; otherwise every fitting
// endpoint by declared precision, then tag. Unknown precision goes last.
export function routeCandidates(endpoints, route, needs) {
  const rows = endpoints.map((endpoint) => ({
    tag: endpoint.tag ?? null,
    providerName: endpoint.provider_name ?? null,
    quantization: endpoint.quantization ?? null,
    context: endpoint.context_length ?? null,
    maxCompletion: endpoint.max_completion_tokens ?? null,
    pricing: endpoint.pricing ?? null,
    pinned: pinnedListed(route, [endpoint]),
    problems: endpointProblems(endpoint, { route, ...needs }),
  }));
  const fit = rows.filter((row) => !row.problems.length);
  const pinned = fit.filter((row) => row.pinned).map((row) => ({ ...row, pinnedRoute: true }));
  const others = fit
    .filter((row) => !row.pinned)
    .sort((left, right) => precisionRank(right.quantization) - precisionRank(left.quantization) || String(left.tag).localeCompare(String(right.tag)))
    .map((row) => ({ ...row, pinnedRoute: false }));
  return { rows, pinnedListed: rows.some((row) => row.pinned), candidates: [...pinned.slice(0, 1), ...others] };
}

export function probeBody(route, candidate, reasoning) {
  return {
    model: route.id,
    messages: [{ role: 'user', content: PROBE.prompt }],
    max_tokens: PROBE.maxTokens,
    temperature: route.temperature,
    top_p: route.topP,
    reasoning,
    provider: { ...providerOf(route, candidate), require_parameters: true },
    stream: false,
    usage: { include: true },
  };
}

// Any answer with a generation will do, a cut one included.
export function probeGenerated(status, json) {
  const choice = json?.choices?.[0];
  if (status !== 200 || json?.error || !choice) return false;
  return Number(json?.usage?.completion_tokens) > 0 || Boolean(choice.message?.content) || choice.finish_reason != null;
}

export class V3BudgetStop extends Error {}

const PRE_PROVIDER = new Set([400, 401, 402, 403, 404, 429]);

// A fetch for the calls outside the measurement session (route probes, labels,
// analysis). Each POST is reserved in the one v3 budget at its worst case and
// settled with the cost OpenRouter reports. A refusal before any provider is
// released; any other POST without a cost stays held.
export function budgetedFetch({ budget, prefix, stamp, fetchImpl = fetch }) {
  let seq = 0;
  return async (url, init = {}) => {
    const body = JSON.parse(init.body || '{}');
    seq += 1;
    const attemptId = `${prefix}|${body.model}|${stamp}|${seq}`;
    let decision;
    for (;;) {
      decision = budget.admit({ attemptId, model: body.model, promptTokens: promptTokenCeiling(body.messages), maxTokens: Number(body.max_tokens) });
      if (decision.ok || decision.reason !== 'wait') break;
      await budget.waitForChange();
    }
    if (!decision.ok) throw new V3BudgetStop(decision.reason || 'budget');
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      budget.settle({ attemptId, incomplete: true });
      throw error;
    }
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const cost = json?.usage?.cost;
    if (cost != null && Number.isFinite(Number(cost))) budget.settle({ attemptId, usage: { cost: Number(cost) } });
    else if (!response.ok && (PRE_PROVIDER.has(response.status) || refusedBeforeGeneration(response.status, text))) budget.settle({ attemptId, usage: { cost: 0 } });
    else budget.settle({ attemptId, incomplete: true });
    return new Response(text, { status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/json' } });
  };
}

// Freeze.

function shaOrMissing(name) {
  const file = path.join(EVAL_ROOT, name);
  return existsSync(file) ? fileSha(file) : 'missing';
}

function filesHash(names) {
  return sha256(names.map((name) => `${name}\n${shaOrMissing(name)}`).join('\n'));
}

function hashesOf(files) {
  return Object.fromEntries(Object.entries(files).filter(([, file]) => existsSync(file)).map(([name, file]) => [name, fileSha(file)]));
}

function priorHashes(paths) {
  const { round1, round2, ...v1 } = paths.v1;
  return { v1: hashesOf({ ...v1, round1, round2 }), v2: hashesOf(paths.v2) };
}

export function orderDigest(sources) {
  return sha256([1, 2, 3].map((stage) => stageCells(stage, sources).map((cell) => cell.id).join('\n')).join('\n--\n'));
}

function changedKeys(left, right) {
  return [...new Set([...Object.keys(left || {}), ...Object.keys(right || {})])].filter((key) => left?.[key] !== right?.[key]);
}

function checkedSource(source, paths) {
  const inspect = inspectSource(source, SOURCE_RUN);
  if (inspect.mismatches.length) throw new Error(`Baselines differ: ${inspect.mismatches.join(', ')}`);
  const v1Manifest = readJson(paths.v1.manifest);
  if (inspect.sourceDigest !== v1Manifest?.frozen?.sourceDigest) throw new Error('The cut texts differ from those v1 froze.');
  const changed = changedKeys(inspect.sourceHashes, v1Manifest.frozen.sourceHashes);
  if (changed.length) throw new Error(`Source files changed since the v1 freeze: ${changed.join(', ')}`);
  return inspect;
}

function frozenNow(paths, source) {
  const inspect = checkedSource(source, paths);
  return {
    codeHash: filesHash(V3_FILES),
    files: Object.fromEntries(V3_FILES.map((name) => [name, shaOrMissing(name)])),
    sourceDigest: inspect.sourceDigest,
    sourceHashes: inspect.sourceHashes,
    orderDigest: orderDigest(source.sources),
    prior: priorHashes(paths),
  };
}

// Written by the first live phase, before its first POST, and never rewritten.
export function freezeV3(paths, source) {
  const git = gitState(V3_FILES, EVAL_ROOT);
  if (git.error || git.dirty == null) throw new Error(`Cannot read git state: ${git.error}`);
  if (git.dirty.length) throw new Error(`Commit these files first: ${git.dirty.join(', ')}`);
  const absent = V3_FILES.filter((name) => !existsSync(path.join(EVAL_ROOT, name)));
  if (absent.length) throw new Error(`Missing files: ${absent.join(', ')}`);
  const current = frozenNow(paths, source);
  const manifest = readJson(paths.manifest);
  if (manifest?.frozen) {
    if (manifest.frozen.codeHash !== current.codeHash) throw new Error('The v3 files changed since the freeze.');
    for (const key of ['sourceDigest', 'orderDigest']) if (manifest.frozen[key] !== current[key]) throw new Error(`The ${key} changed since the freeze.`);
    for (const run of ['v1', 'v2']) {
      const moved = changedKeys(current.prior[run], manifest.frozen.prior[run]);
      if (moved.length) throw new Error(`${run} files changed since the v3 freeze: ${moved.join(', ')}`);
    }
    return manifest;
  }
  const v1Settings = readJson(paths.v1.settings);
  const next = {
    run: V3_RUN,
    sourceRun: SOURCE_RUN,
    frozen: { ...current, gitHead: git.head, frozenAt: new Date().toISOString(), methodSourceHash: sourceHash() },
    limits: V3_LIMITS,
    caps: V3_CAPS,
    reasoning: v1Settings.reasoning,
    orderSeed: V3_ORDER_SEED,
    batch: BATCH,
    refusalLimit: REFUSAL_LIMIT,
    stage1: STAGE1,
    streamSeconds: STREAM_SECONDS,
    labelModels: LABEL_MODELS,
    analysisModels: { writer: WRITER, checker: CHECKER },
    sensitivityDrop: SENSITIVITY_DROP,
  };
  writeJson(paths.manifest, next);
  return next;
}

// Budget and sessions.

function openBudget(file, prices) {
  mkdirSync(path.dirname(file), { recursive: true });
  const budget = createCampaignBudget({
    ...V3_LIMITS,
    prices,
    onEvent: (event) => appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8'),
  });
  budget.applyJournal(readJsonl(file));
  return budget;
}

function routePrices(routes) {
  return Object.fromEntries(routes.map((route) => [route.id, route.pricing]));
}

async function withMeasurement({ paths, routes, routeMap, phase }, work) {
  settings.apiKey = paidKey();
  const budget = openBudget(paths.budget, routePrices(routes));
  if (budget.unresolvedAttempts().length) {
    try {
      await reconcileBudget({ dir: paths.dir }, budget, { journals: existsSync(paths.events) ? [paths.events] : [] });
    } catch (error) {
      console.log(`reconcile skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await audit(budget, phase, 'start');
  const session = createSession({
    runDir: paths.main,
    budget,
    prepareOptions: prepareProbe(routeMap, (model) => V3_CAPS[model]),
    maxInFlight: BATCH,
    maxInFlightPerModel: BATCH,
    retainRoster: true,
    retryAfterCooldown: true,
    retryLimit: 1,
  });
  session.install();
  const restore = installTransport({
    allowModels: new Set(routes.map((route) => route.id)),
    allowPaid: true,
    rejectFree: true,
    budget,
    onHttp: session.onHttp,
    onCooldown: session.onCooldown,
  });
  try {
    return await work(session, budget);
  } finally {
    session.uninstall();
    restore();
    await audit(budget, phase, 'end');
    console.log(`v3 budget: settled $${budget.state.settledUsd.toFixed(4)}, held $${budget.state.unresolvedUsd.toFixed(4)}, ${budget.state.posts} POSTs`);
  }
}

async function endpointsOf(model) {
  try {
    const response = await fetch(`${MODELS_URL}/${model}/endpoints`);
    const body = await response.json().catch(() => null);
    return { status: response.status, endpoints: body?.data?.endpoints || [] };
  } catch (error) {
    return { status: null, endpoints: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function largestPrompt(source, model) {
  return Math.max(0, ...source.sources.filter((item) => item.model === model).map((item) => (
    promptTokenCeiling([{ role: 'user', content: finishMessage(source.tasks.get(item.questionId), 'F', item.text) }])
  )));
}

// Route phase: the hy4 endpoint is chosen and recorded before any measured call.
async function runRoute(paths, source) {
  if (existsSync(paths.route)) {
    console.log(`route already recorded: ${readFileSync(paths.route, 'utf8')}`);
    return 0;
  }
  const selection = source.selection.routes;
  const routeMap = probeRoutes(v3Routes(selection, null));
  const checks = {};
  for (const id of COUNCIL) {
    const route = selection.find((item) => item.id === id);
    const listing = await endpointsOf(id);
    const needs = { needPrompt: largestPrompt(source, id), cap: V3_CAPS[id] };
    const found = routeCandidates(listing.endpoints, route, needs);
    checks[id] = { status: listing.status, error: listing.error ?? null, ...needs, pinned: { tag: route.tag, providerName: route.providerName }, ...found };
  }
  const route = selection.find((item) => item.id === HY4);
  const { candidates } = checks[HY4];
  const budget = openBudget(paths.budget, { [HY4]: route.pricing });
  settings.apiKey = paidKey();
  await audit(budget, 'route', 'start');
  const key = paidKey();
  const send = budgetedFetch({ budget, prefix: 'route-probe', stamp: Date.now() });
  const probes = [];
  let chosen = null;
  for (const candidate of candidates) {
    if (probes.length >= PROBE.maxPosts) break;
    const body = probeBody(route, candidate, routeMap[HY4].reasoning);
    const row = { tag: candidate.tag, pinnedRoute: candidate.pinnedRoute, at: new Date().toISOString(), status: null, ok: false };
    try {
      const response = await send(CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'llm-council eval route probe' },
        body: JSON.stringify(body),
      });
      const json = await response.json().catch(() => null);
      Object.assign(row, {
        status: response.status,
        ok: probeGenerated(response.status, json),
        finishReason: json?.choices?.[0]?.finish_reason ?? null,
        completionTokens: json?.usage?.completion_tokens ?? null,
        cost: json?.usage?.cost ?? null,
        provider: json?.provider ?? null,
        error: json?.error?.message ?? null,
      });
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      if (error instanceof V3BudgetStop) {
        probes.push(row);
        break;
      }
    }
    probes.push(row);
    if (row.ok) {
      chosen = candidate;
      break;
    }
  }
  await audit(budget, 'route', 'end');
  const record = {
    at: new Date().toISOString(),
    model: HY4,
    rule: 'pinned provider when listed and fitting; otherwise fitting endpoints by declared precision, then tag; unknown precision last; at most three probe POSTs',
    checks,
    probes,
    chosen: chosen ? { ...chosen } : null,
    provider: chosen ? { ...providerOf(route, chosen), require_parameters: true } : null,
  };
  writeJson(paths.route, record);
  console.log(JSON.stringify({ chosen: record.chosen?.tag ?? null, pinnedListed: checks[HY4].pinnedListed, probes }, null, 2));
  return chosen ? 0 : 6;
}

// Which routes may be asked in this launch: the expected endpoint is listed.
async function listedRoutes(routes, routeRecord) {
  const out = {};
  for (const route of routes) {
    if (route.id === HY4 && !routeRecord?.chosen) {
      out[route.id] = { listed: false, reason: 'no hy4 route was found' };
      continue;
    }
    const substitute = route.id === HY4 && !routeRecord.chosen.pinnedRoute;
    const tag = substitute ? routeRecord.chosen.tag : route.tag;
    // The route phase checked that the pinned endpoint allows the cap, the
    // payload, the parameters, and the price.
    const recorded = route.id === HY4 ? null : routeRecord.checks?.[route.id]?.rows?.find((row) => row.pinned);
    if (route.id !== HY4 && !recorded) {
      out[route.id] = { listed: false, tag, reason: `endpoint ${tag} was not listed at the route phase` };
      continue;
    }
    if (recorded?.problems?.length) {
      out[route.id] = { listed: false, tag, reason: `endpoint ${tag}: ${recorded.problems.join('; ')}` };
      continue;
    }
    const listing = await endpointsOf(route.id);
    const listed = listing.status === 200 && (substitute
      ? listing.endpoints.some((endpoint) => String(endpoint.tag || '').toLowerCase() === String(tag).toLowerCase())
      : pinnedListed(route, listing.endpoints));
    out[route.id] = { listed, tag, status: listing.status, reason: listed ? null : `endpoint ${tag} is not listed` };
  }
  return out;
}

function noteStop(paths, row) {
  appendJsonl(paths.stops, { at: new Date().toISOString(), ...row });
}

function logBatch(stage, cells, tasks) {
  return (round, ready, index) => {
    const outcome = outcomesFor(cells, tasks, index);
    const counts = countStates(cells, (id) => outcome.get(id));
    console.log(`stage ${stage} batch ${round} (${ready.length} cells): ${JSON.stringify(counts)}`);
  };
}

export function labelsOf(file) {
  const data = readJson(file);
  return {
    groups: new Map((data?.items || []).map((item) => [item.cell, item.group])),
    agreed: new Map((data?.items || []).filter((item) => item.agreedAccepted != null).map((item) => [item.cell, item.agreedAccepted])),
    data,
  };
}

export function mainCriteria(source, outcomes, labels) {
  const inputs = source.sources.filter((item) => item.kind === 'input');
  return evaluateBounded({ inputs, outcome: (id) => outcomes.get(id), labels, models: COUNCIL });
}

async function runRun(paths, source, manifest) {
  const routeRecord = readJson(paths.route);
  if (!routeRecord) throw new Error('Run the route phase first.');
  const routes = v3Routes(source.selection.routes, routeRecord);
  const routeMap = probeRoutes(routes);
  for (const model of COUNCIL) {
    if (JSON.stringify(routeMap[model].reasoning) !== JSON.stringify(manifest.reasoning[model])) throw new Error(`The effort of ${model} differs from v1 and v2.`);
  }
  const { tasks } = source;
  const listed = await listedRoutes(routes, routeRecord);
  const blocked = new Set(Object.entries(listed).filter(([, row]) => !row.listed).map(([model]) => model));
  for (const model of blocked) noteStop(paths, { kind: 'route', model, reason: listed[model].reason });
  const labels = labelsOf(path.join(EVAL_ROOT, LABELS_V2)).groups;
  return withMeasurement({ paths, routes, routeMap, phase: 'run' }, async (session) => {
    const index = () => stageIndex(session.slots());
    const s1Cells = stageCells(1, source.sources);
    const s1 = () => {
      const outcome = outcomesFor(s1Cells, tasks, index());
      return stage1Status(countStates(s1Cells, (id) => outcome.get(id)));
    };
    let status = s1();
    if (status.status === 'running') {
      const out = await runStage({
        cells: s1Cells, tasks, session, blocked,
        stop: () => (['fail', 'insufficient'].includes(s1().status) ? s1().status : null),
        log: logBatch(1, s1Cells, tasks),
      });
      status = s1();
      console.log(`stage 1 ended (${out.end}): ${JSON.stringify(status)}`);
      if (status.status === 'running') {
        noteStop(paths, { kind: 'stage', stage: 1, end: out.end, blocked: out.blocked });
        if (out.end === 'budget') return 5;
        return out.end === 'route_unavailable' ? 6 : 2;
      }
    }
    if (status.status !== 'pass') {
      noteStop(paths, { kind: 'stage', stage: 1, end: status.status, counts: status });
      console.log(`stage 1: ${status.status}. Stages 2 and 3 are not sent.`);
      return 3;
    }
    const s2Cells = stageCells(2, source.sources);
    const out2 = await runStage({ cells: s2Cells, tasks, session, blocked, log: logBatch(2, s2Cells, tasks) });
    const left2 = s2Cells.filter((cell) => v3StateOf(index().get(cellKey(cell))).v3 === 'pending').length;
    console.log(`stage 2 ended (${out2.end}); ${left2} cells pending`);
    if (left2) {
      noteStop(paths, { kind: 'stage', stage: 2, end: out2.end, pending: left2, blocked: out2.blocked });
      if (out2.end === 'budget') return 5;
      return out2.end === 'route_unavailable' ? 6 : 2;
    }
    const criteria = mainCriteria(source, outcomesFor(allCells(source.sources), tasks, index()), labels);
    if (!allPass(criteria)) {
      const verdicts = { c1: criteria.c1.verdict, c2: criteria.c2.verdict, c3: criteria.c3.verdict, c4: criteria.c4.verdict };
      noteStop(paths, { kind: 'gate', stage: 3, verdicts });
      console.log(`stage 3 is not sent: criteria ${JSON.stringify(verdicts)}`);
      return 4;
    }
    const s3Cells = stageCells(3, source.sources);
    const out3 = await runStage({ cells: s3Cells, tasks, session, blocked, log: logBatch(3, s3Cells, tasks) });
    const left3 = s3Cells.filter((cell) => v3StateOf(index().get(cellKey(cell))).v3 === 'pending').length;
    console.log(`stage 3 ended (${out3.end}); ${left3} cells pending`);
    if (left3) {
      noteStop(paths, { kind: 'stage', stage: 3, end: out3.end, pending: left3, blocked: out3.blocked });
      return out3.end === 'budget' ? 5 : 2;
    }
    return 0;
  });
}

// Labels for the 64 texts outside the frozen 51: the models, instruction, and
// excerpts of v2, without golds or arms. Shown only.

async function modelPrices(ids) {
  const response = await fetch(MODELS_URL);
  const body = await response.json();
  const out = {};
  for (const id of ids) {
    const row = body.data.find((item) => item.id === id);
    if (!row) throw new Error(`${id} is not in the OpenRouter catalogue`);
    out[id] = row.pricing;
  }
  return out;
}

export function labelEstimate(v2Events, texts = LABEL_TEXTS) {
  const spend = labelSpend(v2Events);
  const labelled = new Set(v2Events.filter((event) => event.kind === 'label').map((event) => `${event.pass}|${event.cell}`)).size;
  const perTextPass = labelled ? (spend.knownUsd + spend.worstUnknownUsd) / labelled : null;
  return { perTextPass, usd: perTextPass == null ? null : perTextPass * texts * 2, posts: texts * 2 };
}

async function runLabels(paths, source) {
  const outcomes = outcomesFor(allCells(source.sources), source.tasks, journalIndex(paths.events));
  const criteria = mainCriteria(source, outcomes, labelsOf(path.join(EVAL_ROOT, LABELS_V2)).groups);
  const s3 = stageCells(3, source.sources).filter((cell) => outcomes.get(cell.id)?.v3 === 'pending').length;
  if (!allPass(criteria) || s3) {
    console.log(`labels are not sent: criteria all pass ${allPass(criteria)}, pending syntheses ${s3}`);
    return 4;
  }
  const subset = new Set(readJson(path.join(EVAL_ROOT, SUBSET_FILE)));
  const items = source.sources.filter((item) => item.kind === 'input' && !subset.has(item.id));
  if (items.length !== LABEL_TEXTS) throw new Error(`Expected ${LABEL_TEXTS} unlabelled texts, found ${items.length}`);
  const prices = await modelPrices(Object.values(LABEL_MODELS));
  const budget = openBudget(paths.budget, prices);
  const estimate = labelEstimate(readJsonl(paths.v2.labels));
  const room = V3_LIMITS.maxUsd - budget.state.settledUsd - budget.state.unresolvedUsd;
  const postsLeft = V3_LIMITS.maxPosts - budget.state.posts;
  const file = path.join(paths.labels, 'calls.jsonl');
  const journal = (event) => appendJsonl(file, event);
  if (!existsSync(file) && (estimate.usd == null || estimate.usd > room || estimate.posts > postsLeft)) {
    writeJson(path.join(paths.labels, 'skipped.json'), { estimate, roomUsd: room, postsLeft });
    console.log(`labels do not fit: estimate ${JSON.stringify(estimate)}, room $${room.toFixed(4)}, ${postsLeft} POSTs`);
    return 0;
  }
  const key = paidKey();
  settings.apiKey = key;
  await audit(budget, 'label', 'start');
  journal({ kind: 'audit', moment: 'start', at: new Date().toISOString(), prices, estimate, roomUsd: room });
  const raw = openRouterPost({ key, fetchImpl: budgetedFetch({ budget, prefix: 'label', stamp: Date.now() }) });
  const passes = await Promise.all(Object.entries(LABEL_MODELS).map(([pass, model]) => {
    const done = new Map(readJsonl(file).filter((event) => event.kind === 'label' && event.pass === pass).map((event) => [event.cell, event.label]));
    let seq = 0;
    const post = async (request) => {
      const quote = budget.quote(request.model, promptTokenCeiling(request.messages), LABEL_MAX_TOKENS);
      const held = budget.state.settledUsd + budget.state.unresolvedUsd;
      if (budget.state.paused || !quote || budget.state.posts + 1 > V3_LIMITS.maxPosts || held + quote.usd > V3_LIMITS.maxUsd) throw new LabelBudgetStop('v3 budget');
      const reply = await raw(request);
      seq += 1;
      journal({
        kind: 'call', pass, model: request.model, cell: request.cell, mode: request.full ? 'full' : 'excerpts', seq, at: new Date().toISOString(),
        ok: reply?.ok === true, status: reply?.status ?? null, network: reply?.network === true, error: reply?.error ?? null,
        finishReason: reply?.finishReason ?? null, usage: reply?.usage ?? null, cost: reply?.cost ?? null, content: reply?.content ?? null, ms: reply?.ms ?? null,
      });
      return reply;
    };
    return runLabelPass({ pass, model, items, tasks: source.tasks, done, post, journal });
  }));
  await audit(budget, 'label', 'end');
  const [passA, passB] = passes;
  writeJson(path.join(paths.labels, 'pass-a.json'), passA.labels);
  writeJson(path.join(paths.labels, 'pass-b.json'), passB.labels);
  const missing = [...passA.missing.map((id) => `A ${id}`), ...passB.missing.map((id) => `B ${id}`)];
  if (missing.length) {
    console.log(`labels missing (${missing.length}): ${missing.join('; ')}`);
    return 2;
  }
  const byId = new Map(source.sources.map((item) => [item.id, item]));
  const ids = items.map((item) => item.id);
  const merged = mergeLabels(ids, byId, source.tasks, passA.labels, passB.labels);
  const spend = labelSpend(readJsonl(file));
  writeJson(path.join(EVAL_ROOT, LABELS_V3), {
    version: 3,
    sourceRun: SOURCE_RUN,
    goldFile: GOLD_FILE,
    goldSha: source.overrides.sha,
    labelModels: LABEL_MODELS,
    effort: LABEL_EFFORT,
    instructionSha: sha256(`${LABEL_INSTRUCTION}\n${EXCERPT_NOTE}\n${FULL_NOTE}`),
    spendUsd: Number(spend.knownUsd.toFixed(4)),
    callsWithoutCost: spend.unknown,
    items: merged,
  });
  const counts = {};
  for (const item of merged) counts[item.group] = (counts[item.group] || 0) + 1;
  console.log(`v3 labels: ${JSON.stringify(counts)}; passes differ on ${merged.filter((item) => item.groupA !== item.groupB).length}`);
  return 0;
}

// Report: computed from stored journals only.

export const V3_FORMS = Object.freeze([
  'accepted', 'cut at the cap', 'answer only in the reasoning', 'not read by the parser', 'failed after generation',
  'not measured', 'outcome unknown', 'not sent or waiting',
]);

export function v3Form(outcome) {
  if (!outcome || outcome.v3 === 'pending') return 'not sent or waiting';
  if (outcome.v3 === 'accepted') return 'accepted';
  if (outcome.v3 === 'unmeasured') return 'not measured';
  if (outcome.v3 === 'unknown') return 'outcome unknown';
  if (outcome.reason === 'cut') return 'cut at the cap';
  if (outcome.reason === 'from_reasoning') return 'answer only in the reasoning';
  if (outcome.reason === 'failed' || outcome.reason === 'deadline') return 'failed after generation';
  return 'not read by the parser';
}

// The categories the plan names for a failure: cap, refusal, format, transport.
export function failureKinds(row) {
  return {
    cap: row['cut at the cap'],
    refusal: row['failed after generation'] + row['not measured'],
    format: row['answer only in the reasoning'] + row['not read by the parser'],
    transport: row['outcome unknown'],
  };
}

function formRow(items, outcome, condition) {
  const row = { n: items.length, ...Object.fromEntries(V3_FORMS.map((name) => [name, 0])) };
  for (const item of items) row[v3Form(outcome(`${item.id}|${condition}`))] += 1;
  return row;
}

export function v3FormTable(sources, outcome, models = COUNCIL) {
  const inputs = sources.filter((item) => item.kind === 'input');
  const rows = [];
  for (const model of models) {
    const list = inputs.filter((item) => item.model === model);
    for (const condition of V3_CONDITIONS) rows.push({ route: model, condition, ...formRow(list, outcome, condition) });
  }
  return { rows, syntheses: formRow(sources.filter((item) => item.kind === 'synthesis'), outcome, 'F') };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Completion tokens of the calls that came back, whatever their form.
export function tokenSpread(list) {
  const values = list.filter((row) => isConfirmed(row)).map((row) => Number(row.completionTokens)).filter(Number.isFinite);
  return {
    n: values.length,
    median: median(values),
    max: values.length ? Math.max(...values) : null,
    upTo512: values.filter((value) => value <= 512).length,
    upTo2048: values.filter((value) => value > 512 && value <= 2048).length,
    upTo4096: values.filter((value) => value > 2048 && value <= 4096).length,
    above4096: values.filter((value) => value > 4096).length,
    atCap: list.filter((row) => isConfirmed(row) && row.reason === 'cut').length,
  };
}

export function callStats(list) {
  const posted = list.filter((row) => row.posts > 0);
  const costs = posted.map((row) => row.cost).filter((value) => Number.isFinite(value));
  const times = posted.map((row) => row.serviceMs).filter((value) => Number.isFinite(value) && value > 0);
  return {
    cells: posted.length,
    posts: posted.reduce((sum, row) => sum + row.posts, 0),
    knownUsd: costs.reduce((sum, value) => sum + value, 0),
    withoutCost: posted.length - costs.length,
    medianMs: median(times),
    maxMs: times.length ? Math.max(...times) : null,
  };
}

// Which cut sources an arm reads under a policy. Fill reads an extra answer
// only where there is no real one, so an arm whose real vote stands reads none.
export function armSources(row, ctx, policy, sourceIds) {
  const d = row.diagnostics;
  const { arms } = row;
  const known = (id) => (sourceIds.has(id) ? id : null);
  const council = ctx.councilModels.map((model, index) => (d.councilAnswers[index] == null ? known(`${row.id}|council:${model}`) : null)).filter(Boolean);
  const replicates = d.replicateAnswers.map((answer, index) => (answer == null ? known(`${row.id}|${index === 0 ? `council:${ctx.bModel}` : `sample:${index + 1}`}`) : null)).filter(Boolean);
  const vote = (real, deps) => (policy === 'fill' && voteOf(row.id, real).status === 'graded' ? [] : deps);
  const out = { B8: [], P8: [], V5: [], A8: [], S8: [] };
  if (arms.B8.status !== 'graded' && d.replicateAnswers[0] == null) {
    const id = known(`${row.id}|council:${ctx.bModel}`);
    if (id) out.B8 = [id];
  }
  if (arms.P8?.status !== 'not_run') out.P8 = vote(d.councilAnswers, council);
  if (d.replicateVote?.status !== 'not_run') out.V5 = vote(d.replicateAnswers, replicates);
  if (ctx.s8Cut && arms.S8.status !== 'graded') out.S8 = vote(d.replicateAnswers, replicates);
  if (ctx.a8Cut && arms.A8.status !== 'graded' && d.leader?.status !== 'graded' && ctx.leaderRole) {
    const id = known(`${row.id}|${ctx.leaderRole}`);
    if (id) out.A8 = [id];
  }
  return out;
}

const emptyTally = () => Object.fromEntries(ARMS.map((arm) => [arm, { wins: 0, losses: 0, unchanged: 0, undetermined: 0 }]));

function tallyInto(tally, arm, kind) {
  tally[arm][kind] += 1;
}

function moveKind(open, was, is) {
  if (open) return 'undetermined';
  if (!was && is) return 'wins';
  if (was && !is) return 'losses';
  return 'unchanged';
}

// The free recount: B8, P8, the vote of five, A8, and S8 under fill (primary)
// and all (shown only). Only cut slots change; the shared first answer of B
// changes everywhere it is used. Each policy is compared with the stored arms,
// and with the fallback, which uses finished answers only: a win over the
// fallback is one that needs an extra answer, and only such a win counts for
// the recommendation.
export function handRecount({ rows, ctx, sources, outcome, primaryBlocks }) {
  const sourceIds = new Set(sources.map((item) => item.id));
  const forced = new Map();
  for (const item of sources) {
    const out = outcome(`${item.id}|F`);
    if (out?.v3 === 'accepted') forced.set(item.id, out.extracted);
  }
  const primary = new Set(primaryBlocks);
  const asRow = (row, arms) => ({ id: row.id, block: row.block, status: 'complete', arms });
  const rates = (list) => Object.fromEntries(ARMS.map((arm) => [arm, list.length ? list.filter((row) => row.arms[arm]?.correct === 1).length : null]));
  const original = rows.map((row) => asRow(row, policyArms(row, ctx.get(row.id), 'original')));
  const originalMain = original.filter((row) => primary.has(row.block));
  const result = {
    rows: rows.length,
    primaryRows: originalMain.length,
    original: { correct: rates(original), primaryCorrect: rates(originalMain), a8MinusS8: comparePair(originalMain, 'A8', 'S8') },
  };
  const fallbackRows = rows.map((row) => asRow(row, policyArms(row, ctx.get(row.id), 'fallback')));
  const fallbackMain = fallbackRows.filter((row) => primary.has(row.block));
  result.fallback = { correct: rates(fallbackRows), primaryCorrect: rates(fallbackMain), a8MinusS8: comparePair(fallbackMain, 'A8', 'S8') };
  for (const policy of ['fill', 'all']) {
    const tallies = { all: emptyTally(), primary: emptyTally(), overFallback: emptyTally(), overFallbackPrimary: emptyTally() };
    const patched = [];
    for (const row of rows) {
      const c = ctx.get(row.id);
      const base = policyArms(row, c, 'original');
      const finished = policyArms(row, c, 'fallback');
      const now = policyArms(row, c, policy, forced);
      const deps = armSources(row, c, policy, sourceIds);
      const main = primary.has(row.block);
      for (const arm of ARMS) {
        const open = (arm === 'A8' && now.undetermined) || deps[arm].some((id) => !isConfirmed(outcome(`${id}|F`)));
        const is = now[arm]?.correct === 1;
        const against = moveKind(open, base[arm]?.correct === 1, is);
        const over = moveKind(open, finished[arm]?.correct === 1, is);
        tallyInto(tallies.all, arm, against);
        tallyInto(tallies.overFallback, arm, over);
        if (main) {
          tallyInto(tallies.primary, arm, against);
          tallyInto(tallies.overFallbackPrimary, arm, over);
        }
      }
      patched.push(asRow(row, now));
    }
    const patchedMain = patched.filter((row) => primary.has(row.block));
    result[policy] = { ...tallies, correct: rates(patched), primaryCorrect: rates(patchedMain), a8MinusS8: comparePair(patchedMain, 'A8', 'S8') };
  }
  result.winArms = ARMS.filter((arm) => result.fill.overFallback[arm].wins > 0);
  return result;
}

// The cut syntheses, shown only: fallback, finished synthesis, and the chain.
export function synthesisTable({ rows, ctx, sources, outcome }) {
  const forced = new Map();
  for (const item of sources) {
    const out = outcome(`${item.id}|F`);
    if (out?.v3 === 'accepted') forced.set(item.id, out.extracted);
  }
  const table = {};
  for (const arm of ['A8', 'S8']) table[arm] = { n: 0, fallbackRight: 0, finishedAccepted: 0, finishedRight: 0, chainRight: 0, unconfirmed: 0 };
  for (const item of sources.filter((entry) => entry.kind === 'synthesis')) {
    const row = rows.find((entry) => entry.id === item.questionId);
    const c = ctx.get(row.id);
    const arm = item.role.split(':')[1];
    const entry = table[arm];
    const finished = outcome(`${item.id}|F`);
    const fill = policyArms(row, c, 'fill', forced)[arm];
    entry.n += 1;
    if (policyArms(row, c, 'fallback')[arm]?.correct === 1) entry.fallbackRight += 1;
    if (!isConfirmed(finished)) entry.unconfirmed += 1;
    if (finished?.v3 === 'accepted') entry.finishedAccepted += 1;
    if (finished?.v3 === 'accepted' && finished.correct === 1) entry.finishedRight += 1;
    if (finished?.v3 === 'accepted' ? finished.correct === 1 : fill?.correct === 1) entry.chainRight += 1;
  }
  return table;
}

function kindOfAttempt(attemptId) {
  const head = String(attemptId).split('|')[0];
  if (head === 'route-probe') return 'route probes';
  if (head === 'label') return 'labels';
  if (head === 'analysis') return 'analysis';
  return 'cells';
}

export function moneyOf(events) {
  const budget = createCampaignBudget({ ...V3_LIMITS, prices: {} });
  budget.applyJournal(events);
  const kinds = {};
  for (const [attemptId, row] of Object.entries(budget.state.reservations)) {
    const name = kindOfAttempt(attemptId);
    const entry = kinds[name] ||= { posts: 0, settledUsd: 0, heldUsd: 0, heldPosts: 0 };
    entry.posts += 1;
    if (row.settled && !row.unresolved) entry.settledUsd += row.cost || 0;
    else {
      entry.heldUsd += row.usd;
      entry.heldPosts += 1;
    }
  }
  const audits = events.filter((event) => event.kind === 'audit' && Number.isFinite(event.usage));
  const first = audits[0] || null;
  const last = audits[audits.length - 1] || null;
  return {
    settledUsd: budget.state.settledUsd,
    heldUsd: budget.state.unresolvedUsd,
    posts: budget.state.posts,
    kinds,
    key: {
      first: first?.usage ?? null,
      firstAt: first?.at ?? null,
      last: last?.usage ?? null,
      lastAt: last?.at ?? null,
      delta: first && last && first !== last ? last.usage - first.usage : null,
      audits: audits.length,
    },
  };
}

function cohereComparison(cells, tasks, outcome, v1Index) {
  const out = [];
  for (const cell of cells.filter((entry) => entry.model === HY4 && entry.condition === 'F')) {
    const old = v1Index.get(cellKey(cell));
    if (old?.state !== 'completed') continue;
    const before = acceptFinish(tasks.get(cell.questionId), old);
    const now = outcome(cell.id);
    out.push({
      cell: cell.sourceId,
      v1: before.accepted ? `accepted ${before.extracted}` : before.reason,
      v3: now?.v3 === 'accepted' ? `accepted ${now.extracted}` : v3Form(now),
      same: before.accepted && now?.v3 === 'accepted' && before.extracted === now.extracted,
    });
  }
  return out;
}

export function buildV3Report(paths, source) {
  const manifest = readJson(paths.manifest);
  const notes = [];
  if (manifest?.frozen) {
    const hashes = checkedSource(source, paths).sourceHashes;
    const changed = changedKeys(hashes, manifest.frozen.sourceHashes);
    if (changed.length) throw new Error(`Source files changed since the freeze: ${changed.join(', ')}`);
    const prior = priorHashes(paths);
    for (const run of ['v1', 'v2']) {
      const moved = changedKeys(prior[run], manifest.frozen.prior[run]);
      if (moved.length) throw new Error(`${run} files changed since the v3 freeze: ${moved.join(', ')}`);
    }
    if (manifest.frozen.orderDigest !== orderDigest(source.sources)) throw new Error('The order of the cells changed since the freeze.');
  } else {
    notes.push('No manifest: nothing was frozen or sent yet.');
  }
  const codeHash = filesHash(V3_FILES);
  const { tasks, sources, rows, ctx } = source;
  const cells = allCells(sources);
  const index = journalIndex(paths.events);
  const outcomes = outcomesFor(cells, tasks, index);
  const outcome = (id) => outcomes.get(id);
  const inputs = sources.filter((item) => item.kind === 'input');
  const v2Labels = labelsOf(path.join(EVAL_ROOT, LABELS_V2));
  const v3LabelsPath = path.join(EVAL_ROOT, LABELS_V3);
  const v3Labels = labelsOf(v3LabelsPath);
  const allGroups = new Map([...v2Labels.groups, ...v3Labels.groups]);
  const allAgreed = new Map([...v2Labels.agreed, ...v3Labels.agreed]);
  const args = { inputs, outcome, labels: v2Labels.groups, models: COUNCIL };
  const criteria = evaluateBounded(args);
  const withoutHy4 = evaluateBounded({ ...args, inputs: inputs.filter((item) => item.model !== HY4), models: [STEPFUN, DEEPSEEK] });
  const sensitivity = evaluateBounded({ ...args, inputs: inputs.filter((item) => !SENSITIVITY_DROP.includes(item.questionId)) });
  const recount = handRecount({ rows, ctx, sources, outcome, primaryBlocks: source.campaign.primaryBlocks });
  const decision = decideV3(criteria, recount.winArms);
  const s1Cells = stageCells(1, sources);
  const stage1 = stage1Status(countStates(s1Cells, outcome));
  const stages = Object.fromEntries([1, 2, 3].map((stage) => [stage, countStates(stageCells(stage, sources), outcome)]));
  const byRoute = (model, condition) => inputs.filter((item) => item.model === model).map((item) => outcome(`${item.id}|${condition}`));
  const tokens = COUNCIL.flatMap((model) => V3_CONDITIONS.map((condition) => ({ route: model, condition, cap: V3_CAPS[model], ...tokenSpread(byRoute(model, condition)) })));
  tokens.push({ route: 'syntheses', condition: 'F', cap: V3_CAPS[STEPFUN], ...tokenSpread(sources.filter((item) => item.kind === 'synthesis').map((item) => outcome(`${item.id}|F`))) });
  const control = COUNCIL.map((model) => {
    const list = byRoute(model, 'C');
    const accepted = list.filter((row) => row.v3 === 'accepted').length;
    return { route: model, n: list.length, accepted, confirmed: list.filter(isConfirmed).length, belowNinety: list.length > 0 && accepted * 10 < 9 * list.length };
  });
  const c4Routes = COUNCIL.map((model) => {
    const list = inputs.filter((item) => item.model === model);
    return { route: model, ...evaluateBounded({ ...args, inputs: list, models: [model] }).c4 };
  });
  const fidelityItems = inputs.filter((item) => allAgreed.has(item.id));
  const fidelity = {
    n: fidelityItems.length,
    confirmed: fidelityItems.filter((item) => isConfirmed(outcome(`${item.id}|F`))).length,
    matches: fidelityItems.filter((item) => outcome(`${item.id}|F`)?.v3 === 'accepted' && outcome(`${item.id}|F`).extracted === allAgreed.get(item.id)).length,
  };
  const labelled115 = v3Labels.data ? evaluateBounded({ ...args, labels: allGroups }) : null;
  const calls = COUNCIL.flatMap((model) => V3_CONDITIONS.map((condition) => ({ route: model, condition, ...callStats(byRoute(model, condition)) })));
  calls.push({ route: 'syntheses', condition: 'F', ...callStats(sources.filter((item) => item.kind === 'synthesis').map((item) => outcome(`${item.id}|F`))) });
  const forms = v3FormTable(sources, outcome);
  const groups = {};
  for (const group of v2Labels.groups.values()) groups[group] = (groups[group] || 0) + 1;
  const groupsV3 = {};
  for (const group of v3Labels.groups.values()) groupsV3[group] = (groupsV3[group] || 0) + 1;
  const result = {
    criteria,
    decision,
    withoutHy4,
    sensitivity,
    leaveOneOut: leaveOneOutBounded(args),
    stage1,
    stages,
    forms,
    failures: forms.rows.map((row) => ({ route: row.route, condition: row.condition, ...failureKinds(row) })),
    tokens,
    control,
    c4Routes,
    fidelity,
    labelled115: labelled115 ? { c2: labelled115.c2, c3: labelled115.c3 } : null,
    recount,
    synthesis: synthesisTable({ rows, ctx, sources, outcome }),
    calls,
    cohere: cohereComparison(cells, tasks, outcome, journalIndex(paths.v1.main)),
  };
  const meta = {
    run: V3_RUN,
    sourceRun: SOURCE_RUN,
    freeze: manifest?.frozen ? { gitHead: manifest.frozen.gitHead, frozenAt: manifest.frozen.frozenAt, codeUnchanged: manifest.frozen.codeHash === codeHash } : null,
    caps: V3_CAPS,
    reasoning: manifest?.reasoning ?? null,
    limits: V3_LIMITS,
    route: (() => {
      const record = readJson(paths.route);
      if (!record) return null;
      return {
        at: record.at,
        chosen: record.chosen ? { tag: record.chosen.tag, providerName: record.chosen.providerName, quantization: record.chosen.quantization, pinnedRoute: record.chosen.pinnedRoute } : null,
        pinnedListed: record.checks?.[HY4]?.pinnedListed ?? null,
        candidates: (record.checks?.[HY4]?.candidates || []).map((row) => row.tag),
        excluded: (record.checks?.[HY4]?.rows || []).filter((row) => row.problems.length).map((row) => ({ tag: row.tag, problems: row.problems })),
        probes: (record.probes || []).map((row) => ({ tag: row.tag, status: row.status, ok: row.ok, finishReason: row.finishReason ?? null })),
        others: Object.fromEntries(COUNCIL.filter((id) => id !== HY4).map((id) => [id, { pinnedListed: record.checks?.[id]?.pinnedListed ?? null, problems: (record.checks?.[id]?.rows || []).find((row) => row.pinned)?.problems ?? null }])),
      };
    })(),
    stops: readJsonl(paths.stops).map(({ at, ...row }) => ({ at, ...row })),
    labels: { v2: { file: LABELS_V2, groups, models: v2Labels.data?.labelModels ?? null }, v3: v3Labels.data ? { file: LABELS_V3, sha: fileSha(v3LabelsPath), groups: groupsV3, differ: v3Labels.data.items.filter((item) => item.groupA !== item.groupB).length, spendUsd: v3Labels.data.spendUsd } : null, skipped: readJson(path.join(paths.labels, 'skipped.json')) },
    money: moneyOf(readJsonl(paths.budget)),
    notes,
  };
  return { meta, result };
}

// Rendering.

const pct = (value) => (value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const usd4 = (value) => `$${Number(value || 0).toFixed(4)}`;
const usd2 = (value) => `$${Number(value || 0).toFixed(2)}`;
const short = (model) => String(model).split('/')[0];
const span = (low, high) => (low === high ? `${low}` : `${low}..${high}`);

export const DECISION_EN = Object.freeze({
  threshold_not_reached: 'the mode did not reach the threshold (criterion 1, 2, or 3 failed); campaign code does not change',
  incomplete: 'the result is incomplete: measurements are missing',
  text_benefit_not_shown: 'criteria 1-3 hold and 4 does not: the use of the saved text is not shown',
  nothing_to_recommend: 'criteria 1-4 hold and fill gives no win: nothing to recommend',
  confirm_on_new_questions: 'criteria 1-4 hold and fill gives wins: a confirming measurement on new questions is recommended for the arms with a win',
});

export const DECISION_RU = Object.freeze({
  threshold_not_reached: 'режим не достиг порога (провален критерий 1, 2 или 3), код кампаний не меняется',
  incomplete: 'результат неполный, не хватает измерений',
  text_benefit_not_shown: 'критерии 1–3 выполнены, 4 нет: польза сохранённого текста не показана',
  nothing_to_recommend: 'критерии 1–4 выполнены, но заполнение не даёт ни одного выигрыша: рекомендовать нечего',
  confirm_on_new_questions: 'критерии 1–4 выполнены, заполнение даёт выигрыши: рекомендуется подтверждающее измерение на новых вопросах для рук с выигрышем',
});

const VERDICT_RU = Object.freeze({ pass: 'выполнен', fail: 'не выполнен', not_evaluable: 'не определён' });
const STAGE1_RU = Object.freeze({ pass: 'пройден', fail: 'провален (9 подтверждённых неуспехов)', insufficient: 'остановлен: недостаточно измерений', running: 'не закончен' });

function criteriaLines(c, label) {
  const lines = [`Criteria, ${label}:`, ''];
  for (const [model, row] of Object.entries(c.c1.models)) {
    lines.push(`- 1, ${model}: accepted ${row.accepted}, rejected ${row.rejected}, unconfirmed ${row.unconfirmed} of ${row.n}; bounds ${pct(row.low)}–${pct(row.high)}; ${row.verdict}.`);
  }
  for (const [name, title] of [['c2', 'firm'], ['c3', 'firm and candidate']]) {
    const row = c[name];
    lines.push(`- ${name.slice(1)}, ${title}: correct ${span(row.correctLow, row.correctHigh)} of ${row.n} (unconfirmed ${row.unconfirmed}), need ${row.need}; question mean ${pct(row.questionMeanLow)}–${pct(row.questionMeanHigh)}; ${row.verdict}.`);
  }
  const f = c.c4;
  lines.push(`- 4, F over C on ${f.n} inputs: F correct ${f.fCorrect} (unconfirmed ${f.fUnconfirmed}), C correct ${f.cCorrect} (unconfirmed ${f.cUnconfirmed}); difference ${span(f.differenceLow, f.differenceHigh)} texts, need ${f.needDifference}; question mean ${pct(f.questionMeanLow)}–${pct(f.questionMeanHigh)}, need ${pct(2 / 23)}; ${f.verdict}.`);
  return lines;
}

const armCell = (row) => `+${row.wins} / -${row.losses} / =${row.unchanged} / ?${row.undetermined}`;

export function renderV3Report({ meta, result }) {
  const lines = ['# Finishing cut answers: finish-probe-v3', ''];
  lines.push(`Source: ${meta.sourceRun}, read only. Rules: finish-probe-v3-protocol.md. Diagnostic: the 115 texts had been read, the golds and grader changed after the run, and the StepFun cap was chosen after the v2 data.`);
  lines.push(meta.freeze
    ? `Freeze: commit ${meta.freeze.gitHead}, ${meta.freeze.frozenAt}. Code ${meta.freeze.codeUnchanged ? 'unchanged since the freeze' : 'CHANGED since the freeze'}.`
    : 'Freeze: none yet.');
  lines.push(`Caps: ${Object.entries(meta.caps).map(([model, cap]) => `${model} ${cap}`).join(', ')}. Reasoning: ${JSON.stringify(meta.reasoning)}.`);
  const r = meta.route;
  lines.push(r
    ? `hy4 route (${r.at}): ${r.chosen ? `${r.chosen.tag} (${r.chosen.providerName}, ${r.chosen.quantization}${r.chosen.pinnedRoute ? ', the pinned provider' : ', a substitute host'})` : 'none found'}; the pinned Cohere endpoint ${r.pinnedListed ? 'was listed' : 'was not listed'}; candidates in order ${r.candidates.join(', ') || 'none'}; excluded ${r.excluded.map((row) => `${row.tag} (${row.problems.join('; ')})`).join(', ') || 'none'}; probes ${r.probes.map((row) => `${row.tag} ${row.status} ${row.ok ? 'generated' : 'no generation'}`).join(', ') || 'none'}.`
    : 'hy4 route: not chosen yet.');
  for (const note of meta.notes) lines.push(note);
  lines.push('');
  lines.push('## Decision', '', `${DECISION_EN[result.decision.code]}${result.decision.arms.length ? `: ${result.decision.arms.join(', ')}` : ''}.`, '');
  const s1 = result.stage1;
  lines.push(`Stage 1 (StepFun F, need ${STAGE1.need} of ${STAGE1.n}, stop at ${STAGE1.stopAt} confirmed failures): ${s1.status}; accepted ${s1.accepted}, rejected ${s1.rejected}, unknown ${s1.unknown}, not measured ${s1.unmeasured}, pending ${s1.pending}.`);
  lines.push(`Cells by stage: ${[1, 2, 3].map((stage) => `${stage}: ${JSON.stringify(result.stages[stage])}`).join('; ')}.`);
  if (meta.stops.length) lines.push(`Stops: ${meta.stops.map((row) => JSON.stringify(row)).join('; ')}.`);
  lines.push('');
  lines.push(...criteriaLines(result.criteria, 'three routes, 115 inputs'), '');
  lines.push(...criteriaLines(result.withoutHy4, 'without hy4, 94 inputs'), '');
  lines.push(...criteriaLines(result.sensitivity, `without ${SENSITIVITY_DROP.join(', ')}`), '');
  lines.push(`Leave one question out: ${result.leaveOneOut.length ? result.leaveOneOut.map((row) => `${row.question} turns ${row.criterion} ${row.from} into ${row.to}`).join('; ') : 'no single question changes a verdict of criteria 2-4'}.`, '');
  lines.push('## Form of the calls', '', `| Route | Condition | n | ${V3_FORMS.join(' | ')} |`, `| --- | --- | --- | ${V3_FORMS.map(() => '---').join(' | ')} |`);
  for (const row of result.forms.rows) lines.push(`| ${row.route} | ${row.condition} | ${row.n} | ${V3_FORMS.map((name) => row[name]).join(' | ')} |`);
  const s = result.forms.syntheses;
  lines.push(`| syntheses | F | ${s.n} | ${V3_FORMS.map((name) => s[name]).join(' | ')} |`);
  lines.push('', 'Not accepted, by category (cap, refusal, format, transport):', '');
  for (const row of result.failures) lines.push(`- ${row.route} ${row.condition}: cap ${row.cap}, refusal ${row.refusal}, format ${row.format}, transport ${row.transport}.`);
  lines.push('', '## Completion tokens of the calls that came back', '', 'Shown for every route. A call that stays under 2048 here is not what a call capped at 2048 would have returned.', '', '| Route | Condition | Cap | n | median | max | <=512 | 513-2048 | 2049-4096 | >4096 | ended at the cap |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of result.tokens) lines.push(`| ${row.route} | ${row.condition} | ${row.cap} | ${row.n} | ${row.median ?? 'n/a'} | ${row.max ?? 'n/a'} | ${row.upTo512} | ${row.upTo2048} | ${row.upTo4096} | ${row.above4096} | ${row.atCap} |`);
  lines.push('', '## Control', '', '| Route | n | C accepted | C came back | below 90% |', '| --- | --- | --- | --- | --- |');
  for (const row of result.control) lines.push(`| ${row.route} | ${row.n} | ${row.accepted} | ${row.confirmed} | ${row.belowNinety ? 'yes: the extraction mechanism is not established' : 'no'} |`);
  lines.push('', 'Criterion 4 inside each route (shown only):', '');
  for (const row of result.c4Routes) lines.push(`- ${row.route}: n ${row.n}, F correct ${row.fCorrect}, C correct ${row.cCorrect}, difference ${span(row.differenceLow, row.differenceHigh)}.`);
  lines.push('', `Agreement of F with the value both labelling passes accepted: ${result.fidelity.matches} of ${result.fidelity.n} (${result.fidelity.confirmed} came back).`);
  if (result.labelled115) {
    const l = result.labelled115;
    lines.push(`With the v3 labels on all 115 (shown only): firm ${span(l.c2.correctLow, l.c2.correctHigh)} of ${l.c2.n}, need ${l.c2.need}, ${l.c2.verdict}; firm and candidate ${span(l.c3.correctLow, l.c3.correctHigh)} of ${l.c3.n}, need ${l.c3.need}, ${l.c3.verdict}.`);
  }
  if (result.cohere.length) {
    lines.push('', 'hy4 F on the texts measured in v1 through Cohere (descriptive):', '');
    for (const row of result.cohere) lines.push(`- ${row.cell}: v1 ${row.v1}; v3 ${row.v3}; same value ${row.same ? 'yes' : 'no'}.`);
  }
  const rc = result.recount;
  lines.push('', '## Recount of the arms', '', `All ${rc.rows} kept questions; primary set ${rc.primaryRows}. Cells: wins / losses / unchanged / undetermined. "Over the stored arms" includes what the fallback alone changes; "over the fallback" counts only changes that need an extra answer, and only these count for the recommendation (arms with a win: ${rc.winArms.join(', ') || 'none'}).`, '', `| Policy | Against | ${ARMS.join(' | ')} |`, `| --- | --- | ${ARMS.map(() => '---').join(' | ')} |`);
  for (const policy of ['fill', 'all']) {
    const name = `${policy}${policy === 'all' ? ' (shown only)' : ''}`;
    lines.push(`| ${name} | stored arms | ${ARMS.map((arm) => armCell(rc[policy].all[arm])).join(' | ')} |`);
    lines.push(`| ${name} | fallback | ${ARMS.map((arm) => armCell(rc[policy].overFallback[arm])).join(' | ')} |`);
  }
  lines.push('', '| Policy, primary set | A8 correct | S8 correct | A8 - S8 | wins/losses | 95% | 90% |', '| --- | --- | --- | --- | --- | --- | --- |');
  const interval = (row) => (row?.low == null ? 'n/a' : `[${(row.low * 100).toFixed(1)}, ${(row.high * 100).toFixed(1)}]`);
  for (const [name, row] of [['original', rc.original], ['fallback', rc.fallback], ['fill', rc.fill], ['all', rc.all]]) {
    const pair = row.a8MinusS8;
    lines.push(`| ${name} | ${row.primaryCorrect.A8} | ${row.primaryCorrect.S8} | ${pair.delta == null ? 'n/a' : `${(pair.delta * 100).toFixed(1)} pp`} | ${pair.wins}/${pair.losses} | ${interval(pair.interval)} | ${interval(pair.interval90)} |`);
  }
  lines.push('', '## Cut syntheses (shown only)', '', '| Arm | n | fallback right | finished accepted | finished right | chain right | unconfirmed |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const [arm, row] of Object.entries(result.synthesis)) lines.push(`| ${arm} | ${row.n} | ${row.fallbackRight} | ${row.finishedAccepted} | ${row.finishedRight} | ${row.chainRight} | ${row.unconfirmed} |`);
  lines.push('', '## Price and time of the calls, failed ones included', '', '| Route | Condition | cells posted | POSTs | known cost | without a cost | median s | max s |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  const sec = (ms) => (ms == null ? 'n/a' : (ms / 1000).toFixed(1));
  for (const row of result.calls) lines.push(`| ${row.route} | ${row.condition} | ${row.cells} | ${row.posts} | ${usd4(row.knownUsd)} | ${row.withoutCost} | ${sec(row.medianMs)} | ${sec(row.maxMs)} |`);
  const m = meta.money;
  lines.push('', '## Money', '', `One budget journal for every v3 POST: settled ${usd4(m.settledUsd)}, held ${usd4(m.heldUsd)}, ${m.posts} POSTs; limits ${usd2(meta.limits.maxUsd)} and ${meta.limits.maxPosts}.`, '');
  for (const [name, row] of Object.entries(m.kinds)) lines.push(`- ${name}: ${row.posts} POSTs, settled ${usd4(row.settledUsd)}, held ${usd4(row.heldUsd)} for ${row.heldPosts}.`);
  lines.push(`- Key usage: ${m.key.first == null ? 'n/a' : `$${m.key.first.toFixed(4)}`} at the first audit (${m.key.firstAt || 'n/a'}), ${m.key.last == null ? 'n/a' : `$${m.key.last.toFixed(4)}`} at the last (${m.key.lastAt || 'n/a'}); moved by ${m.key.delta == null ? 'n/a' : usd4(m.key.delta)} against ${usd4(m.settledUsd)} settled and ${usd4(m.heldUsd)} held. Other use of the key and billing delay are not attributed to cells.`);
  const l = meta.labels;
  lines.push('', `Labels: the frozen 51 of v2 (${JSON.stringify(l.v2.groups)}) decide criteria 2 and 3.${l.v3 ? ` v3 labels on 64 more texts: ${JSON.stringify(l.v3.groups)}, the passes differ on ${l.v3.differ}, ${usd4(l.v3.spendUsd)}.` : ''}${l.skipped ? ` v3 labels skipped: ${JSON.stringify(l.skipped)}.` : ''}`);
  return lines.join('\n');
}

export function renderV3Readme({ meta, result }) {
  const c = result.criteria;
  const r = meta.route;
  let hostRu = 'маршрут, который ещё не выбран';
  if (r?.chosen) hostRu = `${r.chosen.tag}${r.chosen.pinnedRoute ? ' (закреплённый Cohere)' : ' (замещающий хост; Cohere не было в списке)'}`;
  else if (r) hostRu = 'маршрут, который не нашёлся (hy4 не измерен)';
  const lines = [
    '### Диагностика: дописывание оборванных ответов, повтор (`finish-probe-v3`)',
    '',
    `Новый разведочный раунд на тех же 115 оборванных входах и 18 синтезах a8-open-v5e. Правила — в [finish-probe-v3-protocol.md](finish-probe-v3-protocol.md). Лимит StepFun 8192 вместо 2048, hy4 через ${hostRu}, у hy4 и DeepSeek 2048. Числа, границы и решение посчитаны кодом; блок собран из отчёта без толкования.`,
    '',
    `**Решение по заранее заданному правилу:** ${DECISION_RU[result.decision.code]}${result.decision.arms.length ? ` (${result.decision.arms.join(', ')})` : ''}.`,
    '',
    `Этап 1 (StepFun F): ${STAGE1_RU[result.stage1.status] || result.stage1.status}; принято ${result.stage1.accepted}, подтверждённо не принято ${result.stage1.rejected}, исход неизвестен ${result.stage1.unknown}, не измерено ${result.stage1.unmeasured}, не отправлено ${result.stage1.pending} из ${STAGE1.n}.`,
    '',
    '| Критерий | Значение | Порог | Итог |',
    '| --- | --- | --- | --- |',
  ];
  for (const [model, row] of Object.entries(c.c1.models)) {
    lines.push(`| 1. Принятые F, ${short(model)} | ${row.accepted} из ${row.n}${row.unconfirmed ? `, без подтверждённого исхода ${row.unconfirmed}` : ''} | 90% | ${VERDICT_RU[row.verdict]} |`);
  }
  lines.push(`| 2. Твёрдые | верно ${span(c.c2.correctLow, c.c2.correctHigh)} из ${c.c2.n} | ${c.c2.need} и 80% | ${VERDICT_RU[c.c2.verdict]} |`);
  lines.push(`| 3. Твёрдые и кандидаты | верно ${span(c.c3.correctLow, c.c3.correctHigh)} из ${c.c3.n} | ${c.c3.need} и 50% | ${VERDICT_RU[c.c3.verdict]} |`);
  lines.push(`| 4. F выше C на ${c.c4.n} входах | разница ${span(c.c4.differenceLow, c.c4.differenceHigh)} текстов | ${c.c4.needDifference} и 2/23 по вопросам | ${VERDICT_RU[c.c4.verdict]} |`);
  const w = result.withoutHy4;
  const s = result.sensitivity;
  lines.push('', `Без hy4 (${w.c4.n} входа): критерии ${['c1', 'c2', 'c3', 'c4'].map((name) => VERDICT_RU[w[name].verdict]).join(', ')}. Без HMMT 17 и q752d (${s.c4.n}): ${['c1', 'c2', 'c3', 'c4'].map((name) => VERDICT_RU[s[name].verdict]).join(', ')}.`);
  lines.push('', '| Маршрут | Условие | n | принят | оборван на лимите | другой неуспех | не измерено | исход неизвестен | не отправлено |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of result.forms.rows) {
    const other = row['answer only in the reasoning'] + row['not read by the parser'] + row['failed after generation'];
    lines.push(`| ${short(row.route)} | ${row.condition} | ${row.n} | ${row.accepted} | ${row['cut at the cap']} | ${other} | ${row['not measured']} | ${row['outcome unknown']} | ${row['not sent or waiting']} |`);
  }
  const rc = result.recount;
  const pp = (pair) => (pair.delta == null ? 'n/a' : `${(pair.delta * 100).toFixed(1)} п. п.`);
  lines.push('', `Пересчёт рук при заполнении, все ${rc.rows} вопросов (выигрыши / потери / без изменения / неопределённо), против сохранённых рук: ${ARMS.map((arm) => `${arm} ${armCell(rc.fill.all[arm])}`).join('; ')}.`);
  lines.push('', `Против fallback, то есть только изменения, которым нужен дописанный ответ: ${ARMS.map((arm) => `${arm} ${armCell(rc.fill.overFallback[arm])}`).join('; ')}. Руки с выигрышем: ${rc.winArms.join(', ') || 'нет'}.`);
  lines.push('', `A8 − S8 на основном наборе: исходно ${pp(rc.original.a8MinusS8)}, fallback ${pp(rc.fallback.a8MinusS8)}, заполнение ${pp(rc.fill.a8MinusS8)}.`);
  const m = meta.money;
  lines.push('', `Расход v3: подтверждено ${usd2(m.settledUsd)}, удержано ${usd2(m.heldUsd)}, ${m.posts} POST из ${meta.limits.maxPosts} (лимит ${usd2(meta.limits.maxUsd)}). Счётчик ключа за v3 вырос на ${m.key.delta == null ? 'n/a' : usd2(m.key.delta)}.`);
  lines.push('', 'Ограничения: все 115 текстов просмотрены, эталоны и грейдер менялись после прогона, лимит 8192 выбран после данных v2; hy4 на замещающем хосте — не закреплённый маршрут; F и C у StepFun разнесены во времени; дописанные синтезы не равны повтору A8 и S8; твёрдые тексты взяты из 9 вопросов. Это диагностика.');
  lines.push('', 'Полный отчёт — `.runs/finish-probe-v3/report.md`. Воспроизвести без сети:', '', '```bash', 'node frontend/eval/finishProbeCli.js finish-probe-v3 --phase report', '```');
  return lines.join('\n');
}

export function placeBlock(readme, start, end, body, after) {
  const replaced = replaceSection(readme, start, end, `\n${body}\n`);
  if (replaced != null) return replaced;
  const at = readme.indexOf(after);
  if (at < 0) return `${readme.replace(/\s*$/, '')}\n\n${start}\n\n${body}\n\n${end}\n`;
  const cut = at + after.length;
  return `${readme.slice(0, cut)}\n\n${start}\n\n${body}\n\n${end}${readme.slice(cut)}`;
}

function runReport(paths, source, argv) {
  const built = buildV3Report(paths, source);
  mkdirSync(paths.dir, { recursive: true });
  writeJson(paths.report, built);
  writeFileSync(paths.reportMd, `${renderV3Report(built)}\n`, 'utf8');
  const block = renderV3Readme(built);
  writeFileSync(paths.readme, `${block}\n`, 'utf8');
  if (argv.includes('--readme')) {
    const text = readFileSync(README, 'utf8');
    const next = placeBlock(text, README_START, README_END, block, AFTER_V2);
    if (next !== text) writeFileSync(README, next, 'utf8');
  }
  console.log(`report written: ${paths.reportMd}`);
  console.log(`decision: ${built.result.decision.code}`);
  return 0;
}

// Analysis: one OpenRouter model writes it from the report and the protocol,
// another checks it, as in v2. Claude does not write or edit the text.

export function analysisSection(text, check) {
  return [
    '#### Анализ (v3)',
    '',
    `_Текст написала модель ${WRITER} через OpenRouter по \`.runs/finish-probe-v3/report.md\` и протоколу v3; модель ${CHECKER} сверила его с отчётом (замечаний: ${check.problems.length}). Claude этот текст не писал и не правил._`,
    '',
    String(text).trim(),
  ].join('\n');
}

async function runAnalysis(paths) {
  if (!existsSync(paths.reportMd)) throw new Error('Build the report first.');
  const key = paidKey();
  const prices = await modelPrices([WRITER, CHECKER]);
  const budget = openBudget(paths.budget, prices);
  settings.apiKey = key;
  await audit(budget, 'analysis', 'start');
  const file = path.join(paths.analysis, 'calls.jsonl');
  const journal = (event) => appendJsonl(file, event);
  const result = await writeChecked({
    protocol: readFileSync(path.join(EVAL_ROOT, PROTOCOL_V3), 'utf8'),
    report: readFileSync(paths.reportMd, 'utf8'),
    post: poster({ key, journal, fetchImpl: budgetedFetch({ budget, prefix: 'analysis', stamp: Date.now() }) }),
  });
  await audit(budget, 'analysis', 'end');
  writeJson(path.join(paths.analysis, 'result.json'), result);
  if (!result.text) {
    console.log(`analysis not placed: ${result.reason}`);
    return 2;
  }
  const body = analysisSection(result.text, result.check);
  writeFileSync(path.join(paths.analysis, 'analysis.md'), `${body}\n`, 'utf8');
  const text = readFileSync(README, 'utf8');
  if (!text.includes(README_END)) throw new Error('Place the v3 README block first (report --readme).');
  writeFileSync(README, placeBlock(text, ANALYSIS_START, ANALYSIS_END, body, README_END), 'utf8');
  console.log('analysis placed in README');
  return 0;
}

// Inspect: no network.

function measuredPrompts(files) {
  const map = new Map();
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const slot of readSlotJournal(file).values()) {
      const tokens = slot.usage?.prompt_tokens;
      if (Number.isFinite(tokens) && slot.request?.messages) map.set(sha256(JSON.stringify(slot.request.messages)), tokens);
    }
  }
  return map;
}

export function worstCase(cells, tasks, routes, measured) {
  const byId = new Map(routes.map((route) => [route.id, route]));
  const messagesOf = (cell) => [{ role: 'user', content: finishMessage(tasks.get(cell.questionId), cell.condition, cell.source.text) }];
  const ratios = [];
  for (const cell of cells) {
    const messages = messagesOf(cell);
    const tokens = measured.get(sha256(JSON.stringify(messages)));
    if (tokens) ratios.push(JSON.stringify(messages).length / tokens);
  }
  const ratio = ratios.length ? Math.min(...ratios) : 1;
  let reserve = 0;
  let estimate = 0;
  let measuredCells = 0;
  for (const cell of cells) {
    const messages = messagesOf(cell);
    const pricing = byId.get(cell.model).pricing;
    const cap = V3_CAPS[cell.model];
    const known = measured.get(sha256(JSON.stringify(messages)));
    if (known) measuredCells += 1;
    reserve += quoteReservation({ pricing, promptTokens: promptTokenCeiling(messages), maxTokens: cap }).usd;
    estimate += quoteReservation({ pricing, promptTokens: known ?? Math.ceil(JSON.stringify(messages).length / ratio), maxTokens: cap }).usd;
  }
  return { cells: cells.length, measuredCells, reserveUsd: reserve, worstUsd: estimate, charsPerToken: ratio };
}

function runInspect(paths, source) {
  const base = inspectSource(source, SOURCE_RUN);
  const problems = [...base.mismatches.map((name) => `baseline ${name}`)];
  const cells = allCells(source.sources);
  const ids = new Set(cells.map((cell) => cell.id));
  const keys = new Set(cells.map((cell) => cellKey(cell)));
  if (ids.size !== cells.length || keys.size !== cells.length) problems.push('duplicate cells');
  const inputCells = cells.filter((cell) => cell.source.kind === 'input');
  const synthCells = cells.filter((cell) => cell.source.kind === 'synthesis');
  if (inputCells.length !== 230) problems.push(`input cells ${inputCells.length}`);
  if (synthCells.length !== 18) problems.push(`synthesis cells ${synthCells.length}`);
  const stages = [1, 2, 3].map((stage) => stageCells(stage, source.sources));
  const staged = new Set(stages.flat().map((cell) => cell.id));
  if (staged.size !== cells.length || stages.flat().length !== cells.length) problems.push('stages do not cover the cells once');
  if (stages[0].length !== STAGE1.n) problems.push(`stage 1 has ${stages[0].length} cells`);
  const routes = v3Routes(source.selection.routes, null);
  const routeMap = probeRoutes(routes);
  const v1Settings = readJson(paths.v1.settings);
  for (const model of COUNCIL) {
    if (JSON.stringify(routeMap[model].reasoning) !== JSON.stringify(v1Settings.reasoning[model])) problems.push(`effort of ${model}`);
  }
  const prepare = prepareProbe(routeMap, (model) => V3_CAPS[model]);
  const payloads = {};
  for (const model of COUNCIL) {
    const cell = inputCells.find((entry) => entry.model === model && entry.condition === 'F');
    const content = finishMessage(source.tasks.get(cell.questionId), 'F', cell.source.text);
    const request = canonicalCompletionRequest(model, [{ role: 'user', content }], prepare(model, STAGE, {}));
    const route = routes.find((entry) => entry.id === model);
    const needPrompt = largestPrompt(source, model);
    payloads[model] = {
      maxTokens: request.max_tokens,
      provider: request.provider,
      reasoning: request.reasoning ?? null,
      temperature: request.temperature,
      topP: request.top_p,
      routeMaxCompletion: route.maxCompletion,
      routeContext: route.context,
      largestPromptCeiling: needPrompt,
    };
    if (request.max_tokens !== V3_CAPS[model]) problems.push(`max_tokens of ${model} is ${request.max_tokens}`);
    if (route.maxCompletion != null && route.maxCompletion < V3_CAPS[model]) problems.push(`${model} lists max completion ${route.maxCompletion}`);
    if (route.context != null && route.context < needPrompt + V3_CAPS[model]) problems.push(`${model} context ${route.context}`);
  }
  // With no extra answer, fill is the fallback, and the fallback keeps the
  // stored B8, P8, and vote of five: the votes and their ties are the stored ones.
  const same = (left, right) => left?.correct === right?.correct && (left?.extracted ?? null) === (right?.extracted ?? null);
  const drift = [];
  for (const row of source.rows) {
    const c = source.ctx.get(row.id);
    const stored = policyArms(row, c, 'original');
    const fallback = policyArms(row, c, 'fallback');
    const empty = policyArms(row, c, 'fill', new Map());
    for (const arm of ARMS) if (!same(empty[arm], fallback[arm])) drift.push(`${row.id} ${arm} fill`);
    for (const arm of ['B8', 'P8', 'V5']) if (!same(fallback[arm], stored[arm])) drift.push(`${row.id} ${arm} fallback`);
  }
  if (drift.length) problems.push(`policies without extra answers move arms: ${drift.slice(0, 5).join('; ')}`);
  const measured = measuredPrompts([paths.v1.main, paths.v1.round1, paths.v1.round2, paths.v2.main]);
  const worst = Object.fromEntries([1, 2, 3].map((stage) => [stage, worstCase(stages[stage - 1], source.tasks, routes, measured)]));
  const labels = labelEstimate(readJsonl(paths.v2.labels));
  const probeUsd = PROBE.maxPosts * quoteReservation({ pricing: routes.find((route) => route.id === HY4).pricing, promptTokens: promptTokenCeiling([{ role: 'user', content: PROBE.prompt }]), maxTokens: PROBE.maxTokens }).usd;
  const totalWorst = worst[1].worstUsd + worst[2].worstUsd + worst[3].worstUsd + (labels.usd || 0) + probeUsd;
  const summary = {
    run: V3_RUN,
    sourceRun: SOURCE_RUN,
    inputs: base.inputs,
    byModel: base.byModel,
    syntheses: base.syntheses,
    questions: base.questions,
    baseline: base.baseline,
    mismatches: base.mismatches,
    cells: { all: cells.length, inputs: inputCells.length, syntheses: synthCells.length, stage1: stages[0].length, stage2: stages[1].length, stage3: stages[2].length },
    questionsCovered: new Set(inputCells.map((cell) => cell.questionId)).size,
    policyRows: source.rows.length,
    policyDrift: drift.length,
    payloads,
    worstCase: { ...worst, labels, probesUsd: probeUsd, totalUsd: totalWorst, limitUsd: V3_LIMITS.maxUsd, postsWithoutRefusals: cells.length + PROBE.maxPosts + labels.posts },
    sensitivityInputs: base.inputs - source.sources.filter((item) => item.kind === 'input' && SENSITIVITY_DROP.includes(item.questionId)).length,
    withoutHy4Inputs: source.sources.filter((item) => item.kind === 'input' && item.model !== HY4).length,
    hashes: { code: filesHash(V3_FILES), order: orderDigest(source.sources), source: base.sourceDigest, prior: priorHashes(paths) },
    problems,
  };
  writeJson(paths.inspect, summary);
  console.log(JSON.stringify(summary, null, 2));
  return problems.length ? 1 : 0;
}

export async function runFinishProbeV3Command(argv) {
  const phase = flagValue(argv, '--phase');
  if (!phase) throw new Error('finish-probe-v3 requires --phase');
  const root = flagValue(argv, '--root');
  const paths = v3Paths(root ? path.resolve(root) : RUNS_ROOT);
  const live = ['route', 'run', 'label', 'analysis'];
  if (root && live.includes(phase)) throw new Error('--root is only for inspect and report');
  mkdirSync(paths.dir, { recursive: true });
  if (phase === 'analysis') {
    if (!argv.includes('--live')) throw new Error('analysis posts only with --live');
    const release = lock(paths.dir);
    try {
      freezeV3(paths, loadSource(SOURCE_RUN));
      return await runAnalysis(paths);
    } finally {
      release();
    }
  }
  const source = loadSource(SOURCE_RUN);
  if (phase === 'inspect') return runInspect(paths, source);
  if (phase === 'report') return runReport(paths, source, argv);
  if (!live.includes(phase)) throw new Error(`Unknown finish-probe-v3 phase ${phase}`);
  if (!argv.includes('--live')) throw new Error(`${phase} posts only with --live`);
  const release = lock(paths.dir);
  try {
    const manifest = freezeV3(paths, source);
    if (phase === 'route') return await runRoute(paths, source);
    if (phase === 'run') return await runRun(paths, source, manifest);
    return await runLabels(paths, source);
  } finally {
    release();
  }
}
