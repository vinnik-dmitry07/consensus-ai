// redteam-probe-v1: what the red team adds after a stored Stage 2, under
// redteam-probe-v1-protocol.md. Stage 1 and Stage 2 come from the stored test
// of a8-open-v5e; only the red team (RT) and the chairman (C, Rc, Rp) are
// called. Written and committed before the first paid call. Every number,
// bound and reading comes from this code; the analysis text comes from
// OpenRouter models.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCouncilMetadata, buildJudgeView, buildStage2Prompt, calculateAggregateRankings, canonicalLabelToModel,
  computeConsensus, formatStage2Result, redTeamReview, stage3SynthesizeFinal,
} from '../src/engine/browser/council.js';
import { canonicalCompletionRequest, modelFamily, queryModelResult, setQueryHook } from '../src/engine/browser/openrouter.js';
import { catalogueId } from '../src/engine/browser/roster.js';
import { settings } from '../src/engine/browser/settings.js';
import { LEGACY_BLOCKS } from './a8Blocks.js';
import { gitState, policyFrom, prepareFor, reconcileBudget, sourceHash } from './a8.js';
import { applyGoldOverrides, comparePair } from './a8Report.js';
import { cutReasoning, forwardText, orderBySlots } from './a8Variants.js';
import { BudgetPaused, createCampaignBudget } from './budget.js';
import { loadBankTasks, questionRecords, readGold } from './campaignData.js';
import { audit } from './finishProbe.js';
import { pinnedListed, routeUnavailable } from './finishProbeV2Report.js';
import { answerPrompt, gradeResponse } from './grade.js';
import { isEvalInvariant } from './invariant.js';
import { envKey, fileSha, readJson, readJsonl } from './noteTools.js';
import { promptTokenCeiling, quoteReservation } from './paid.js';
import { ALPHA, DELTA_MIN } from './protocol.js';
import { runIsolated } from './questionScope.js';
import { holm } from './report.js';
import { createSession, readSlotJournal, slotKey, snapshotLocal } from './runtime.js';
import { installTransport } from './transport.js';
import { sha256, stableStringify } from './util.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(EVAL_ROOT, '.runs');
const MODELS_URL = 'https://openrouter.ai/api/v1/models';

export const PROBE_RUN = 'redteam-probe-v1';
export const SOURCE_RUN = 'a8-open-v5e';
export const ROUTES_FROM = 'a8-routes-v7';
export const PROTOCOL = 'redteam-probe-v1-protocol.md';
export const PROBE_FILES = Object.freeze(['redTeamProbe.js', 'redTeamProbeCli.js', 'redTeamProbe.test.js', PROTOCOL, 'campaignData.js']);
export const GOLD_FILE = 'gold-corrections-a8-open-v5e.json';
export const WIDE_GOLD_FILE = 'gold-corrections-a8-open-v5e-all.json';
export const LIMITS = Object.freeze({ maxUsd: 40, maxPosts: 1800 });
export const RT_CAP = 32768;
export const ORDER_SEED = 'redteam-probe-v1-order';
export const SMOKE_SIZE = 3;
export const WINDOW = 8;
export const MAX_IN_FLIGHT = 16;
export const MAX_IN_FLIGHT_PER_MODEL = 12;
export const MAX_WAIT_MS = 45 * 60_000;
export const FEW_DISCORDANT = 20;
// What a request needs from an endpoint: the parameters the route sends.
export const ROUTE_PARAMETERS = Object.freeze(['max_tokens', 'temperature', 'top_p']);
const CAPTURE_REPLY = Object.freeze({ ok: true, content: 'ANSWER: capture', usage: {} });

export function probePaths(root = RUNS_ROOT) {
  const dir = path.join(root, PROBE_RUN);
  return {
    dir,
    manifest: path.join(dir, 'manifest.json'),
    budget: path.join(dir, 'budget.jsonl'),
    test: path.join(dir, 'test'),
    smoke: path.join(dir, 'smoke'),
    route: path.join(dir, 'route.json'),
    stops: path.join(dir, 'stops.jsonl'),
    inspect: path.join(dir, 'inspect.json'),
    report: path.join(dir, 'report.json'),
    reportMd: path.join(dir, 'report.md'),
  };
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const slotResult = (slot) => (slot?.result ? { ...slot.result, finishReason: slot.result.finishReason ?? slot.finishReason ?? null } : null);
const orderKey = (seed, id) => sha256(`${seed}\n${id}`);

// The ids in the seeded order of the probe.
export function seededOrder(ids, seed = ORDER_SEED) {
  return [...ids].sort((left, right) => (orderKey(seed, left) < orderKey(seed, right) ? -1 : orderKey(seed, left) > orderKey(seed, right) ? 1 : 0));
}

// Source.

export function loadSource(phase = 'test', root = RUNS_ROOT) {
  const dir = path.join(root, SOURCE_RUN);
  const files = {
    campaign: path.join(dir, 'campaign.json'),
    selection: path.join(dir, 'selection.json'),
    journal: path.join(dir, 'comparison', phase, 'events.jsonl'),
  };
  const campaign = readJson(files.campaign);
  const selection = readJson(files.selection);
  if (!campaign || !selection) throw new Error(`${SOURCE_RUN} has no campaign or selection`);
  // The pilot phase holds dev questions.
  const rows = questionRecords(path.join(dir, 'comparison', phase), phase === 'test' ? 'test_' : 'dev_')
    .filter((row) => row.status === 'complete')
    .sort((left, right) => left.id.localeCompare(right.id));
  const byQuestion = new Map();
  for (const slot of readSlotJournal(files.journal).values()) {
    if (!slot.meta?.questionId) continue;
    const list = byQuestion.get(slot.meta.questionId) || [];
    list.push(slot);
    byQuestion.set(slot.meta.questionId, list);
  }
  return { phase, campaign, selection, tasks: loadBankTasks(), rows, byQuestion, files };
}

export function rosterOf(source) {
  return {
    councilModels: [...source.selection.council],
    chairmanModel: source.selection.h,
    redTeamModel: null,
    nSamples: source.campaign.nSamples,
    topK: source.campaign.topK,
    selfExclusion: source.campaign.selfExclusion,
    strictChairman: true,
  };
}

// Rebuilds, from the stored slots, what runA8 of a8Variants.js built for one
// question: Stage 1 in canonical order, the tail-forwarded Stage 1, the judges
// (each judge slot picked by equality with the rebuilt prompt), the rankings.
export async function rebuildQuestion(source, row) {
  const { campaign } = source;
  const roster = rosterOf(source);
  const task = source.tasks.get(row.id);
  if (!task) throw new Error(`${row.id} is not in the bank`);
  const prompt = answerPrompt(task);
  const slots = source.byQuestion.get(row.id) || [];
  const session = { slots: () => slots };
  const done = (branch, stage, model) => slots.filter((slot) => slot.state === 'completed' && slot.meta.branch === branch && slot.meta.stage === stage && slot.meta.model === model);
  const slotFor = (stage, model, text) => done('council', stage, model).find((slot) => (slot.result?.content || '') === text) || null;
  const metaOf = (stage) => (item) => ({ questionId: row.id, branch: 'council', stage, sample: 1, model: item.model });
  const raw = roster.councilModels.map((model) => {
    const list = done('council', 'stage1', model);
    if (list.length !== 1) throw new Error(`${row.id}: ${list.length} completed Stage 1 slots of ${model}`);
    return { model, response: list[0].result?.content || '' };
  });
  const stage1 = orderBySlots(session, raw, metaOf('stage1'), (item) => item.response || '');
  const cutStage1 = stage1.map((item) => cutReasoning(slotResult(slotFor('stage1', item.model, item.response))));
  const forwarded = stage1.map((item, index) => (cutStage1[index] ? { ...item, response: forwardText(item.response, campaign.tailRule) } : item));
  let stage2 = [];
  for (const judge of roster.councilModels) {
    const view = await buildJudgeView(judge, forwarded, prompt, roster.selfExclusion);
    const judgePrompt = buildStage2Prompt(prompt, view.candidates);
    const matches = done('council', 'stage2', judge).filter((slot) => slot.request?.messages?.[0]?.content === judgePrompt);
    if (matches.length !== 1) throw new Error(`${row.id}: ${matches.length} judge slots of ${judge} match the rebuilt prompt`);
    const slot = matches[0];
    stage2.push(formatStage2Result(judge, { content: slot.result?.content || '', usage: slot.usage || slot.result?.usage || {} }, view));
  }
  stage2 = orderBySlots(session, stage2, metaOf('stage2'), (item) => item.ranking || '');
  stage2 = stage2.map((item) => (cutReasoning(slotResult(slotFor('stage2', item.model, item.ranking)))
    ? formatStage2Result(item.model, { content: forwardText(item.ranking, campaign.tailRule), usage: item.usage }, { label_to_index: item.label_to_index, self_excluded: item.self_excluded })
    : item));
  const ranked = calculateAggregateRankings(stage1, stage2);
  const topN = Math.max(1, Math.min(roster.topK, ranked.responseRankings.length));
  const topK = ranked.responseRankings.slice(0, topN).map((item) => item.index);
  const leaderIndex = ranked.responseRankings[0].index;
  const storedA8 = done('A8', 'stage3', roster.chairmanModel);
  const stored = storedA8.find((slot) => (slot.result?.content || '') === (row.arms?.A8?.text || '')) || null;
  return {
    id: row.id, block: row.block, task, prompt, roster, stage1, forwarded, stage2, ranked, topK,
    leaderIndex, leaderModel: stage1[leaderIndex].model, leaderCut: cutStage1[leaderIndex], stored,
  };
}

// Requests are built by the engine's own functions against a hook that records
// the call and does not send it. Never run while a session hook is installed.
export async function captureCall(run, reply = CAPTURE_REPLY) {
  let call = null;
  setQueryHook(({ model, messages, options }) => {
    call = { model, messages, options: options || {} };
    return typeof reply === 'function' ? reply() : reply;
  });
  try {
    const value = await run();
    return { call, value };
  } finally {
    setQueryHook(null);
  }
}

export async function chairmanCall(question, redTeam) {
  const consensus = computeConsensus(question.ranked.responseRankings, question.stage2, redTeam);
  const metadata = buildCouncilMetadata(
    canonicalLabelToModel(question.stage1), question.ranked.responseRankings, question.ranked.aggregateRankings,
    question.topK, redTeam, consensus, question.ranked.rankingFallback,
  );
  const { call } = await captureCall(() => stage3SynthesizeFinal(question.prompt, question.forwarded, question.stage2, metadata, { roster: question.roster }));
  return { ...call, consensus: { level: consensus.level, reasons: consensus.reasons } };
}

function reviewWith(question, reply) {
  return captureCall(() => redTeamReview(
    question.prompt, question.forwarded[question.leaderIndex].response || '', question.leaderIndex,
    question.ranked.responseRankings, question.forwarded, { roster: question.roster },
  ), reply);
}

export async function redTeamCall(question) {
  return (await reviewWith(question, { ok: true, content: '', usage: {} })).call;
}

// The object the product builds from a stored RT result.
export async function productRedTeam(question, result) {
  return (await reviewWith(question, result)).value;
}

// The clean reading of a red-team reply (protocol "Clean verdict and critique").

const MARKS = '[\\s*_]*';
const VERDICT_LINE = new RegExp(`^${MARKS}VERDICT${MARKS}:${MARKS}(REFUTED|CONTESTED|UPHELD)${MARKS}$`, 'i');
const VERDICT_TEMPLATE = new RegExp(`^${MARKS}VERDICT${MARKS}:${MARKS}REFUTED\\s*\\|\\s*CONTESTED\\s*\\|\\s*UPHELD${MARKS}$`, 'i');
const CONFIDENCE_LINE = new RegExp(`^${MARKS}CONFIDENCE${MARKS}:${MARKS}(-?\\d+(?:\\.\\d+)?)\\s*(?:\\/\\s*10)?${MARKS}$`, 'i');
const CONFIDENCE_TEMPLATE = new RegExp(`^${MARKS}CONFIDENCE${MARKS}:${MARKS}<\\s*0\\s*-\\s*10\\s*>${MARKS}$`, 'i');

export function cleanReading(text) {
  const lines = String(text || '').split('\n');
  const bare = (line) => line.replace(/\r$/, '');
  const verdicts = [];
  const confidences = [];
  const drop = new Set();
  let templates = 0;
  let invalidConfidence = 0;
  let otherVerdictLike = 0;
  lines.forEach((line, index) => {
    const value = bare(line);
    if (VERDICT_TEMPLATE.test(value) || CONFIDENCE_TEMPLATE.test(value)) {
      templates += 1;
      drop.add(index);
      return;
    }
    const verdict = value.match(VERDICT_LINE);
    if (verdict) {
      verdicts.push({ index, value: verdict[1].toUpperCase() });
      return;
    }
    if (/VERDICT\s*[*_]*\s*:/i.test(value)) otherVerdictLike += 1;
    const confidence = value.match(CONFIDENCE_LINE);
    if (confidence) {
      const number = Number(confidence[1]);
      if (Number.isFinite(number) && number >= 0 && number <= 10) confidences.push({ index, value: number });
      else invalidConfidence += 1;
    }
  });
  for (const list of [verdicts, confidences]) for (const item of list.slice(0, -1)) drop.add(item.index);
  const critique = lines.filter((_, index) => !drop.has(index)).join('\n');
  return {
    verdict: verdicts.length ? verdicts[verdicts.length - 1].value : null,
    confidence: confidences.length ? confidences[confidences.length - 1].value : null,
    critique,
    counts: {
      verdictLines: verdicts.length, confidenceLines: confidences.length, templates,
      duplicates: Math.max(0, verdicts.length - 1) + Math.max(0, confidences.length - 1), invalidConfidence, otherVerdictLike,
    },
  };
}

// The state of the RT call (protocol "Handling of the RT result").
export function rtOutcome(slot) {
  if (!slot) return { state: 'pending', reason: 'not_sent' };
  if (slot.state === 'completed') {
    const result = slotResult(slot);
    if (!result?.ok) return { state: 'done', usable: false, reason: 'failed' };
    if (result.finishReason === 'length') return { state: 'done', usable: false, reason: 'cap' };
    if (result.finishReason === 'loop') return { state: 'done', usable: false, reason: 'loop' };
    if (result.contentFromReasoning === true) return { state: 'done', usable: false, reason: 'reasoning_only' };
    if (result.finishReason !== 'stop') return { state: 'done', usable: false, reason: `finish_${result.finishReason ?? 'unknown'}` };
    return { state: 'done', usable: true, reason: 'stop' };
  }
  if (slot.state === 'failed') {
    if (routeUnavailable(slot)) return { state: 'unmeasured', reason: 'route_unavailable' };
    return { state: 'done', usable: false, reason: 'failed' };
  }
  return { state: 'pending', reason: slot.state || 'unknown' };
}

// The red-team object Rc gets, or null (unavailable) with the reason.
export function cleanRedTeam(outcome, result, model, leaderIndex, sameFamily) {
  if (outcome.state !== 'done' || !outcome.usable) return { object: null, reason: outcome.reason, reading: null };
  const reading = cleanReading(result?.content || '');
  if (!reading.critique.trim()) return { object: null, reason: 'empty_after_cleaning', reading };
  return {
    object: {
      model, target_index: leaderIndex, critique: reading.critique, verdict: reading.verdict,
      confidence: reading.confidence, usage: result?.usage || {}, same_family: sameFamily,
    },
    reason: 'admitted',
    reading,
  };
}

// A chairman call: terminal when completed or failed for good.
export function chairmanState(slot) {
  if (!slot) return 'pending';
  if (slot.state === 'completed') return 'done';
  if (slot.state === 'failed') return routeUnavailable(slot) ? 'unmeasured' : 'done';
  return 'pending';
}

export function requestHash(prepare, call, stage) {
  return sha256(stableStringify(canonicalCompletionRequest(call.model, call.messages, prepare(call.model, stage, call.options || {}))));
}

function cell(question, branch, stage, call, prepare, slots) {
  const hash = requestHash(prepare, call, stage);
  const key = slotKey({ questionId: question.id, branch, stage, sample: 1, model: call.model, requestHash: hash });
  return { questionId: question.id, branch, stage, call, hash, key, slot: slots.get(key) || null };
}

// Everything the probe knows about one question from the probe's slots. Pure
// apart from the engine calls behind captureCall, so it runs with no session.
export async function planQuestion(question, prepare, slots) {
  const rtCall = await redTeamCall(question);
  const rt = cell(question, 'RT', 'redteam', rtCall, prepare, slots);
  const outcome = rtOutcome(rt.slot);
  const cCall = await chairmanCall(question, null);
  const c = cell(question, 'C', 'stage3', cCall, prepare, slots);
  const plan = { question, rt: { ...rt, outcome }, c, rc: null, rp: null, clean: null, product: null };
  if (outcome.state !== 'done') return plan;
  const result = slotResult(rt.slot);
  const sameFamily = modelFamily(rtCall.model) === modelFamily(question.leaderModel);
  plan.clean = cleanRedTeam(outcome, result, rtCall.model, question.leaderIndex, sameFamily);
  plan.product = await productRedTeam(question, rt.slot.result);
  const rcCall = plan.clean.object ? await chairmanCall(question, plan.clean.object) : cCall;
  const rc = cell(question, 'Rc', 'stage3', rcCall, prepare, slots);
  plan.rc = rc.hash === c.hash ? { ...c, alias: 'C' } : rc;
  const rpCall = plan.product ? await chairmanCall(question, plan.product) : cCall;
  const rp = cell(question, 'Rp', 'stage3', rpCall, prepare, slots);
  plan.rp = rp.hash === c.hash ? { ...c, alias: 'C' } : rp.hash === rc.hash ? { ...plan.rc, alias: plan.rc.alias || 'Rc' } : rp;
  return plan;
}

// A question is measured for the primary pair when C and Rc have ended.
export function primaryState(plan) {
  if (plan.rt.outcome.state === 'unmeasured') return 'unmeasured';
  if (plan.rt.outcome.state !== 'done') return 'pending';
  const states = [chairmanState(plan.c.slot), chairmanState(plan.rc.slot)];
  if (states.includes('unmeasured')) return 'unmeasured';
  return states.every((state) => state === 'done') ? 'measured' : 'pending';
}

export function productState(plan) {
  if (!plan.rp) return 'pending';
  const state = chairmanState(plan.rp.slot);
  return state === 'done' ? 'measured' : state;
}

// The cells to send now: RT first; C and Rc once RT has ended; Rp only in the
// product part.
export function cellsToSend(plan, { product = false } = {}) {
  if (plan.rt.outcome.state === 'unmeasured') return [];
  if (plan.rt.outcome.state !== 'done') return product ? [] : [plan.rt];
  const pending = (item) => item && !item.alias && chairmanState(item.slot) === 'pending';
  if (product) return pending(plan.rp) ? [plan.rp] : [];
  const out = [plan.c, plan.rc].filter(pending);
  return out.sort((left, right) => (orderKey(ORDER_SEED, `${plan.question.id}\n${left.branch}`) < orderKey(ORDER_SEED, `${plan.question.id}\n${right.branch}`) ? -1 : 1));
}

// The longest prefix of the order whose questions are all measured.
export function measuredPrefix(order, stateOf) {
  const out = [];
  for (const id of order) {
    if (stateOf(id) !== 'measured') break;
    out.push(id);
  }
  return out;
}

// Grades.

export function gradeOf(task, gold, slot) {
  const graded = { ...task, goldCanon: gold };
  const result = slotResult(slot);
  if (!result?.ok) return { ...gradeResponse(graded, '', 'provider_error'), finishReason: result?.finishReason ?? null };
  return { ...gradeResponse(graded, result.content || ''), finishReason: result.finishReason ?? null };
}

// The reading of a pair under the rules of the v5 protocol (interpretV5 in
// a8Report.js), with the arm names of this probe.
function usableInterval(interval) {
  return Boolean(interval) && !interval.degenerate && interval.low != null && interval.high != null;
}

export function interpretPair(comparison, planned, complete, left, right) {
  if (!complete || comparison.n !== planned) return ['interim: the primary set is incomplete, so this is not a final claim'];
  const lines = [];
  const { delta, p, interval, interval90, wins, losses } = comparison;
  const threshold = `${DELTA_MIN * 100} percentage points`;
  if (delta > 0 && p < ALPHA) lines.push(`direction: statistical evidence that ${left} is ahead of ${right} on this set`);
  else if (delta < 0 && p < ALPHA) lines.push(`direction: statistical evidence that ${right} is ahead of ${left} on this set`);
  else lines.push('direction: not established; this is not evidence that the two methods are equal');
  if (!usableInterval(interval)) {
    lines.push('size: the 95% interval is degenerate and says nothing about size or equivalence');
    return lines;
  }
  if (interval.low > DELTA_MIN) lines.push(`${left} ahead by more than ${threshold}: supported by the 95% interval`);
  else if (interval.high < DELTA_MIN) lines.push(`${left} ahead by more than ${threshold}: not supported by the 95% interval`);
  else lines.push(`${left} ahead by more than ${threshold}: undecided, the 95% interval crosses the threshold`);
  if (interval.high < -DELTA_MIN) lines.push(`${right} ahead by more than ${threshold}: supported by the 95% interval`);
  else if (interval.low > -DELTA_MIN) lines.push(`${right} ahead by more than ${threshold}: not supported by the 95% interval`);
  else lines.push(`${right} ahead by more than ${threshold}: undecided, the 95% interval crosses the threshold`);
  if (!usableInterval(interval90)) {
    lines.push('practical equivalence: the 90% interval is degenerate, so no claim');
  } else if (interval90.low > -DELTA_MIN && interval90.high < DELTA_MIN) {
    lines.push(`practical equivalence within ±${threshold}: supported by the 90% interval (an approximate bootstrap criterion, not an exact TOST)`);
  } else {
    lines.push(`practical equivalence within ±${threshold}: not shown, the 90% interval reaches a bound`);
  }
  if (wins + losses < FEW_DISCORDANT) lines.push(`only ${wins + losses} discordant pairs, so the bootstrap intervals are rough`);
  return lines;
}

// Routes.

export function probeRoutes(root = RUNS_ROOT) {
  const preflight = readJson(path.join(root, ROUTES_FROM, 'preflight.json'));
  if (!preflight) throw new Error(`${ROUTES_FROM} has no route snapshot`);
  return preflight;
}

export function probePrepare(preflight, campaign) {
  const policy = policyFrom(preflight, campaign);
  return prepareFor({ ...policy, caps: { ...policy.caps, redteam: RT_CAP } });
}

// Why a pinned endpoint cannot carry the probe's calls; empty when it can.
// A listed endpoint with a negative status counts as not available.
export function routeProblems(route, listing, needPrompt, cap = RT_CAP) {
  const endpoints = listing?.endpoints || [];
  const pinned = endpoints.find((endpoint) => pinnedListed(route, [endpoint]));
  if (!pinned) return ['not listed'];
  const problems = [];
  if (Number(pinned.status) < 0) problems.push(`status ${pinned.status}`);
  const params = pinned.supported_parameters || [];
  const missing = ROUTE_PARAMETERS.filter((name) => !params.includes(name));
  if (missing.length) problems.push(`parameters: ${missing.join(', ')}`);
  if (!(Number(pinned.context_length) >= needPrompt + cap)) problems.push('context');
  if (pinned.max_completion_tokens != null && Number(pinned.max_completion_tokens) < cap) problems.push('max completion');
  const prices = [pinned.pricing, ...(pinned.pricing?.overrides || [])].filter(Boolean);
  if (!prices.length || prices.some((price) => Number(price.prompt) > Number(route.pricing.prompt) || Number(price.completion) > Number(route.pricing.completion))) problems.push('price');
  return problems;
}

async function listingOf(id) {
  try {
    const response = await fetch(`${MODELS_URL}/${id}/endpoints`);
    const body = await response.json().catch(() => null);
    return { status: response.status, endpoints: body?.data?.endpoints || [] };
  } catch (error) {
    return { status: null, endpoints: [], error: error instanceof Error ? error.message : String(error) };
  }
}

// Inspect: the rebuild of every question, gate G0, and the money (no POST).

export async function inspectSource(source, preflight) {
  const out = { phase: source.phase, questions: source.rows.length, g0: { equal: 0, differ: [] }, redTeam: {}, leaderCut: 0, levels: {}, prompts: [] };
  const digest = [];
  for (const row of source.rows) {
    const question = await rebuildQuestion(source, row);
    const c = await chairmanCall(question, null);
    const stored = question.stored;
    const equal = Boolean(stored) && c.model === stored.meta.model && stableStringify(c.messages) === stableStringify(stored.request?.messages);
    if (equal) out.g0.equal += 1;
    else out.g0.differ.push(row.id);
    digest.push({ id: row.id, model: c.model, messages: c.messages });
    const rt = await redTeamCall(question);
    out.redTeam[modelFamily(rt.model)] = (out.redTeam[modelFamily(rt.model)] || 0) + 1;
    out.levels[c.consensus.level] = (out.levels[c.consensus.level] || 0) + 1;
    if (question.leaderCut) out.leaderCut += 1;
    out.prompts.push({ id: row.id, rtModel: rt.model, rtTokens: promptTokenCeiling(rt.messages), cTokens: promptTokenCeiling(c.messages) });
  }
  out.g0Digest = sha256(stableStringify(digest));
  const priceOf = (model) => preflight.routes.find((route) => route.id === model)?.pricing;
  // Worst case: every RT, C and Rc call at the cap, Rc's prompt grown by a
  // critique of the cap; Rp not counted.
  out.worstUsd = out.prompts.reduce((sum, item) => sum
    + (quoteReservation({ pricing: priceOf(item.rtModel), promptTokens: item.rtTokens, maxTokens: RT_CAP })?.usd ?? 0)
    + (quoteReservation({ pricing: priceOf(source.selection.h), promptTokens: item.cTokens, maxTokens: RT_CAP })?.usd ?? 0)
    + (quoteReservation({ pricing: priceOf(source.selection.h), promptTokens: item.cTokens + RT_CAP, maxTokens: RT_CAP })?.usd ?? 0), 0);
  return out;
}

export function scoringSet(source, root = EVAL_ROOT) {
  const gold = readGold(readJson(path.join(root, GOLD_FILE)), source.tasks);
  const ids = source.rows.map((row) => row.id).filter((id) => !gold.excluded.has(id));
  return { gold, ids, order: seededOrder(ids) };
}

// Freeze.

function filesRecord() {
  return Object.fromEntries(PROBE_FILES.map((name) => [name, fileSha(path.join(EVAL_ROOT, name))]));
}

export function freezeRecord(test, pilot, inspected) {
  return {
    files: filesRecord(),
    methodHash: sourceHash(),
    sourceMethodHash: test.campaign.sourceHash,
    source: {
      test: fileSha(test.files.journal),
      pilot: fileSha(pilot.files.journal),
      campaign: fileSha(test.files.campaign),
      selection: fileSha(test.files.selection),
      bank: ['bank.json', 'bank-a8x.json'].map((name) => fileSha(path.join(EVAL_ROOT, '.cache', name))),
      gold: fileSha(path.join(EVAL_ROOT, GOLD_FILE)),
      wideGold: fileSha(path.join(EVAL_ROOT, WIDE_GOLD_FILE)),
      routes: fileSha(path.join(RUNS_ROOT, ROUTES_FROM, 'preflight.json')),
    },
    orderSeed: ORDER_SEED,
    orderDigest: sha256(inspected.order.join('\n')),
    g0: { test: inspected.test.g0Digest, pilot: inspected.pilot.g0Digest },
    limits: LIMITS,
    cap: RT_CAP,
  };
}

function sameRecord(saved, current) {
  return stableStringify(saved) === stableStringify(current);
}

export function freezeProbe(paths, record) {
  const manifest = readJson(paths.manifest);
  if (manifest) {
    if (!sameRecord(manifest.frozen.record, record)) {
      const changed = Object.keys(record).filter((key) => stableStringify(manifest.frozen.record[key]) !== stableStringify(record[key]));
      throw new Error(`The probe changed since its freeze: ${changed.join(', ')}`);
    }
    return manifest;
  }
  const git = gitState(PROBE_FILES);
  if (!git.head) throw new Error(`Cannot read the git commit (${git.error || 'unknown'}).`);
  if (git.dirty.length) throw new Error(`Commit the probe files before the first POST: ${git.dirty.join(', ')}`);
  const next = { run: PROBE_RUN, frozen: { record, gitHead: git.head, frozenAt: new Date().toISOString() } };
  writeJson(paths.manifest, next);
  return next;
}

// Sending.

function openBudget(file, prices) {
  mkdirSync(path.dirname(file), { recursive: true });
  const budget = createCampaignBudget({ ...LIMITS, prices, onEvent: (event) => appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8') });
  budget.applyJournal(readJsonl(file));
  return budget;
}

async function sendCells(cells, session) {
  const snapshot = snapshotLocal();
  let paused = false;
  await Promise.all(cells.map((item, index) => runIsolated(snapshot, index, async () => {
    session.setContext({ questionId: item.questionId, branch: item.branch, stage: item.stage, sample: 1, model: item.call.model });
    try {
      await queryModelResult(item.call.model, item.call.messages, item.call.options);
      await session.drain();
    } catch (error) {
      if (isEvalInvariant(error)) throw error;
      if (error instanceof BudgetPaused) {
        paused = true;
        return;
      }
      throw error;
    }
  })));
  return { paused };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Works the questions in order, a window at a time. Returns why it ended.
export async function runQuestions({ questions, session, prepare, product = false, blocked = new Set(), log = console.log, maxWaitMs = MAX_WAIT_MS }) {
  const closed = new Set(blocked);
  let waited = 0;
  for (let start = 0; start < questions.length; start += WINDOW) {
    const window = questions.slice(start, start + WINDOW);
    let idle = 0;
    for (;;) {
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
      session.uninstall();
      const slots = new Map(session.slots().map((slot) => [slot.key, slot]));
      let plans;
      try {
        plans = [];
        for (const question of window) plans.push(await planQuestion(question, prepare, slots));
      } finally {
        session.install();
      }
      const wanted = plans.flatMap((plan) => cellsToSend(plan, { product }));
      if (!wanted.length) break;
      const open = wanted.filter((item) => !closed.has(item.call.model));
      if (!open.length) break;
      const now = Date.now();
      const until = (model) => session.cooldowns.get(catalogueId(model)) || 0;
      const ready = open.filter((item) => until(item.call.model) <= now);
      if (!ready.length) {
        const ms = Math.max(1_000, Math.min(...open.map((item) => until(item.call.model))) - now + 1_000);
        if (waited + ms > maxWaitMs) return { end: 'waiting', blocked: [...closed] };
        await sleep(ms);
        waited += ms;
        continue;
      }
      const before = session.slots().reduce((sum, slot) => sum + (slot.httpAttempts || 0), 0);
      const sent = await sendCells(ready, session);
      const after = session.slots();
      for (const slot of after) if (routeUnavailable(slot)) closed.add(slot.meta.model);
      const posts = after.reduce((sum, slot) => sum + (slot.httpAttempts || 0), 0) - before;
      idle = posts > 0 ? 0 : idle + 1;
      if (sent.paused) continue;
      if (idle >= 3) return { end: 'stuck', blocked: [...closed] };
    }
    log(`window ${start / WINDOW + 1}: questions ${Math.min(start + WINDOW, questions.length)} of ${questions.length}; budget $${session.budget.state.settledUsd.toFixed(4)} settled, ${session.budget.state.posts} POSTs`);
  }
  return { end: 'done', blocked: [...closed] };
}

export async function runLive(kind, { paths = probePaths(), argv = [] } = {}) {
  const test = loadSource('test');
  const pilot = loadSource('pilot');
  const preflight = probeRoutes();
  const prepare = probePrepare(preflight, test.campaign);
  const inspected = await inspectAll(test, pilot, preflight);
  if (inspected.test.g0.differ.length || inspected.pilot.g0.differ.length) throw new Error('Gate G0 failed; see inspect.');
  const manifest = freezeProbe(paths, freezeRecord(test, pilot, inspected));
  const source = kind === 'smoke' ? pilot : test;
  const routes = preflight.routes.filter((route) => test.selection.council.includes(route.id));
  const needPrompt = Object.fromEntries(routes.map((route) => [route.id, Math.max(0, ...[...inspected.test.prompts, ...inspected.pilot.prompts].flatMap((item) => [
    item.rtModel === route.id ? item.rtTokens : 0, route.id === test.selection.h ? item.cTokens + RT_CAP : 0,
  ]))]));
  const listings = {};
  for (const route of routes) listings[route.id] = await listingOf(route.id);
  const checks = Object.fromEntries(routes.map((route) => [route.id, { tag: route.tag, problems: routeProblems(route, listings[route.id], needPrompt[route.id]) }]));
  writeJson(paths.route, { at: new Date().toISOString(), kind, checks });
  const blocked = new Set(Object.entries(checks).filter(([, row]) => row.problems.length).map(([id]) => id));
  for (const id of blocked) appendFileSync(paths.stops, `${JSON.stringify({ at: new Date().toISOString(), kind: 'route', phase: kind, model: id, problems: checks[id].problems })}\n`, 'utf8');
  if (blocked.has(test.selection.h)) {
    console.log(`the chairman's host is not available: ${checks[test.selection.h].problems.join(', ')}`);
    return 6;
  }
  const key = envKey();
  if (!key) throw new Error('or_key is missing');
  settings.apiKey = key;
  const budget = openBudget(paths.budget, Object.fromEntries(routes.map((route) => [route.id, route.pricing])));
  if (budget.unresolvedAttempts().length) {
    try {
      const journals = [paths.test, paths.smoke].map((dir) => path.join(dir, 'events.jsonl')).filter((file) => existsSync(file));
      await reconcileBudget({ dir: paths.dir }, budget, { journals });
    } catch (error) {
      console.log(`reconcile skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await audit(budget, kind, 'start');
  const session = createSession({
    runDir: kind === 'smoke' ? paths.smoke : paths.test,
    budget,
    prepareOptions: prepare,
    maxInFlight: MAX_IN_FLIGHT,
    maxInFlightPerModel: MAX_IN_FLIGHT_PER_MODEL,
    retainRoster: true,
    retryAfterCooldown: true,
    retryLimit: test.campaign.maxAttempts,
  });
  const restore = installTransport({
    allowModels: new Set(routes.map((route) => route.id)),
    allowPaid: true,
    rejectFree: true,
    budget,
    onHttp: session.onHttp,
    onCooldown: session.onCooldown,
  });
  session.install();
  let out;
  try {
    const rows = new Map(source.rows.map((row) => [row.id, row]));
    const ids = kind === 'smoke' ? inspected.smokeIds : inspected.order;
    const questions = [];
    for (const id of ids) questions.push(await rebuildQuestion(source, rows.get(id)));
    if (kind === 'smoke') {
      out = await runQuestions({ questions, session, prepare, blocked });
      if (out.end === 'done') out = await runQuestions({ questions, session, prepare, blocked, product: true });
    } else {
      out = await runQuestions({ questions, session, prepare, blocked, product: kind === 'product' });
    }
  } finally {
    session.uninstall();
    restore();
    await audit(budget, kind, 'end');
    console.log(`probe budget: settled $${budget.state.settledUsd.toFixed(4)}, held $${budget.state.unresolvedUsd.toFixed(4)}, ${budget.state.posts} POSTs (frozen at ${manifest.frozen.gitHead.slice(0, 12)})`);
  }
  appendFileSync(paths.stops, `${JSON.stringify({ at: new Date().toISOString(), kind, end: out.end, blocked: out.blocked })}\n`, 'utf8');
  console.log(`probe ${kind} ended: ${out.end}`);
  void argv;
  if (out.end === 'done') return 0;
  if (out.end === 'budget') return 5;
  if (out.end === 'route_unavailable') return 6;
  return 2;
}

// Both phases, the order and the smoke questions; G0 on both.
export async function inspectAll(test, pilot, preflight) {
  const inspectedTest = await inspectSource(test, preflight);
  const inspectedPilot = await inspectSource(pilot, preflight);
  const { ids, order } = scoringSet(test);
  const pilotOrder = seededOrder(pilot.rows.map((row) => row.id));
  const rtOf = new Map(inspectedPilot.prompts.map((item) => [item.id, item.rtModel]));
  // The smoke set holds a question where hy4 is the red team: it is the slowest host.
  const firstHy4 = pilotOrder.find((id) => modelFamily(rtOf.get(id)) === 'tencent');
  const smokeIds = [firstHy4, ...pilotOrder.filter((id) => id !== firstHy4)].filter(Boolean).slice(0, SMOKE_SIZE);
  return { test: inspectedTest, pilot: inspectedPilot, ids, order, smokeIds };
}

// Report (no POST).

const pct = (value) => (value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const pp = (value) => (value == null ? 'n/a' : `${(value * 100).toFixed(1)} pp`);
const bound = (interval) => (interval?.low == null ? 'n/a' : `[${(interval.low * 100).toFixed(1)}, ${(interval.high * 100).toFixed(1)}] pp`);
const usd4 = (value) => `$${Number(value || 0).toFixed(4)}`;

function costOf(slot) {
  const cost = slot?.usage?.cost ?? slot?.result?.usage?.cost;
  return Number.isFinite(cost) ? cost : 0;
}

function tally(list, keyOf) {
  const out = {};
  for (const item of list) {
    const key = keyOf(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

export async function buildReport(paths = probePaths()) {
  const test = loadSource('test');
  const preflight = probeRoutes();
  const prepare = probePrepare(preflight, test.campaign);
  const { gold, order } = scoringSet(test);
  const wide = readGold(readJson(path.join(EVAL_ROOT, WIDE_GOLD_FILE)), test.tasks);
  const probeFile = path.join(paths.test, 'events.jsonl');
  const slots = existsSync(probeFile) ? readSlotJournal(probeFile) : new Map();
  const rows = new Map(test.rows.map((row) => [row.id, row]));
  const stored = new Map(applyGoldOverrides(test.rows, Object.fromEntries(gold.gold)).rows.map((row) => [row.id, row]));
  const plans = new Map();
  for (const id of order) plans.set(id, await planQuestion(await rebuildQuestion(test, rows.get(id)), prepare, slots));
  const prefix = measuredPrefix(order, (id) => primaryState(plans.get(id)));
  const complete = prefix.length === order.length;
  const gradeRow = (id, golds) => {
    const plan = plans.get(id);
    const task = test.tasks.get(id);
    const goldOf = golds.goldOf(id);
    const arms = {};
    if (primaryState(plan) === 'measured') {
      arms.C = gradeOf(task, goldOf, plan.c.slot);
      arms.Rc = plan.rc.alias ? arms.C : gradeOf(task, goldOf, plan.rc.slot);
    }
    if (plan.rp && productState(plan) === 'measured') arms.Rp = plan.rp.alias === 'C' ? arms.C : plan.rp.alias === 'Rc' ? arms.Rc : gradeOf(task, goldOf, plan.rp.slot);
    const a8 = stored.get(id)?.arms?.A8;
    if (a8) arms.A8 = a8;
    return { id, block: rows.get(id).block, status: 'complete', arms };
  };
  const scored = prefix.map((id) => gradeRow(id, gold));
  const primary = comparePair(scored, 'Rc', 'C');
  const constructionTies = prefix.filter((id) => plans.get(id).rc.alias).length;
  const legacy = new Set(LEGACY_BLOCKS);
  const changed = (row) => !plans.get(row.id).rc.alias;
  const secondary = [
    ['Rp - C', scored, 'Rp', 'C'],
    ['Rp - Rc', scored, 'Rp', 'Rc'],
    ['C - stored A8', scored, 'C', 'A8'],
    ['Rc - C, new blocks', scored.filter((row) => !legacy.has(row.block)), 'Rc', 'C'],
    ['Rc - C, legacy blocks', scored.filter((row) => legacy.has(row.block)), 'Rc', 'C'],
    ['Rc - C, changed requests', scored.filter(changed), 'Rc', 'C'],
  ].map(([name, list, left, right]) => ({ name, ...comparePair(list, left, right) }));
  const adjusted = holm(secondary.map((item) => (item.n ? item.p : 1)));
  secondary.forEach((item, index) => { item.holm = adjusted[index]; });

  // Diagnostics.
  const all = order.map((id) => plans.get(id));
  const ended = all.filter((plan) => plan.rt.outcome.state === 'done');
  const rtEndings = {};
  for (const plan of ended) {
    const model = plan.rt.call.model;
    rtEndings[model] ||= {};
    rtEndings[model][plan.rt.outcome.reason] = (rtEndings[model][plan.rt.outcome.reason] || 0) + 1;
  }
  const readings = ended.filter((plan) => plan.clean?.reading).map((plan) => plan.clean.reading.counts);
  const sum = (field) => readings.reduce((total, item) => total + item[field], 0);
  const verdictOf = (plan) => (plan.clean?.object ? (plan.clean.object.verdict || 'no verdict') : `unavailable: ${plan.clean?.reason ?? plan.rt.outcome.reason}`);
  const productVerdict = (plan) => (plan.product ? (plan.product.verdict || (plan.product.error ? 'error' : 'none')) : 'no object');
  const leaderRight = (id) => stored.get(id)?.diagnostics?.leader?.correct === 1;
  const byVerdict = {};
  for (const row of scored) {
    const key = verdictOf(plans.get(row.id));
    const entry = byVerdict[key] ||= { n: 0, leaderRight: 0, cRight: 0, rcRight: 0, fixed: 0, broke: 0 };
    entry.n += 1;
    if (leaderRight(row.id)) entry.leaderRight += 1;
    if (row.arms.C.correct === 1) entry.cRight += 1;
    if (row.arms.Rc.correct === 1) entry.rcRight += 1;
    if (row.arms.C.correct !== 1 && row.arms.Rc.correct === 1) entry.fixed += 1;
    if (row.arms.C.correct === 1 && row.arms.Rc.correct !== 1) entry.broke += 1;
  }
  const levels = {
    C: tally(prefix, (id) => plans.get(id).c.call.consensus.level),
    Rc: tally(prefix, (id) => plans.get(id).rc.call.consensus.level),
  };
  const blocks = {};
  for (const row of scored) {
    const entry = blocks[row.block] ||= { n: 0, c: 0, rc: 0, wins: 0, losses: 0 };
    entry.n += 1;
    entry.c += row.arms.C.correct === 1 ? 1 : 0;
    entry.rc += row.arms.Rc.correct === 1 ? 1 : 0;
    if (row.arms.Rc.correct === 1 && row.arms.C.correct !== 1) entry.wins += 1;
    if (row.arms.Rc.correct !== 1 && row.arms.C.correct === 1) entry.losses += 1;
  }
  const cutLeader = comparePair(scored.filter((row) => plans.get(row.id).question.leaderCut), 'Rc', 'C');
  const widePrefix = prefix.filter((id) => !wide.excluded.has(id));
  const widePair = comparePair(widePrefix.map((id) => gradeRow(id, wide)), 'Rc', 'C');
  const branches = ['RT', 'C', 'Rc', 'Rp'];
  const money = Object.fromEntries(branches.map((branch) => {
    const list = [...slots.values()].filter((slot) => slot.meta?.branch === branch);
    const times = list.map((slot) => slot.serviceMs).filter(Number.isFinite);
    const tokens = list.map((slot) => slot.usage?.completion_tokens).filter(Number.isFinite);
    return [branch, {
      calls: list.length, posts: list.reduce((total, slot) => total + (slot.httpAttempts || 0), 0),
      usd: list.reduce((total, slot) => total + costOf(slot), 0),
      meanSeconds: times.length ? times.reduce((a, b) => a + b, 0) / times.length / 1000 : null,
      meanCompletionTokens: tokens.length ? tokens.reduce((a, b) => a + b, 0) / tokens.length : null,
    }];
  }));
  const policyUsd = prefix.reduce((total, id) => {
    const plan = plans.get(id);
    return total + costOf(plan.rt.slot) + costOf(plan.rc.alias ? plan.c.slot : plan.rc.slot);
  }, 0);
  const budget = createCampaignBudget({ ...LIMITS, prices: {} });
  budget.applyJournal(readJsonl(paths.budget));
  const states = tally(order, (id) => primaryState(plans.get(id)));
  const productCoverage = tally(prefix, (id) => productState(plans.get(id)));
  return {
    meta: {
      run: PROBE_RUN, source: SOURCE_RUN, routes: ROUTES_FROM, planned: order.length, measured: prefix.length, complete,
      states, productCoverage, frozen: readJson(paths.manifest)?.frozen?.gitHead ?? null,
      spend: { settledUsd: budget.state.settledUsd, heldUsd: budget.state.unresolvedUsd, posts: budget.state.posts },
    },
    primary: { ...primary, constructionTies, observedTies: primary.ties - constructionTies, changedRequests: prefix.length - constructionTies, accuracy: { C: rateOf(scored, 'C'), Rc: rateOf(scored, 'Rc') }, reading: interpretPair(primary, order.length, complete, 'Rc', 'C') },
    secondary,
    diagnostics: {
      rtEndings, readings: { replies: readings.length, templates: sum('templates'), duplicates: sum('duplicates'), invalidConfidence: sum('invalidConfidence'), otherVerdictLike: sum('otherVerdictLike'), noVerdict: ended.filter((plan) => plan.clean?.object && !plan.clean.object.verdict).length },
      productVerdicts: tally(ended, productVerdict), cleanVerdicts: tally(ended, verdictOf),
      firstLastDiffer: ended.filter((plan) => plan.product?.verdict && plan.clean?.object?.verdict && plan.product.verdict !== plan.clean.object.verdict).length,
      byVerdict, levels, blocks, cutLeader: { n: cutLeader.n, wins: cutLeader.wins, losses: cutLeader.losses },
      wideGold: { n: widePair.n, wins: widePair.wins, losses: widePair.losses, delta: widePair.delta, p: widePair.p },
      money, policyUsd,
    },
  };
}

function rateOf(rows, arm) {
  const list = rows.filter((row) => row.arms[arm]);
  return list.length ? list.filter((row) => row.arms[arm].correct === 1).length / list.length : null;
}

export function renderReport(report) {
  const { meta, primary, secondary, diagnostics } = report;
  const lines = [
    '# redteam-probe-v1: the red team after a stored Stage 2',
    '',
    `Source: stored Stage 1 and Stage 2 of \`${meta.source}\`, routes \`${meta.routes}\`; protocol \`${PROTOCOL}\`. Every number below is computed by \`redTeamProbe.js\`.`,
    '',
    `Questions: ${meta.measured} of ${meta.planned} measured in the seeded order (${meta.complete ? 'complete' : 'interim'}). States: ${Object.entries(meta.states).map(([key, value]) => `${key} ${value}`).join(', ')}.`,
    '',
    '## Primary pair: Rc - C',
    '',
    `Accuracy: C ${pct(primary.accuracy.C)}, Rc ${pct(primary.accuracy.Rc)} (n = ${primary.n}).`,
    `Rc - C: ${pp(primary.delta)}. Wins / losses: ${primary.wins} / ${primary.losses}. Ties: ${primary.constructionTies} by construction (Rc's request equal to C's), ${primary.observedTies} observed. Changed requests: ${primary.changedRequests}.`,
    `Exact McNemar p: ${primary.n ? primary.p.toFixed(4) : 'n/a'}. Paired bootstrap within blocks: 95% CI ${bound(primary.interval)}, 90% CI ${bound(primary.interval90)}.`,
    ...primary.reading.map((line) => `Reading: ${line}.`),
    '',
    '## Secondary family (one Holm correction)',
    '',
    '| Comparison | n | Δ | W / L / T | McNemar p | Holm p | 95% CI |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...secondary.map((item) => `| ${item.name} | ${item.n} | ${item.n ? pp(item.delta) : 'N/A'} | ${item.n ? `${item.wins} / ${item.losses} / ${item.ties}` : ''} | ${item.n ? item.p.toFixed(4) : 'kept at 1'} | ${item.holm.toFixed(4)} | ${item.n ? bound(item.interval) : ''} |`),
    '',
    `Rp coverage on the measured questions: ${Object.entries(meta.productCoverage).map(([key, value]) => `${key} ${value}`).join(', ') || 'none'}.`,
    '',
    '## Diagnostics (no new calls)',
    '',
    'How the RT calls ended, by model:',
    '',
    ...Object.entries(diagnostics.rtEndings).map(([model, counts]) => `- ${model}: ${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(', ')}`),
    '',
    `Clean reading of the ${diagnostics.readings.replies} replies that ended with \`stop\`: template lines removed ${diagnostics.readings.templates}, earlier duplicate service lines removed ${diagnostics.readings.duplicates}, confidence outside 0..10 ${diagnostics.readings.invalidConfidence}, other VERDICT-like lines ${diagnostics.readings.otherVerdictLike}, admitted without a verdict ${diagnostics.readings.noVerdict}.`,
    `Clean object: ${Object.entries(diagnostics.cleanVerdicts).map(([key, value]) => `${key} ${value}`).join(', ')}.`,
    `Product object: ${Object.entries(diagnostics.productVerdicts).map(([key, value]) => `${key} ${value}`).join(', ')}. Product and clean verdict differ: ${diagnostics.firstLastDiffer}.`,
    '',
    '| Clean red team | Questions | Leader right | C right | Rc right | Fixed | Broke |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...Object.entries(diagnostics.byVerdict).sort().map(([key, entry]) => `| ${key} | ${entry.n} | ${entry.leaderRight} | ${entry.cRight} | ${entry.rcRight} | ${entry.fixed} | ${entry.broke} |`),
    '',
    `Council confidence on the measured questions: C ${Object.entries(diagnostics.levels.C).map(([key, value]) => `${key} ${value}`).join(', ')}; Rc ${Object.entries(diagnostics.levels.Rc).map(([key, value]) => `${key} ${value}`).join(', ')}.`,
    '',
    '| Block | n | C right | Rc right | Wins / losses |',
    '| --- | --- | --- | --- | --- |',
    ...Object.entries(diagnostics.blocks).sort().map(([block, entry]) => `| ${block} | ${entry.n} | ${entry.c} | ${entry.rc} | ${entry.wins} / ${entry.losses} |`),
    '',
    `Questions whose Stage 2 leader was cut in its reasoning: ${diagnostics.cutLeader.n}, wins / losses ${diagnostics.cutLeader.wins} / ${diagnostics.cutLeader.losses}.`,
    `Under \`${WIDE_GOLD_FILE}\`: n ${diagnostics.wideGold.n}, Rc - C ${pp(diagnostics.wideGold.delta)}, wins / losses ${diagnostics.wideGold.wins} / ${diagnostics.wideGold.losses}, p ${diagnostics.wideGold.n ? diagnostics.wideGold.p.toFixed(4) : 'n/a'}.`,
    '',
    '## Cost',
    '',
    '| Branch | Calls | POSTs | Cost | Mean s | Mean completion tokens |',
    '| --- | --- | --- | --- | --- | --- |',
    ...Object.entries(diagnostics.money).map(([branch, row]) => `| ${branch} | ${row.calls} | ${row.posts} | ${usd4(row.usd)} | ${row.meanSeconds == null ? 'n/a' : row.meanSeconds.toFixed(0)} | ${row.meanCompletionTokens == null ? 'n/a' : row.meanCompletionTokens.toFixed(0)} |`),
    '',
    `Cost of the policy itself (RT plus one chairman call per measured question): ${usd4(diagnostics.policyUsd)}.`,
    `Probe budget journal: settled ${usd4(meta.spend.settledUsd)}, held ${usd4(meta.spend.heldUsd)}, ${meta.spend.posts} POSTs; limits $${LIMITS.maxUsd} and ${LIMITS.maxPosts}. Frozen at ${meta.frozen ? meta.frozen.slice(0, 12) : 'n/a'}.`,
  ];
  return lines.join('\n');
}

export async function runReport(paths = probePaths()) {
  const report = await buildReport(paths);
  writeJson(paths.report, report);
  writeFileSync(paths.reportMd, `${renderReport(report)}\n`, 'utf8');
  console.log(`report written: ${paths.reportMd}`);
  console.log(`primary: ${report.meta.measured} of ${report.meta.planned} measured; Rc - C ${pp(report.primary.delta)}, ${report.primary.wins} / ${report.primary.losses}`);
  return 0;
}

export async function runInspect(paths = probePaths()) {
  const test = loadSource('test');
  const pilot = loadSource('pilot');
  const preflight = probeRoutes();
  const inspected = await inspectAll(test, pilot, preflight);
  const { gold, ids } = scoringSet(test);
  const storedA8 = applyGoldOverrides(test.rows.filter((row) => ids.includes(row.id)), Object.fromEntries(gold.gold)).rows
    .filter((row) => row.arms?.A8?.correct === 1).length;
  const record = {
    test: { ...inspected.test, prompts: undefined }, pilot: { ...inspected.pilot, prompts: undefined },
    scoring: { ids: ids.length, excluded: [...gold.excluded], storedA8Right: storedA8, legacy: test.rows.filter((row) => ids.includes(row.id) && LEGACY_BLOCKS.includes(row.block)).length },
    smokeIds: inspected.smokeIds, orderDigest: sha256(inspected.order.join('\n')),
    worstUsd: inspected.test.worstUsd,
  };
  writeJson(paths.inspect, record);
  console.log(JSON.stringify(record, null, 2));
  return inspected.test.g0.differ.length || inspected.pilot.g0.differ.length ? 3 : 0;
}
