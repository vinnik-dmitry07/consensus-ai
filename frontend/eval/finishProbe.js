// Probe: can a short extra call recover a final answer from a saved reasoning
// that was cut at the token cap or by the loop guard? It reads a finished
// campaign, never writes to it, and keeps its own journal and budget. See
// finish-probe-protocol.md for the rules and thresholds fixed before the run.

import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { queryModelResult } from '../src/engine/browser/openrouter.js';
import { settings } from '../src/engine/browser/settings.js';
import {
  gitState, goldOverridesFrom, prepareFor, reconcileBudget, sourceHash,
} from './a8.js';
import { extensionItemId, loadExtensionBank } from './a8Prepare.js';
import { applyGoldOverrides, comparePair } from './a8Report.js';
import { cutReasoning } from './a8Variants.js';
import { BudgetPaused, createCampaignBudget } from './budget.js';
import { taskPublicId } from './datasets.js';
import { answerPrompt, canonAnswer, gradeResponse, plurality } from './grade.js';
import { isEvalInvariant } from './invariant.js';
import { PLURALITY_SEED } from './protocol.js';
import { runIsolated } from './questionScope.js';
import { createSession, readSlotJournal, snapshotLocal } from './runtime.js';
import { installTransport } from './transport.js';
import { compareHash, sha256 } from './util.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(EVAL_ROOT, '.runs');
const KEY_URL = 'https://openrouter.ai/api/v1/key';

export const FINISH_LIMITS = Object.freeze({ maxUsd: 10, maxPosts: 500 });
export const BASE_CAP = 2048;
export const RAISED_CAP = 4096;
export const TAIL_CHARS = 8000;
export const CONCURRENCY = 3;
export const STREAM_SECONDS = 900;
export const STAGE = 'finish';
export const CONDITIONS = Object.freeze(['F', 'T', 'C']);
export const ORDER_SEED = 'finish-probe-v1-order';
export const PILOT_SEED = 'finish-probe-v1-pilot';
export const RAISE_ABOVE = 0.2;
export const PILOT_PER_ROUTE = 4;
const GOLD_FILE = 'gold-corrections-a8-open-v5e.json';
const SUBSET_FILE = 'finish-probe-subset.json';
const LABELS_FILE = 'finish-probe-labels.json';
const PROTOCOL_FILE = 'finish-probe-protocol.md';
// Questions whose reading the blind review called ambiguous.
export const SENSITIVITY_DROP = Object.freeze([
  'test:hmmt_feb_2026:17',
  'test:livemath-202505:q752db7fa88d7',
]);
// What the probe depends on beyond the campaign method's own source hash.
const PROBE_FILES = ['finishProbe.js', 'finishProbe.test.js', 'run.js', PROTOCOL_FILE, LABELS_FILE, SUBSET_FILE, GOLD_FILE];

export const FINISH_INSTRUCTION = [
  'Using the unfinished reasoning above, give the answer it currently',
  'supports best. Do not continue the derivation, restart the solution,',
  'or provide a proof. If several answers remain, select the most likely one.',
  'Return only one non-empty final line in the answer format required above:',
  'ANSWER: <answer>',
].join('\n');

export const CONTROL_INSTRUCTION = [
  'Give your best answer now. Do not derive it at length or provide a proof. If several answers seem possible, select the most likely one.',
  'Return only one non-empty final line in the answer format required above:',
  'ANSWER: <answer>',
].join('\n');

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

function fileSha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : (argv[index + 1] ?? null);
}

// The message reads only the wording of the task, never its gold.
export function finishMessage(task, condition, text) {
  const head = answerPrompt({ kind: task.kind, stem: task.stem, options: task.options });
  if (condition === 'C') return `${head}\n\n${CONTROL_INSTRUCTION}`;
  const body = condition === 'T' ? String(text).slice(-TAIL_CHARS) : String(text);
  return `${head}\n\nUnfinished reasoning:\n<<<\n${body}\n>>>\n\n${FINISH_INSTRUCTION}`;
}

export function slotResultOf(slot) {
  if (!slot?.result) return null;
  return { ...slot.result, finishReason: slot.result.finishReason ?? slot.finishReason ?? null };
}

// A call that was used by a question. With a known text the text decides, so
// an older slot under another request hash cannot be taken for it.
export function usedSlot(list, text = null) {
  const done = list.filter((slot) => slot.state === 'completed');
  if (text != null) return done.find((slot) => (slot.result?.content || '') === text) || null;
  const contents = new Set(done.map((slot) => slot.result?.content || ''));
  if (contents.size > 1) throw new Error(`Several different answers for ${done[0].meta.questionId} ${done[0].meta.model}`);
  return done[0] || null;
}

function sourceRow(row, role, model, slot, sample, kind, task) {
  const result = slotResultOf(slot);
  if (!cutReasoning(result)) return null;
  const text = result.content || '';
  return {
    id: `${row.id}|${role}`,
    questionId: row.id,
    block: row.block,
    role,
    model,
    sample,
    kind,
    text,
    textSha: sha256(text),
    finishReason: result.finishReason,
    alreadyAccepted: gradeResponse(task, text).status === 'graded',
  };
}

export function collectSources({ rows, slots, councilModels, bModel, chairmanModel, tasks }) {
  const byQuestion = new Map();
  for (const slot of slots) {
    const id = slot.meta?.questionId;
    if (!id) continue;
    if (!byQuestion.has(id)) byQuestion.set(id, []);
    byQuestion.get(id).push(slot);
  }
  const sources = [];
  for (const row of rows) {
    const list = byQuestion.get(row.id) || [];
    const task = tasks.get(row.id);
    const of = (branch, stage, sample, model) => list.filter((slot) => (
      slot.meta.branch === branch && slot.meta.stage === stage && slot.meta.sample === sample && slot.meta.model === model
    ));
    councilModels.forEach((model, index) => {
      const text = model === bModel ? (row.diagnostics?.replicateTexts?.[0] ?? null) : null;
      const made = sourceRow(row, `council:${model}`, model, usedSlot(of('council', 'stage1', 1, model), text), 11 + index, 'input', task);
      if (made) sources.push(made);
    });
    for (let sample = 2; sample <= 5; sample += 1) {
      const text = row.diagnostics?.replicateTexts?.[sample - 1] ?? null;
      const made = sourceRow(row, `sample:${sample}`, bModel, usedSlot(of('replicates', 'sample', sample, bModel), text), sample, 'input', task);
      if (made) sources.push(made);
    }
    [['A8', 21], ['S8', 22]].forEach(([arm, sample]) => {
      const made = sourceRow(row, `synthesis:${arm}`, chairmanModel, usedSlot(of(arm, 'stage3', 1, chairmanModel), row.arms?.[arm]?.text ?? ''), sample, 'synthesis', task);
      if (made) sources.push(made);
    });
  }
  return sources;
}

// diagnostics.leader keeps the grade, not the call. Candidate #1 in the
// chairman's request shows whose text it was.
export function leaderRole(prompt, councilSources) {
  const text = String(prompt || '');
  const start = text.indexOf('Candidate #1 (');
  if (start < 0) return null;
  const end = text.indexOf('Candidate #2 (', start);
  const segment = text.slice(start, end > 0 ? end : undefined);
  const hits = councilSources.filter((source) => segment.includes(source.text.slice(-500)));
  return hits.length === 1 ? hits[0].role : null;
}

function rank(seed, id) {
  return sha256(`${seed}\n${id}`);
}

function cellOf(source, condition) {
  return {
    id: `${source.id}|${condition}`,
    sourceId: source.id,
    source,
    condition,
    questionId: source.questionId,
    branch: `finish-${condition}`,
    stage: STAGE,
    sample: source.sample,
    model: source.model,
  };
}

// Sources in a fixed mixed order, conditions of one source next to each
// other, so a provider outage does not fall on one condition. Originals first.
export function orderCells(sources, seed = ORDER_SEED, conditions = CONDITIONS) {
  const byRank = (list) => [...list].sort((left, right) => rank(seed, left.id).localeCompare(rank(seed, right.id)));
  const cells = [];
  for (const source of byRank(sources.filter((item) => item.kind === 'input'))) {
    const order = [...conditions].sort((left, right) => rank(seed, `${source.id}\n${left}`).localeCompare(rank(seed, `${source.id}\n${right}`)));
    for (const condition of order) cells.push(cellOf(source, condition));
  }
  for (const source of byRank(sources.filter((item) => item.kind === 'synthesis'))) {
    cells.push(cellOf(source, 'F'));
  }
  return cells;
}

export function minimalEffort(route) {
  const efforts = route?.catalogue?.reasoning?.supported_efforts || [];
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high']) {
    if (efforts.includes(effort)) return effort;
  }
  return null;
}

export function probeRoutes(routes) {
  const out = {};
  for (const route of routes) {
    const effort = minimalEffort(route);
    out[route.id] = {
      ...route,
      reasoning: effort ? { effort } : null,
      provider: { ...route.provider, require_parameters: true },
    };
  }
  return out;
}

// prepareFor sets one cap per stage. The cap here is set per route.
export function prepareProbe(routes, capOf) {
  return (model, stage, options) => prepareFor({
    caps: { [STAGE]: capOf(model) },
    timeout: STREAM_SECONDS,
    loopGuard: null,
    annotate: true,
    contextCheck: false,
    routes,
  })(model, stage, options);
}

export function cellKey(meta) {
  return `${meta.questionId}|${meta.branch}|${meta.sample}|${meta.model}`;
}

function slotIndex(slots) {
  const map = new Map();
  for (const slot of slots) if (slot.meta?.stage === STAGE) map.set(cellKey(slot.meta), slot);
  return map;
}

// done: an answer is stored. failed: the call ended without one. unknown: a
// POST left no outcome, so it may have run and is not sent again by itself.
// pending: nothing was generated yet, including a refusal waiting a cooldown.
export function cellState(slot) {
  if (!slot) return 'pending';
  if (slot.state === 'completed') return 'done';
  if (slot.state === 'failed') return 'failed';
  if ((slot.cutAttempts || 0) > 0) return 'unknown';
  if (slot.state === 'skipped' || slot.state === 'pending') return 'pending';
  return 'unknown';
}

export function acceptFinish(task, slot) {
  const state = cellState(slot);
  if (state !== 'done') return { state, accepted: false, extracted: null, correct: 0, reason: state };
  const result = slotResultOf(slot);
  const base = { state, accepted: false, extracted: null, correct: 0, finishReason: result?.finishReason ?? null };
  if (!result?.ok) return { ...base, reason: 'failed' };
  if (result.finishReason === 'length' || result.finishReason === 'loop') return { ...base, reason: 'cut' };
  if (result.contentFromReasoning === true) return { ...base, reason: 'from_reasoning' };
  const grade = gradeResponse(task, result.content || '');
  if (grade.status !== 'graded') return { ...base, reason: grade.status };
  return { ...base, accepted: true, extracted: grade.extracted, correct: grade.correct, reason: 'accepted' };
}

// One pass over the cells. A cell already answered, failed, or unknown is not
// sent. A refused cell stays pending for the next launch. Returns what is left.
export async function runCells({ cells, tasks, session, concurrency = CONCURRENCY }) {
  const base = snapshotLocal();
  let next = 0;
  let stop = false;
  const worker = async (index) => {
    for (;;) {
      if (stop || session.budget.state.paused) return;
      const cell = cells[next];
      if (!cell) return;
      next += 1;
      const known = slotIndex(session.slots()).get(cellKey(cell));
      if (cellState(known) !== 'pending') continue;
      try {
        await runIsolated(base, index, async () => {
          session.setContext({
            questionId: cell.questionId, branch: cell.branch, stage: cell.stage, sample: cell.sample, model: cell.model,
          });
          const content = finishMessage(tasks.get(cell.questionId), cell.condition, cell.source.text);
          await queryModelResult(cell.model, [{ role: 'user', content }]);
          await session.drain();
        });
      } catch (error) {
        if (isEvalInvariant(error)) throw error;
        if (error instanceof BudgetPaused) {
          stop = true;
          return;
        }
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, (_, index) => worker(index)));
  const index = slotIndex(session.slots());
  const states = {};
  for (const cell of cells) {
    const state = cellState(index.get(cellKey(cell)));
    states[state] = (states[state] || 0) + 1;
  }
  return states;
}

export function outcomesOf(cells, tasks, slots) {
  const index = slotIndex(slots);
  const out = new Map();
  for (const cell of cells) {
    const slot = index.get(cellKey(cell));
    out.set(cell.id, {
      ...acceptFinish(tasks.get(cell.questionId), slot),
      promptTokens: slot?.usage?.prompt_tokens ?? null,
      completionTokens: slot?.usage?.completion_tokens ?? null,
      cost: slot?.usage?.cost ?? null,
      serviceMs: slot?.serviceMs ?? null,
    });
  }
  return out;
}

// Votes and fallbacks.

function pickFor(id) {
  return (tied) => [...tied].sort((left, right) => compareHash(`${PLURALITY_SEED}\n${id}`, left, right))[0];
}

export function voteOf(id, answers) {
  return plurality(answers.map((answer) => (answer == null ? { status: 'parse_error' } : { status: 'graded', extracted: answer })), pickFor(id));
}

function gradeOf(extracted, gold) {
  return extracted == null
    ? { correct: 0, status: 'no_answer', extracted: null }
    : { correct: extracted === gold ? 1 : 0, status: 'graded', extracted };
}

function merged(real, forced) {
  return real.map((answer, index) => answer ?? forced[index]);
}

export const POLICIES = Object.freeze(['original', 'fallback', 'fill', 'all']);

// ctx: { gold, councilModels, bModel, leaderRole, a8Cut, s8Cut }. `forced` maps
// a source id to the accepted extra answer, or to nothing. Arms keep what they
// had unless they have no answer: no policy here replaces an accepted answer.
export function policyArms(row, ctx, policy, forced = new Map()) {
  const { arms, diagnostics: d } = row;
  const { gold } = ctx;
  const out = { A8: arms.A8, S8: arms.S8, P8: arms.P8, B8: arms.B8, V5: d.replicateVote, undetermined: false };
  if (policy === 'original') return out;
  const realC = d.councilAnswers;
  const realR = d.replicateAnswers;
  const fa = (role) => forced.get(`${row.id}|${role}`) ?? null;
  const forcedC = ctx.councilModels.map((model, index) => (realC[index] == null ? fa(`council:${model}`) : null));
  const forcedR = realR.map((answer, index) => (answer != null ? null : fa(index === 0 ? `council:${ctx.bModel}` : `sample:${index + 1}`)));
  const usesForced = policy === 'fill' || policy === 'all';
  const votePick = (id, real, extra) => {
    const finished = voteOf(id, real);
    if (policy === 'fallback' || policy === 'fill') {
      if (finished.status === 'graded' || policy === 'fallback') return finished;
      return voteOf(id, extra);
    }
    return voteOf(id, merged(real, extra));
  };
  if (ctx.a8Cut && arms.A8.status !== 'graded') {
    if (d.leader?.status === 'graded') out.A8 = gradeOf(d.leader.extracted, gold);
    else if (usesForced) {
      if (ctx.leaderRole) out.A8 = gradeOf(fa(ctx.leaderRole), gold);
      else out.undetermined = true;
    }
  }
  if (ctx.s8Cut && arms.S8.status !== 'graded') {
    const pick = votePick(row.id, realR, forcedR);
    out.S8 = gradeOf(pick.status === 'graded' ? pick.extracted : null, gold);
  }
  if (!usesForced) return out;
  if (arms.B8.status !== 'graded' && forcedR[0] != null) out.B8 = gradeOf(forcedR[0], gold);
  const voted = (grade, real, extra) => {
    if (grade?.status === 'not_run') return grade;
    const pick = votePick(row.id, real, extra);
    return gradeOf(pick.status === 'graded' ? pick.extracted : null, gold);
  };
  out.P8 = voted(arms.P8, realC, forcedC);
  out.V5 = voted(d.replicateVote, realR, forcedR);
  return out;
}

// Criteria.

function share(items, hit) {
  return items.length ? items.filter(hit).length / items.length : null;
}

function byQuestionMean(items, value) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.questionId)) groups.set(item.questionId, []);
    groups.get(item.questionId).push(value(item));
  }
  if (!groups.size) return null;
  let sum = 0;
  for (const list of groups.values()) sum += list.reduce((a, b) => a + b, 0) / list.length;
  return sum / groups.size;
}

const INCOMPLETE = new Set(['pending', 'unknown', 'failed']);

function shareRule(items, outcome, threshold) {
  const correct = items.filter((item) => outcome(item).correct === 1).length;
  const need = Math.ceil(threshold * items.length);
  const mean = byQuestionMean(items, (item) => outcome(item).correct);
  const incomplete = items.filter((item) => INCOMPLETE.has(outcome(item).state)).length;
  let verdict;
  if (!items.length) verdict = 'fail';
  else if (incomplete) verdict = 'undetermined';
  else verdict = correct >= need && mean >= threshold ? 'pass' : 'fail';
  return { n: items.length, correct, need, questionMean: mean, incomplete, verdict };
}

// `labels` maps a source id to its final group. Unlabelled texts have none.
export function evaluateCriteria({ inputs, outcome, labels, models }) {
  const of = (item, condition) => outcome(`${item.id}|${condition}`) || { state: 'pending', correct: 0, accepted: false };
  const f = (item) => of(item, 'F');
  const c = (item) => of(item, 'C');
  const c1 = {};
  let c1Verdict = 'pass';
  for (const model of models) {
    const list = inputs.filter((item) => item.model === model);
    const accepted = list.filter((item) => f(item).accepted).length;
    const incomplete = list.filter((item) => INCOMPLETE.has(f(item).state)).length;
    const verdict = !list.length || incomplete ? 'undetermined' : (accepted / list.length >= 0.9 ? 'pass' : 'fail');
    c1[model] = { n: list.length, accepted, incomplete, verdict };
    if (verdict === 'fail') c1Verdict = 'fail';
    else if (verdict === 'undetermined' && c1Verdict !== 'fail') c1Verdict = 'undetermined';
  }
  const firm = inputs.filter((item) => labels.get(item.id) === 'firm');
  const both = inputs.filter((item) => ['firm', 'candidate'].includes(labels.get(item.id)));
  const c2 = shareRule(firm, f, 0.8);
  const c3 = shareRule(both, f, 0.5);
  const margin = 10 / 115;
  const fRate = share(inputs, (item) => f(item).correct === 1);
  const cRate = share(inputs, (item) => c(item).correct === 1);
  const meanDiff = byQuestionMean(inputs, (item) => f(item).correct - c(item).correct);
  const incomplete4 = inputs.filter((item) => INCOMPLETE.has(f(item).state) || INCOMPLETE.has(c(item).state)).length;
  let c4Verdict;
  if (!inputs.length) c4Verdict = 'fail';
  else if (incomplete4) c4Verdict = 'undetermined';
  else c4Verdict = (fRate - cRate >= margin && meanDiff >= margin) ? 'pass' : 'fail';
  const c4 = { fRate, cRate, difference: inputs.length ? fRate - cRate : null, questionMeanDifference: meanDiff, margin, incomplete: incomplete4, verdict: c4Verdict };
  return { c1: { models: c1, verdict: c1Verdict }, c2, c3, c4, decision: decide(c1Verdict, c2.verdict, c3.verdict, c4Verdict) };
}

export function decide(c1, c2, c3, c4) {
  const core = [c1, c2, c3];
  if (core.includes('fail')) return 'no change: at least one of criteria 1-3 failed';
  if (core.includes('undetermined') || c4 === 'undetermined') return 'undetermined: the set is incomplete';
  if (c4 === 'fail') return 'the contribution of the reasoning is not shown; plain re-asking would be a separate decision';
  return 'recommend a confirming measurement with the fill policy';
}

// Which single question, when left out, flips a text-level criterion.
export function leaveOneOut({ inputs, outcome, labels, models }) {
  const base = evaluateCriteria({ inputs, outcome, labels, models });
  const questions = [...new Set(inputs.map((item) => item.questionId))];
  const flips = [];
  for (const question of questions) {
    const rest = evaluateCriteria({ inputs: inputs.filter((item) => item.questionId !== question), outcome, labels, models });
    for (const name of ['c2', 'c3', 'c4']) {
      if (rest[name].verdict !== base[name].verdict) flips.push({ question, criterion: name, from: base[name].verdict, to: rest[name].verdict });
    }
  }
  return flips;
}

// Label step.

export function excerpts(text, tail = TAIL_CHARS, count = 30, half = 120) {
  const source = String(text);
  const hits = [...source.matchAll(/\b(?:answer|final)\b/gi)].map((match) => match.index);
  const chosen = [];
  if (hits.length <= count) chosen.push(...hits);
  else for (let i = 0; i < count; i += 1) chosen.push(hits[Math.floor((i * (hits.length - 1)) / (count - 1))]);
  return {
    chars: source.length,
    tail: source.slice(-tail),
    fragments: chosen.map((at) => ({ at: Number((at / Math.max(1, source.length)).toFixed(3)), text: source.slice(Math.max(0, at - half), at + half) })),
  };
}

export function groupFrom(annotation, gold, task) {
  const canon = (value) => canonAnswer(String(value).trim(), task);
  const values = (annotation.values || []).map(canon).filter((value) => value != null);
  const earlier = (annotation.earlier || []).map(canon).filter((value) => value != null);
  if (annotation.status === 'accepted' && values.includes(gold)) return 'firm';
  if (annotation.status === 'leading' && values.includes(gold)) return 'candidate';
  if (earlier.includes(gold) && !values.includes(gold)) return 'switched';
  return 'none';
}

export function mergeLabels(subset, sourcesById, tasks, passA, passB) {
  const a = new Map(passA.map((row) => [row.cell, row]));
  const b = new Map(passB.map((row) => [row.cell, row]));
  const items = subset.map((id) => {
    const source = sourcesById.get(id);
    if (!source) throw new Error(`Labelled text ${id} is not among the sources`);
    if (!a.has(id) || !b.has(id)) throw new Error(`Labelled text ${id} is missing from a pass`);
    const task = tasks.get(source.questionId);
    const gold = task.goldCanon;
    const groupA = groupFrom(a.get(id), gold, task);
    const groupB = groupFrom(b.get(id), gold, task);
    const single = (row) => {
      if (row.status !== 'accepted') return null;
      const values = (row.values || []).map((value) => canonAnswer(String(value).trim(), task)).filter((value) => value != null);
      return values.length === 1 ? values[0] : null;
    };
    const left = single(a.get(id));
    const right = single(b.get(id));
    return {
      cell: id,
      textSha: source.textSha,
      passA: { status: a.get(id).status, values: a.get(id).values || [], earlier: a.get(id).earlier || [] },
      passB: { status: b.get(id).status, values: b.get(id).values || [], earlier: b.get(id).earlier || [] },
      groupA,
      groupB,
      group: groupA === groupB ? groupA : 'candidate',
      agreedAccepted: left != null && left === right ? left : null,
    };
  });
  return items;
}

// Loading.

export function loadTasks() {
  const tasks = new Map();
  const bank = readJson(path.join(EVAL_ROOT, '.cache', 'bank.json'));
  for (const item of bank.items) {
    const id = `${item.split}:${taskPublicId(item)}`;
    tasks.set(id, { ...item, id });
  }
  for (const item of loadExtensionBank().items) {
    const id = extensionItemId(item);
    tasks.set(id, { ...item, id });
  }
  return tasks;
}

function sourceRun(runId) {
  const dir = path.join(RUNS_ROOT, runId);
  return {
    dir,
    events: path.join(dir, 'comparison', 'test', 'events.jsonl'),
    questions: path.join(dir, 'comparison', 'test'),
    devEvents: path.join(dir, 'dev', 'events.jsonl'),
    selection: path.join(dir, 'selection.json'),
    campaign: path.join(dir, 'campaign.json'),
    corrected: path.join(dir, 'reports', 'report-corrected.md'),
  };
}

function loadRows(paths) {
  const rows = [];
  for (const name of readdirSync(paths.questions)) {
    if (!name.endsWith('.json') || ['order.json', 'runner.json', 'cooldowns.json'].includes(name)) continue;
    const row = readJson(path.join(paths.questions, name));
    if (row?.id && row.status === 'complete' && row.arms) rows.push(row);
  }
  return rows;
}

function loadSource(sourceRunId) {
  const paths = sourceRun(sourceRunId);
  const selection = readJson(paths.selection);
  const campaign = readJson(paths.campaign);
  const raw = loadTasks();
  const goldPath = path.join(EVAL_ROOT, GOLD_FILE);
  const overrides = goldOverridesFrom(['--gold-overrides', goldPath], raw);
  const excluded = new Set(overrides.excluded);
  const rows = applyGoldOverrides(loadRows(paths).filter((row) => !excluded.has(row.id)), overrides.canonical).rows;
  // Corrected golds go into copies; the bank in memory stays as it was.
  const tasks = new Map();
  for (const [id, task] of raw) tasks.set(id, overrides.canonical[id] == null ? task : { ...task, goldCanon: overrides.canonical[id] });
  const slots = [...readSlotJournal(paths.events).values()];
  const context = { selection, campaign, councilModels: selection.council, bModel: selection.b, chairmanModel: selection.h };
  const sources = collectSources({ rows, slots, ...context, tasks });
  const ctx = rowContexts(rows, sources, slots, context, tasks);
  return { paths, ...context, tasks, rows, slots, sources, ctx, overrides };
}

function rowContexts(rows, sources, slots, { councilModels, bModel, chairmanModel }, tasks) {
  const out = new Map();
  for (const row of rows) {
    const mine = sources.filter((source) => source.questionId === row.id);
    const a8Cut = mine.some((source) => source.role === 'synthesis:A8');
    const s8Cut = mine.some((source) => source.role === 'synthesis:S8');
    let role = null;
    if (a8Cut && row.diagnostics?.leader?.status !== 'graded') {
      const request = usedSlot(slots.filter((slot) => slot.meta?.questionId === row.id && slot.meta.branch === 'A8' && slot.meta.stage === 'stage3' && slot.meta.model === chairmanModel), row.arms.A8.text ?? '');
      role = leaderRole(request?.request?.messages?.[0]?.content, mine.filter((source) => source.role.startsWith('council:')));
    }
    out.set(row.id, { gold: tasks.get(row.id).goldCanon, councilModels, bModel, leaderRole: role, a8Cut, s8Cut });
  }
  return out;
}

function sourceHashes(paths) {
  const list = { events: paths.events, devEvents: paths.devEvents, selection: paths.selection, campaign: paths.campaign, corrected: paths.corrected, gold: path.join(EVAL_ROOT, GOLD_FILE) };
  return Object.fromEntries(Object.entries(list).map(([name, file]) => [name, fileSha(file)]));
}

function rateOf(rows, field) {
  const hit = rows.filter((row) => field(row)?.correct === 1 || (field(row)?.status === 'graded' && field(row)?.extracted === row.__gold)).length;
  return rows.length ? hit / rows.length : null;
}

// The primary-set values of report-corrected, read from its tables.
function expectedBaseline(file) {
  const text = readFileSync(file, 'utf8');
  const cell = (label) => {
    const line = text.split('\n').find((row) => row.startsWith(`| ${label} |`));
    return line ? Number(line.split('|')[2].trim().replace('%', '')) : null;
  };
  return { A8: cell('A8'), S8: cell('S8'), P8: cell('P8'), B8: cell('B8'), voteOfFive: cell("Vote of B's five samples"), leader: cell('Stage 2 leader') };
}

function inspectSource(source, runId) {
  const { rows, sources, campaign, tasks, ctx, paths } = source;
  const primary = new Set(campaign.primaryBlocks);
  const isPrimary = (row) => primary.has(row.block);
  const inputs = sources.filter((item) => item.kind === 'input');
  const syntheses = sources.filter((item) => item.kind === 'synthesis');
  const tagged = rows.map((row) => ({ ...row, __gold: tasks.get(row.id).goldCanon }));
  const main = tagged.filter(isPrimary);
  const toPct = (value) => (value == null ? null : Number((value * 100).toFixed(1)));
  const baseline = {
    A8: toPct(rateOf(main, (row) => row.arms.A8)),
    S8: toPct(rateOf(main, (row) => row.arms.S8)),
    P8: toPct(rateOf(main, (row) => row.arms.P8)),
    B8: toPct(rateOf(main, (row) => row.arms.B8)),
    voteOfFive: toPct(rateOf(main, (row) => row.diagnostics.replicateVote)),
    leader: toPct(rateOf(main, (row) => row.diagnostics.leader)),
  };
  const expected = expectedBaseline(paths.corrected);
  const mismatches = Object.keys(baseline).filter((key) => baseline[key] !== expected[key]);
  const byModel = {};
  for (const item of inputs) byModel[item.model] = (byModel[item.model] || 0) + 1;
  const subsetPath = path.join(EVAL_ROOT, SUBSET_FILE);
  const subset = readJson(subsetPath, []);
  const ids = new Set(sources.map((item) => item.id));
  const summary = {
    run: runId,
    rows: rows.length,
    primaryRows: main.length,
    legacyRows: rows.length - main.length,
    inputs: inputs.length,
    byModel,
    syntheses: syntheses.length,
    synthesesByArm: { A8: syntheses.filter((s) => s.role === 'synthesis:A8').length, S8: syntheses.filter((s) => s.role === 'synthesis:S8').length },
    questions: new Set(inputs.map((item) => item.questionId)).size,
    alreadyAccepted: sources.filter((item) => item.alreadyAccepted).length,
    subset: subset.length,
    subsetMissing: subset.filter((id) => !ids.has(id)),
    unlabelled: inputs.length - subset.length,
    leadersNeeded: [...ctx.values()].filter((row) => row.a8Cut).length,
    leadersUndetermined: rows.filter((row) => ctx.get(row.id).a8Cut && row.diagnostics.leader?.status !== 'graded' && !ctx.get(row.id).leaderRole).map((row) => row.id),
    baseline,
    expected,
    mismatches,
    sourceHashes: sourceHashes(paths),
    sourceDigest: sha256(sources.map((item) => `${item.id}\n${item.textSha}`).sort().join('\n')),
    methodSourceHash: campaign.sourceHash,
    probeCodeSourceHash: sourceHash(),
  };
  return summary;
}

// The paid side.

function probePaths(runId) {
  const dir = path.join(RUNS_ROOT, runId);
  return {
    dir,
    budget: path.join(dir, 'budget.jsonl'),
    manifest: path.join(dir, 'manifest.json'),
    settings: path.join(dir, 'settings.json'),
    inspect: path.join(dir, 'inspect.json'),
    round1: path.join(dir, 'pilot', 'round1'),
    round2: path.join(dir, 'pilot', 'round2'),
    main: path.join(dir, 'main'),
    report: path.join(dir, 'report.json'),
    reportMd: path.join(dir, 'report.md'),
  };
}

function openProbeBudget(paths, routes) {
  mkdirSync(paths.dir, { recursive: true });
  const prices = Object.fromEntries(routes.map((route) => [route.id, route.pricing]));
  const budget = createCampaignBudget({
    ...FINISH_LIMITS,
    prices,
    onEvent: (event) => appendFileSync(paths.budget, `${JSON.stringify(event)}\n`, 'utf8'),
  });
  budget.applyJournal(readJsonl(paths.budget));
  return budget;
}

function paidKey() {
  const key = String(process.env.or_key || process.env.OR_KEY || '').trim();
  if (!key) throw new Error('or_key is missing');
  return key;
}

async function audit(budget, phase, moment) {
  try {
    const response = await fetch(KEY_URL, { headers: { Authorization: `Bearer ${paidKey()}` } });
    const body = await response.json().catch(() => null);
    budget.audit({ phase, moment, status: response.status, usage: body?.data?.usage ?? null, limitRemaining: body?.data?.limit_remaining ?? null });
  } catch (error) {
    budget.audit({ phase, moment, error: error instanceof Error ? error.message : String(error) });
  }
}

function journalsUnder(paths) {
  return [paths.round1, paths.round2, paths.main].map((dir) => path.join(dir, 'events.jsonl')).filter((file) => existsSync(file));
}

function probeHash() {
  return sha256(PROBE_FILES.map((name) => `${name}\n${fileSha(path.join(EVAL_ROOT, name))}`).join('\n'));
}

function assertFrozen(paths, source) {
  const git = gitState(PROBE_FILES, EVAL_ROOT);
  if (git.error || git.dirty == null) throw new Error(`Cannot read git state: ${git.error}`);
  if (git.dirty.length) throw new Error(`Commit the probe files first: ${git.dirty.join(', ')}`);
  const inspect = inspectSource(source, path.basename(paths.dir));
  if (inspect.mismatches.length) throw new Error(`Baselines differ: ${inspect.mismatches.join(', ')}`);
  const labels = readJson(path.join(EVAL_ROOT, LABELS_FILE));
  if (!labels?.items?.length) throw new Error('No frozen labels.');
  const current = { probeHash: probeHash(), sourceDigest: inspect.sourceDigest, sourceHashes: inspect.sourceHashes };
  const manifest = readJson(paths.manifest);
  if (manifest?.frozen) {
    for (const key of ['probeHash', 'sourceDigest']) {
      if (manifest.frozen[key] !== current[key]) throw new Error(`The frozen ${key} changed since the first paid call.`);
    }
    return manifest;
  }
  const next = {
    sourceRun: inspect.run,
    frozen: { ...current, gitHead: git.head, frozenAt: new Date().toISOString(), methodSourceHash: inspect.methodSourceHash, probeCodeSourceHash: inspect.probeCodeSourceHash },
    limits: FINISH_LIMITS,
    orderSeed: ORDER_SEED,
    pilotSeed: PILOT_SEED,
    baseCap: BASE_CAP,
    raisedCap: RAISED_CAP,
  };
  writeJson(paths.manifest, next);
  return next;
}

function lock(dir) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'runner.lock');
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'));
    let alive = false;
    if (pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        alive = error?.code === 'EPERM';
      }
    }
    if (alive) throw new Error(`Another runner holds ${file}`);
  }
  writeFileSync(file, String(process.pid), 'utf8');
  return () => {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  };
}

async function withSession({ dir, paths, routes, routeMap, capOf, phase }, work) {
  settings.apiKey = paidKey();
  const budget = openProbeBudget(paths, routes);
  if (budget.unresolvedAttempts().length) {
    try {
      await reconcileBudget({ dir: paths.dir }, budget, { journals: journalsUnder(paths) });
    } catch (error) {
      console.log(`reconcile skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await audit(budget, phase, 'start');
  const session = createSession({
    runDir: dir,
    budget,
    prepareOptions: prepareProbe(routeMap, capOf),
    maxInFlight: CONCURRENCY,
    maxInFlightPerModel: CONCURRENCY,
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
    console.log(`budget: settled $${budget.state.settledUsd.toFixed(4)}, held $${budget.state.unresolvedUsd.toFixed(4)}, ${budget.state.posts} POSTs`);
  }
}

function devSources(source) {
  const slots = [...readSlotJournal(source.paths.devEvents).values()];
  const out = [];
  for (const slot of slots) {
    const result = slotResultOf(slot);
    if (!cutReasoning(result) || !source.councilModels.includes(slot.meta.model)) continue;
    const index = source.councilModels.indexOf(slot.meta.model);
    const role = `council:${slot.meta.model}`;
    const text = result.content || '';
    out.push({
      id: `${slot.meta.questionId}|${role}`, questionId: slot.meta.questionId, block: null, role, model: slot.meta.model, sample: 11 + index, kind: 'input', text, textSha: sha256(text), finishReason: result.finishReason, fromDev: true,
    });
  }
  return out;
}

// Every dev text of a route first, then test texts in hash order from
// questions the route does not have yet. Groups and correctness play no part.
export function pilotSources(dev, inputs, models, perRoute = PILOT_PER_ROUTE, seed = PILOT_SEED) {
  const chosen = [];
  for (const model of models) {
    const mine = dev.filter((item) => item.model === model).slice(0, perRoute);
    const used = new Set(mine.map((item) => item.questionId));
    const extra = inputs
      .filter((item) => item.model === model)
      .sort((left, right) => rank(seed, left.id).localeCompare(rank(seed, right.id)));
    for (const item of extra) {
      if (mine.length >= perRoute) break;
      if (used.has(item.questionId)) continue;
      used.add(item.questionId);
      mine.push(item);
    }
    chosen.push(...mine);
  }
  return chosen;
}

// How the pilot reads a call: delivery and form only. Correctness is not
// computed, because tasks carry no gold here.
export function pilotRow(cells, slots, tasks) {
  const index = slotIndex(slots);
  const models = {};
  for (const cell of cells) {
    const slot = index.get(cellKey(cell));
    const task = { ...tasks.get(cell.questionId), goldCanon: null };
    const out = acceptFinish(task, slot);
    const row = models[cell.model] ||= { F: { n: 0, length: 0, accepted: 0 }, T: { n: 0, length: 0, accepted: 0 }, C: { n: 0, length: 0, accepted: 0 }, reasons: {}, unresolved: 0, tokens: 0 };
    const place = row[cell.condition];
    place.n += 1;
    if (out.state !== 'done') row.unresolved += 1;
    if (out.finishReason === 'length') place.length += 1;
    if (out.accepted) place.accepted += 1;
    row.reasons[out.reason] = (row.reasons[out.reason] || 0) + 1;
    row.tokens += Number(slot?.usage?.completion_tokens || 0);
  }
  return models;
}

export function raisedRoutes(rows, threshold = RAISE_ABOVE) {
  return Object.entries(rows).filter(([, row]) => row.F.n > 0 && row.F.length / row.F.n > threshold).map(([model]) => model);
}

async function runPilot(paths, source, routes, routeMap) {
  const models = source.councilModels;
  const inputs = source.sources.filter((item) => item.kind === 'input');
  const chosen = pilotSources(devSources(source), inputs, models);
  const cells = orderCells(chosen, PILOT_SEED);
  const flat = () => ({ ...Object.fromEntries(models.map((model) => [model, BASE_CAP])) });
  const first = await withSession({ dir: paths.round1, paths, routes, routeMap, capOf: (model) => flat()[model], phase: 'pilot-1' }, async (session) => {
    const states = await runCells({ cells, tasks: source.tasks, session });
    return { states, rows: pilotRow(cells, session.slots(), source.tasks) };
  });
  console.log(`pilot round 1: ${JSON.stringify(first.states)}`);
  console.log(JSON.stringify(first.rows, null, 2));
  if (first.states.pending) return 2;
  if (first.states.unknown) {
    console.log('pilot: a call left no recorded outcome and is not sent again. The experiment stops here.');
    return 3;
  }
  const raised = raisedRoutes(first.rows);
  const caps = flat();
  for (const model of raised) caps[model] = RAISED_CAP;
  let finalRows = first.rows;
  if (raised.length) {
    const again = cells.filter((cell) => raised.includes(cell.model));
    const second = await withSession({ dir: paths.round2, paths, routes, routeMap, capOf: (model) => caps[model], phase: 'pilot-2' }, async (session) => {
      const states = await runCells({ cells: again, tasks: source.tasks, session });
      return { states, rows: pilotRow(again, session.slots(), source.tasks) };
    });
    console.log(`pilot round 2 (${raised.join(', ')} at ${RAISED_CAP}): ${JSON.stringify(second.states)}`);
    console.log(JSON.stringify(second.rows, null, 2));
    if (second.states.pending) return 2;
    if (second.states.unknown) {
      console.log('pilot: a call left no recorded outcome and is not sent again. The experiment stops here.');
      return 3;
    }
    finalRows = { ...first.rows, ...second.rows };
  }
  const dead = models.filter((model) => !finalRows[model] || finalRows[model].F.accepted === 0);
  if (dead.length) {
    console.log(`pilot: no accepted answer on ${dead.join(', ')}. The experiment stops here.`);
    return 3;
  }
  writeJson(paths.settings, { caps, raised, reasoning: Object.fromEntries(models.map((model) => [model, routeMap[model].reasoning])), pilotSources: chosen.map((item) => item.id), frozenAt: new Date().toISOString() });
  console.log(`pilot complete; caps ${JSON.stringify(caps)}`);
  return 0;
}

async function runMain(paths, source, routes, routeMap) {
  const saved = readJson(paths.settings);
  if (!saved) throw new Error('Run the pilot first.');
  const cells = orderCells(source.sources);
  const states = await withSession({ dir: paths.main, paths, routes, routeMap, capOf: (model) => saved.caps[model], phase: 'main' }, async (session) => (
    runCells({ cells, tasks: source.tasks, session })
  ));
  console.log(`main: ${JSON.stringify(states)} of ${cells.length} cells`);
  return states.pending ? 2 : 0;
}

// Analysis: pure, from stored data.

function tally(items, outcome) {
  const counts = { n: items.length, correct: 0, wrong: 0, empty: 0, incomplete: 0 };
  for (const item of items) {
    const out = outcome(item);
    if (INCOMPLETE.has(out?.state || 'pending')) counts.incomplete += 1;
    else if (!out.accepted) counts.empty += 1;
    else if (out.correct === 1) counts.correct += 1;
    else counts.wrong += 1;
  }
  return counts;
}

function groupsBy(items, key) {
  const out = new Map();
  for (const item of items) {
    const name = key(item);
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(item);
  }
  return out;
}

export function analyse({ rows, ctx, sources, outcomes, labels, agreed, models, primaryBlocks, drop = SENSITIVITY_DROP }) {
  const inputs = sources.filter((item) => item.kind === 'input');
  const outcome = (id) => outcomes.get(id);
  const conditionTable = {};
  for (const condition of CONDITIONS) {
    const of = (item) => outcome(`${item.id}|${condition}`);
    const breakdown = (key) => Object.fromEntries([...groupsBy(inputs, key)].map(([name, list]) => [name, tally(list, of)]));
    conditionTable[condition] = {
      all: tally(inputs, of),
      byRoute: breakdown((item) => item.model),
      byBlock: breakdown((item) => item.block),
      byFinishReason: breakdown((item) => item.finishReason),
      byGroup: breakdown((item) => labels.get(item.id) || 'unlabelled'),
    };
  }
  const criteria = evaluateCriteria({ inputs, outcome, labels, models });
  const sensitivity = evaluateCriteria({ inputs: inputs.filter((item) => !drop.includes(item.questionId)), outcome, labels, models });
  const loo = leaveOneOut({ inputs, outcome, labels, models });
  const fidelityItems = inputs.filter((item) => agreed.has(item.id));
  const fidelity = {
    n: fidelityItems.length,
    matches: fidelityItems.filter((item) => outcome(`${item.id}|F`)?.extracted === agreed.get(item.id)).length,
  };
  const primary = new Set(primaryBlocks);
  const forcedMap = (condition) => {
    const map = new Map();
    for (const source of sources) {
      const out = outcome(`${source.id}|${condition}`);
      if (out?.accepted) map.set(source.id, out.extracted);
    }
    return map;
  };
  const touched = new Set(sources.map((item) => item.questionId));
  const patched = (policy, condition) => rows.map((row) => {
    const arms = policyArms(row, ctx.get(row.id), policy, condition ? forcedMap(condition) : new Map());
    return { id: row.id, block: row.block, status: 'complete', arms, undetermined: arms.undetermined };
  });
  const original = patched('original', null);
  const baseById = new Map(original.map((row) => [row.id, row]));
  const ARMS = ['A8', 'S8', 'P8', 'B8', 'V5'];
  const scored = (list) => Object.fromEntries(ARMS.map((arm) => [arm, list.length ? list.filter((row) => row.arms[arm]?.correct === 1).length / list.length : null]));
  const movement = (list) => Object.fromEntries(ARMS.map((arm) => {
    let wins = 0;
    let losses = 0;
    for (const row of list) {
      const was = baseById.get(row.id).arms[arm]?.correct === 1;
      const now = row.arms[arm]?.correct === 1;
      if (!was && now) wins += 1;
      if (was && !now) losses += 1;
    }
    return [arm, { wins, losses }];
  }));
  const policies = {};
  const entries = [['original', null], ['fallback', null], ...['F', 'T', 'C'].flatMap((condition) => [['fill', condition], ['all', condition]])];
  for (const [policy, condition] of entries) {
    const list = patched(policy, condition);
    const name = condition ? `${policy}:${condition}` : policy;
    const main = list.filter((row) => primary.has(row.block));
    const hit = list.filter((row) => touched.has(row.id));
    const pair = comparePair(main, 'A8', 'S8');
    policies[name] = {
      all: { n: list.length, rates: scored(list), movement: movement(list) },
      primary: { n: main.length, rates: scored(main), movement: movement(main), a8MinusS8: pair },
      touched: { n: hit.length, rates: scored(hit), movement: movement(hit) },
      undetermined: list.filter((row) => row.undetermined).length,
    };
  }
  // Syntheses: the fallback against a finished synthesis, and the chain.
  const synthesis = { A8: { n: 0, fallback: 0, finished: 0, chain: 0, finishedAccepted: 0 }, S8: { n: 0, fallback: 0, finished: 0, chain: 0, finishedAccepted: 0 } };
  const fill = forcedMap('F');
  for (const source of sources.filter((item) => item.kind === 'synthesis')) {
    const row = rows.find((item) => item.id === source.questionId);
    const c = ctx.get(row.id);
    const arm = source.role.split(':')[1];
    const entry = synthesis[arm];
    const finished = outcome(`${source.id}|F`);
    const fallback = policyArms(row, c, 'fill', fill)[arm];
    entry.n += 1;
    if (policyArms(row, c, 'fallback')[arm]?.correct === 1) entry.fallback += 1;
    if (finished?.accepted) entry.finishedAccepted += 1;
    if (finished?.accepted && finished.correct === 1) entry.finished += 1;
    if (finished?.accepted ? finished.correct === 1 : fallback?.correct === 1) entry.chain += 1;
  }
  return { conditions: conditionTable, criteria, sensitivity, leaveOneOut: loo, fidelity, policies, synthesis };
}

const pct = (value) => (value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

function renderReport(result, meta) {
  const lines = ['# Finishing cut answers: diagnostic probe', ''];
  lines.push(`Source: ${meta.sourceRun}. Diagnostic only: the test set had been read, the golds and grader changed after the run, and the rule was written after reading these texts.`, '');
  lines.push(`Spend: settled $${meta.budget.settledUsd.toFixed(4)}, held $${meta.budget.unresolvedUsd.toFixed(4)}, ${meta.budget.posts} POSTs. Key usage moved by ${meta.keyDelta == null ? 'n/a' : `$${meta.keyDelta.toFixed(4)}`} between the first and last audit.`, '');
  lines.push(`Caps after the pilot: ${JSON.stringify(meta.caps)}. Reasoning: ${JSON.stringify(meta.reasoning)}.`, '');
  lines.push('## Criteria (condition F)', '');
  const c = result.criteria;
  for (const [model, row] of Object.entries(c.c1.models)) lines.push(`- 1, ${model}: ${row.accepted} of ${row.n} accepted, ${row.incomplete} incomplete: ${row.verdict}.`);
  lines.push(`- 2, firm: ${c.c2.correct} of ${c.c2.n} correct, need ${c.c2.need}, question mean ${pct(c.c2.questionMean)}: ${c.c2.verdict}.`);
  lines.push(`- 3, firm and candidate: ${c.c3.correct} of ${c.c3.n} correct, need ${c.c3.need}, question mean ${pct(c.c3.questionMean)}: ${c.c3.verdict}.`);
  lines.push(`- 4, F over C on all inputs: ${pct(c.c4.fRate)} vs ${pct(c.c4.cRate)}, difference ${pct(c.c4.difference)}, question-mean difference ${pct(c.c4.questionMeanDifference)}, margin ${pct(c.c4.margin)}: ${c.c4.verdict}.`);
  lines.push('', `Decision: ${c.decision}.`, '');
  const s = result.sensitivity;
  lines.push(`Without ${SENSITIVITY_DROP.join(', ')}: criterion 2 ${s.c2.correct}/${s.c2.n} ${s.c2.verdict}; 3 ${s.c3.correct}/${s.c3.n} ${s.c3.verdict}; 4 ${pct(s.c4.difference)} ${s.c4.verdict}.`, '');
  lines.push(`Leave one question out: ${result.leaveOneOut.length ? result.leaveOneOut.map((row) => `${row.question} flips ${row.criterion} to ${row.to}`).join('; ') : 'no single question flips a criterion'}.`, '');
  lines.push(`Agreement with the accepted value where both labelling passes agree: ${result.fidelity.matches} of ${result.fidelity.n}.`, '');
  lines.push('## All cut inputs', '', '| Condition | n | correct | wrong | no answer | incomplete |', '| --- | --- | --- | --- | --- | --- |');
  for (const condition of CONDITIONS) {
    const row = result.conditions[condition].all;
    lines.push(`| ${condition} | ${row.n} | ${row.correct} | ${row.wrong} | ${row.empty} | ${row.incomplete} |`);
  }
  lines.push('', '## By group (F)', '', '| Group | n | correct | wrong | no answer | incomplete |', '| --- | --- | --- | --- | --- | --- |');
  for (const [name, row] of Object.entries(result.conditions.F.byGroup)) lines.push(`| ${name} | ${row.n} | ${row.correct} | ${row.wrong} | ${row.empty} | ${row.incomplete} |`);
  lines.push('', '## By route (F)', '', '| Route | n | correct | wrong | no answer | incomplete |', '| --- | --- | --- | --- | --- | --- |');
  for (const [name, row] of Object.entries(result.conditions.F.byRoute)) lines.push(`| ${name} | ${row.n} | ${row.correct} | ${row.wrong} | ${row.empty} | ${row.incomplete} |`);
  lines.push('', '## Policies (primary set)', '', '| Policy | A8 | S8 | P8 | B8 | Vote of five | A8 - S8 | 95% | 90% |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [name, row] of Object.entries(result.policies)) {
    const r = row.primary.rates;
    const pair = row.primary.a8MinusS8;
    const span = (interval) => (interval?.low == null ? 'n/a' : `[${(interval.low * 100).toFixed(1)}, ${(interval.high * 100).toFixed(1)}]`);
    lines.push(`| ${name} | ${pct(r.A8)} | ${pct(r.S8)} | ${pct(r.P8)} | ${pct(r.B8)} | ${pct(r.V5)} | ${(pair.delta * 100).toFixed(1)} pp (${pair.wins}/${pair.losses}) | ${span(pair.interval)} | ${span(pair.interval90)} |`);
  }
  lines.push('', '## Wins and losses against the original, all questions', '', '| Policy | A8 | S8 | P8 | B8 | Vote of five |', '| --- | --- | --- | --- | --- | --- |');
  for (const [name, row] of Object.entries(result.policies)) {
    const m = row.all.movement;
    const show = (arm) => `+${m[arm].wins} / -${m[arm].losses}`;
    lines.push(`| ${name} | ${show('A8')} | ${show('S8')} | ${show('P8')} | ${show('B8')} | ${show('V5')} |`);
  }
  lines.push('', '## Cut syntheses', '', '| Arm | n | fallback right | finished synthesis accepted | finished synthesis right | chain right |', '| --- | --- | --- | --- | --- | --- |');
  for (const [arm, row] of Object.entries(result.synthesis)) lines.push(`| ${arm} | ${row.n} | ${row.fallback} | ${row.finishedAccepted} | ${row.finished} | ${row.chain} |`);
  return lines.join('\n');
}

function runReport(paths, source, manifest) {
  const labelsFile = readJson(path.join(EVAL_ROOT, LABELS_FILE));
  const labels = new Map(labelsFile.items.map((item) => [item.cell, item.group]));
  const agreed = new Map(labelsFile.items.filter((item) => item.agreedAccepted != null).map((item) => [item.cell, item.agreedAccepted]));
  const cells = orderCells(source.sources);
  const slots = [...readSlotJournal(path.join(paths.main, 'events.jsonl')).values()];
  const outcomes = outcomesOf(cells, source.tasks, slots);
  const result = analyse({ rows: source.rows, ctx: source.ctx, sources: source.sources, outcomes, labels, agreed, models: source.councilModels, primaryBlocks: source.campaign.primaryBlocks });
  const budget = createCampaignBudget({ ...FINISH_LIMITS, prices: {} });
  const events = readJsonl(paths.budget);
  budget.applyJournal(events);
  const audits = events.filter((event) => event.kind === 'audit' && Number.isFinite(event.usage));
  const keyDelta = audits.length > 1 ? audits[audits.length - 1].usage - audits[0].usage : null;
  const saved = readJson(paths.settings);
  const hashes = sourceHashes(source.paths);
  const changed = Object.keys(hashes).filter((name) => hashes[name] !== manifest.frozen.sourceHashes[name]);
  if (changed.length) throw new Error(`Source files changed since the freeze: ${changed.join(', ')}`);
  const meta = { sourceRun: manifest.sourceRun, budget: { settledUsd: budget.state.settledUsd, unresolvedUsd: budget.state.unresolvedUsd, posts: budget.state.posts }, keyDelta, caps: saved?.caps, reasoning: saved?.reasoning };
  writeJson(paths.report, { meta, result: { ...result, policies: result.policies } });
  writeFileSync(paths.reportMd, renderReport(result, meta), 'utf8');
  console.log(`report written: ${paths.reportMd}`);
  console.log(`decision: ${result.criteria.decision}`);
  return 0;
}

export async function runFinishProbeCommand(argv) {
  const phase = flagValue(argv, '--phase');
  const runId = flagValue(argv, '--run') || 'finish-probe-v1';
  const paths = probePaths(runId);
  const live = argv.includes('--live');
  if (!phase) throw new Error('finish-probe requires --phase');
  if (['main', 'a8-open-v5e', 'a8-open-v5d'].includes(runId)) throw new Error('Refusing to write the probe into a campaign.');
  mkdirSync(paths.dir, { recursive: true });
  const sourceId = flagValue(argv, '--source-run') || readJson(paths.manifest)?.sourceRun || 'a8-open-v5e';
  const source = loadSource(sourceId);
  if (phase === 'inspect') {
    const summary = inspectSource(source, sourceId);
    writeJson(paths.inspect, summary);
    console.log(JSON.stringify(summary, null, 2));
    return summary.mismatches.length || summary.alreadyAccepted || summary.subsetMissing.length ? 1 : 0;
  }
  if (phase === 'label-pack') {
    const out = flagValue(argv, '--out');
    if (!out) throw new Error('label-pack needs --out');
    const subset = readJson(path.join(EVAL_ROOT, SUBSET_FILE));
    const byId = new Map(source.sources.map((item) => [item.id, item]));
    const size = Number(flagValue(argv, '--batch') || 17);
    const ordered = [...subset].sort((left, right) => rank('finish-probe-label', left).localeCompare(rank('finish-probe-label', right)));
    ordered.forEach((id, position) => {
      const batch = Math.floor(position / size) + 1;
      const item = byId.get(id);
      const task = source.tasks.get(item.questionId);
      const part = excerpts(item.text);
      const number = String(position + 1).padStart(2, '0');
      const fullFile = path.join(out, 'full', `${number}.txt`);
      mkdirSync(path.dirname(fullFile), { recursive: true });
      writeFileSync(fullFile, item.text, 'utf8');
      const fragments = part.fragments.map((row) => `[at ${row.at}] ${row.text}`).join('\n---\n');
      const page = [
        `CELL: ${id}`,
        `FULL TEXT, ${part.chars} characters, open only if the excerpts are not enough: ${fullFile}`,
        '', '=== QUESTION ===', answerPrompt({ kind: task.kind, stem: task.stem, options: task.options }),
        '', '=== FRAGMENTS NEAR THE WORDS answer AND final, position as a share of the text ===', fragments,
        '', '=== LAST 8000 CHARACTERS ===', part.tail,
      ].join('\n');
      const file = path.join(out, `batch-${batch}`, `${number}.md`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, page, 'utf8');
    });
    console.log(`label packs written to ${out}`);
    return 0;
  }
  if (phase === 'label-merge') {
    const fileA = flagValue(argv, '--pass-a');
    const fileB = flagValue(argv, '--pass-b');
    if (!fileA || !fileB) throw new Error('label-merge needs --pass-a and --pass-b');
    const subset = readJson(path.join(EVAL_ROOT, SUBSET_FILE));
    const byId = new Map(source.sources.map((item) => [item.id, item]));
    const items = mergeLabels(subset, byId, source.tasks, readJson(fileA), readJson(fileB));
    writeJson(path.join(EVAL_ROOT, LABELS_FILE), { version: 1, sourceRun: sourceId, goldFile: GOLD_FILE, goldSha: source.overrides.sha, items });
    const counts = {};
    for (const item of items) counts[item.group] = (counts[item.group] || 0) + 1;
    console.log(`labels: ${JSON.stringify(counts)}; passes differ on ${items.filter((item) => item.groupA !== item.groupB).length}; agreed accepted ${items.filter((item) => item.agreedAccepted != null).length}`);
    return 0;
  }
  if (phase === 'report') {
    const manifest = readJson(paths.manifest);
    if (!manifest) throw new Error('No manifest yet.');
    return runReport(paths, source, manifest);
  }
  if (phase !== 'pilot' && phase !== 'run') throw new Error(`Unknown finish-probe phase ${phase}`);
  if (!live) throw new Error(`${phase} posts only with --live`);
  const release = lock(paths.dir);
  try {
    assertFrozen(paths, source);
    const routes = source.selection.routes.filter((route) => source.councilModels.includes(route.id));
    const routeMap = probeRoutes(routes);
    if (phase === 'pilot') return await runPilot(paths, source, routes, routeMap);
    return await runMain(paths, source, routes, routeMap);
  } finally {
    release();
  }
}
