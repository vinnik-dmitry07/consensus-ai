// finish-probe-v4: finishing cut answers on the new ArXivMath questions of
// a8-open-v6, under finish-probe-v4-protocol.md. Written and committed before
// the first test POST of a8-open-v6, so before any answer to a v6 test
// question exists. Every number, bound, verdict, and the decision come from
// this code; the analysis text comes from OpenRouter models.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { settings } from '../src/engine/browser/settings.js';
import { gitState, goldOverridesFrom, reconcileBudget } from './a8.js';
import { applyGoldOverrides } from './a8Report.js';
import { createCampaignBudget } from './budget.js';
import {
  STREAM_SECONDS, audit, cellKey, collectSources, finishMessage, leaderRole, loadTasks, orderCells,
  prepareProbe, probeRoutes, usedSlot,
} from './finishProbe.js';
import {
  criterion1Bounded, criterion4Bounded, isConfirmed, questionMean, questionMeanAtLeast, threeWay,
} from './finishProbeCriteria.js';
import { mergedSlots, stageIndex } from './finishProbeV2.js';
import { pinnedListed } from './finishProbeV2Report.js';
import {
  BATCH, REQUIRED_PARAMETERS, callStats, endpointProblems, failureKinds, handRecount, moneyOf, outcomesFor,
  placeBlock, runStage, synthesisTable, tokenSpread, v3FormTable, V3_FORMS,
} from './finishProbeV3.js';
import { promptTokenCeiling, quoteReservation } from './paid.js';
import { createSession, readSlotJournal } from './runtime.js';
import { installTransport } from './transport.js';
import { sha256 } from './util.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(EVAL_ROOT, '.runs');
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const README = path.join(EVAL_ROOT, 'README.md');

export const V4_RUN = 'finish-probe-v4';
export const SOURCE_RUN = 'a8-open-v6';
export const V4_LIMITS = Object.freeze({ maxUsd: 15, maxPosts: 900 });
export const V4_CAP = 2048;
export const V4_ORDER_SEED = 'finish-probe-v4-order';
export const V4_CONDITIONS = Object.freeze(['F', 'C']);
export const ARMS = Object.freeze(['B8', 'P8', 'V5', 'A8', 'S8']);
// The arms whose wins over the fallback decide KW. A8 and S8 are shown only.
export const VOTE_ARMS = Object.freeze(['B8', 'P8', 'V5']);
export const PROTOCOL_V4 = 'finish-probe-v4-protocol.md';
export const V4_FILES = Object.freeze([
  'finishProbeV4.js', 'finishProbeV4.test.js', 'finishProbeV4Cli.js', PROTOCOL_V4,
  'finishProbe.js', 'finishProbeV2.js', 'finishProbeV2Report.js', 'finishProbeV3.js', 'finishProbeCriteria.js',
  'finishProbeAnalysis.js', 'evalAnalysis.js', 'finish-probe-protocol.md',
]);
export const README_START = '<!-- finish-probe-v4:start -->';
export const README_END = '<!-- finish-probe-v4:end -->';
export const ANALYSIS_START = '<!-- finish-probe-v4-analysis:start -->';
export const ANALYSIS_END = '<!-- finish-probe-v4-analysis:end -->';
export const AFTER = '<!-- finish-probe-summary-analysis:end -->';
export const ANALYSIS_LIMITS = Object.freeze({ maxUsd: 0.5, maxPosts: 8 });

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

function fileSha(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent';
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

export function goldFileOf(runId) {
  return `gold-corrections-${runId}.json`;
}

export function v4Paths(runName = V4_RUN, root = RUNS_ROOT) {
  const dir = path.join(root, runName);
  return {
    dir,
    budget: path.join(dir, 'budget.jsonl'),
    manifest: path.join(dir, 'manifest.json'),
    route: path.join(dir, 'route.json'),
    stops: path.join(dir, 'stops.jsonl'),
    main: path.join(dir, 'main'),
    events: path.join(dir, 'main', 'events.jsonl'),
    analysis: path.join(dir, 'analysis'),
    inspect: path.join(dir, 'inspect.json'),
    report: path.join(dir, 'report.json'),
    reportMd: path.join(dir, 'report.md'),
    readme: path.join(dir, 'readme-block.md'),
  };
}

// The source: the finished test of a campaign, read only. Like
// finishProbe.loadSource, but the gold corrections come from the campaign's
// own file when it exists, and only primary questions are kept.
function sourceFiles(runId, root = RUNS_ROOT) {
  const dir = path.join(root, runId);
  return {
    dir,
    events: path.join(dir, 'comparison', 'test', 'events.jsonl'),
    questions: path.join(dir, 'comparison', 'test'),
    selection: path.join(dir, 'selection.json'),
    campaign: path.join(dir, 'campaign.json'),
    gate: path.join(dir, 'gate.json'),
  };
}

function storedRows(dir) {
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || ['order.json', 'runner.json', 'cooldowns.json'].includes(name)) continue;
    const row = readJson(path.join(dir, name));
    if (row?.id && row.status === 'complete' && row.arms) rows.push(row);
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

function contexts(rows, sources, slots, { councilModels, bModel, chairmanModel }, tasks) {
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

export function loadCampaignSource(runId = SOURCE_RUN, { root = RUNS_ROOT, goldFile = goldFileOf(runId) } = {}) {
  const paths = sourceFiles(runId, root);
  const selection = readJson(paths.selection);
  const campaign = readJson(paths.campaign);
  if (!selection || !campaign) throw new Error(`${runId} has no selection or campaign`);
  const raw = loadTasks();
  const goldPath = path.join(EVAL_ROOT, goldFile);
  const overrides = existsSync(goldPath) ? goldOverridesFrom(['--gold-overrides', goldPath], raw) : { canonical: {}, excluded: [], sha: 'absent', file: null };
  const excluded = new Set(overrides.excluded);
  const primary = new Set(campaign.primaryBlocks || []);
  const kept = storedRows(paths.questions).filter((row) => primary.has(row.block) && !excluded.has(row.id));
  const rows = applyGoldOverrides(kept, overrides.canonical).rows;
  const tasks = new Map();
  for (const [id, task] of raw) tasks.set(id, overrides.canonical[id] == null ? task : { ...task, goldCanon: overrides.canonical[id] });
  const slots = existsSync(paths.events) ? [...readSlotJournal(paths.events).values()] : [];
  const context = { selection, campaign, councilModels: selection.council, bModel: selection.b, chairmanModel: selection.h };
  const sources = collectSources({ rows, slots, ...context, tasks });
  const ctx = contexts(rows, sources, slots, context, tasks);
  // A question the gold file excludes is not expected.
  const excludedPrimary = [...excluded].filter((id) => primary.has(raw.get(id)?.block)).length;
  const planned = (campaign.primaryBlocks || []).reduce((sum, block) => sum + (campaign.counts?.blocks?.[block]?.test || 0), 0) - excludedPrimary;
  return { runId, paths, ...context, tasks, rows, slots, sources, ctx, overrides: { file: overrides.file ? goldFile : null, sha: overrides.sha, excluded: overrides.excluded }, planned };
}

// Cells: F and C of each cut input next to each other, in the hash order of
// the seed, then F on the cut syntheses (shown only), last.
export function v4Cells(sources, seed = V4_ORDER_SEED) {
  return orderCells(sources, seed, V4_CONDITIONS);
}

export function sourceDigest(sources) {
  return sha256(sources.map((item) => `${item.id}\n${item.textSha}`).join('\n'));
}

export function orderDigest(cells) {
  return sha256(cells.map((cell) => cell.id).join('\n'));
}

// Criteria.

// KP: among the accepted F answers on the cut inputs at least half are right,
// by count and by the mean over questions of the share right among the
// accepted. The low bound counts every unconfirmed F as accepted and wrong,
// the high bound as accepted and right. No accepted answer does not pass.
export function criterionKP(inputs, f) {
  const accepted = inputs.filter((item) => f(item)?.v3 === 'accepted');
  const unconfirmed = inputs.filter((item) => !isConfirmed(f(item)));
  const right = accepted.filter((item) => f(item).correct === 1);
  const holds = (list, isRight) => list.length > 0
    && 2 * list.filter(isRight).length >= list.length
    && questionMeanAtLeast(list, (item) => (isRight(item) ? 1 : 0), 1, 2);
  const low = [...accepted, ...unconfirmed];
  const rightLow = (item) => f(item)?.v3 === 'accepted' && f(item).correct === 1;
  const rightHigh = (item) => !isConfirmed(f(item)) || f(item).correct === 1;
  return {
    n: inputs.length,
    accepted: accepted.length,
    right: right.length,
    unconfirmed: unconfirmed.length,
    shareLow: low.length ? right.length / low.length : null,
    shareHigh: low.length ? (right.length + unconfirmed.length) / low.length : null,
    questionMeanLow: questionMean(low, (item) => (rightLow(item) ? 1 : 0)),
    questionMeanHigh: questionMean(low, (item) => (rightHigh(item) ? 1 : 0)),
    verdict: threeWay(holds(low, rightLow), holds(low, rightHigh)),
  };
}

// KW: fill gives at least one win over the fallback in B8, P8, or the vote of
// five. A win is counted only where the arm reads no unconfirmed cell.
export function criterionKW(recount, arms = VOTE_ARMS) {
  const rows = arms.map((arm) => ({ arm, ...recount.fill.overFallback[arm] }));
  const wins = rows.reduce((sum, row) => sum + row.wins, 0);
  const undetermined = rows.reduce((sum, row) => sum + row.undetermined, 0);
  let verdict = 'not_evaluable';
  if (wins > 0) verdict = 'pass';
  else if (undetermined === 0) verdict = 'fail';
  return { arms: rows, wins, undetermined, winArms: rows.filter((row) => row.wins > 0).map((row) => row.arm), verdict };
}

// The first failing criterion in the order K4, KP, KW decides; with none
// failing, any criterion that is not evaluable leaves the result incomplete.
export function decideV4({ n, k4, kp, kw }) {
  if (!n) return { code: 'no_cut_inputs', arms: [] };
  const order = [['k4', 'text_benefit_not_shown'], ['kp', 'accepted_often_wrong'], ['kw', 'no_use_for_arms']];
  const verdicts = { k4: k4.verdict, kp: kp.verdict, kw: kw.verdict };
  for (const [name, code] of order) if (verdicts[name] === 'fail') return { code, arms: [] };
  if (Object.values(verdicts).includes('not_evaluable')) return { code: 'incomplete', arms: [] };
  return { code: 'confirmed_for_arms', arms: kw.winArms };
}

export function evaluateV4({ inputs, outcome, recount }) {
  const pending = { v3: 'pending', correct: 0, accepted: false };
  const f = (item) => outcome(`${item.id}|F`) || pending;
  const c = (item) => outcome(`${item.id}|C`) || pending;
  const k4 = criterion4Bounded(inputs, f, c);
  const kp = criterionKP(inputs, f);
  const kw = criterionKW(recount);
  return { k4, kp, kw, decision: decideV4({ n: inputs.length, k4, kp, kw }) };
}

// Routes: the council of the source (B and H are in it), each with the lowest
// reasoning effort it lists, the 2048 cap, and require_parameters.
export function v4Routes(selection) {
  return selection.council.map((id) => {
    const route = selection.routes.find((item) => item.id === id);
    if (!route) throw new Error(`Route ${id} is not in the selection`);
    return route;
  });
}

export function largestPrompt(source, model) {
  return Math.max(0, ...source.sources.filter((item) => item.model === model).map((item) => (
    promptTokenCeiling([{ role: 'user', content: finishMessage(source.tasks.get(item.questionId), 'F', item.text) }])
  )));
}

// Which routes may be asked: the pinned endpoint is listed and carries the
// parameters, the largest F prompt plus the cap, and the price. Pure.
export function routeCheck(routes, listings, needs) {
  const out = {};
  for (const route of routes) {
    const listing = listings[route.id] || { status: null, endpoints: [] };
    const pinned = (listing.endpoints || []).filter((endpoint) => pinnedListed(route, [endpoint]));
    const problems = pinned.length ? endpointProblems(pinned[0], { route, ...needs[route.id] }) : ['not listed'];
    out[route.id] = { status: listing.status, tag: route.tag, listed: pinned.length > 0, endpoint: pinned[0]?.tag ?? null, problems, usable: pinned.length > 0 && !problems.length };
  }
  return out;
}

// Worst case and an estimate, from the payloads. The budget reserves each POST
// at the prompt ceiling (one token per character).
export function worstCase(cells, source, routes, charsPerToken = 3) {
  const byId = new Map(routes.map((route) => [route.id, route]));
  let ceiling = 0;
  let estimate = 0;
  const byKind = {};
  for (const cell of cells) {
    const route = byId.get(cell.model);
    if (!route) continue;
    const messages = [{ role: 'user', content: finishMessage(source.tasks.get(cell.questionId), cell.condition, cell.source.text) }];
    const tokens = promptTokenCeiling(messages);
    const high = quoteReservation({ pricing: route.pricing, promptTokens: tokens, maxTokens: V4_CAP })?.usd ?? 0;
    const likely = quoteReservation({ pricing: route.pricing, promptTokens: Math.ceil(tokens / charsPerToken), maxTokens: V4_CAP })?.usd ?? 0;
    ceiling += high;
    estimate += likely;
    const kind = `${cell.source.kind} ${cell.condition}`;
    const entry = byKind[kind] ||= { cells: 0, ceilingUsd: 0, estimateUsd: 0 };
    entry.cells += 1;
    entry.ceilingUsd += high;
    entry.estimateUsd += likely;
  }
  return { cells: cells.length, ceilingUsd: ceiling, estimateUsd: estimate, charsPerToken, byKind };
}

// Freeze.

function filesHash(names) {
  return sha256(names.map((name) => `${name}\n${fileSha(path.join(EVAL_ROOT, name))}`).join('\n'));
}

export function sourceRecord(source, cells) {
  return {
    run: source.runId,
    campaignSourceHash: source.campaign.sourceHash,
    test: fileSha(source.paths.events),
    selection: fileSha(source.paths.selection),
    campaign: fileSha(source.paths.campaign),
    gold: source.overrides,
    rows: source.rows.length,
    planned: source.planned,
    sources: source.sources.length,
    sourceDigest: sourceDigest(source.sources),
    orderDigest: orderDigest(cells),
  };
}

function freezeV4(paths, source, cells) {
  const current = { codeHash: filesHash(V4_FILES), files: Object.fromEntries(V4_FILES.map((name) => [name, fileSha(path.join(EVAL_ROOT, name))])), source: sourceRecord(source, cells) };
  const manifest = readJson(paths.manifest);
  if (manifest) {
    if (manifest.frozen.codeHash !== current.codeHash) throw new Error('The v4 files changed since the freeze.');
    for (const key of ['test', 'selection', 'campaign', 'sourceDigest', 'orderDigest']) {
      if (manifest.frozen.source[key] !== current.source[key]) throw new Error(`The ${key} of the source changed since the freeze.`);
    }
    if (manifest.frozen.source.gold.sha !== current.source.gold.sha) throw new Error('The gold corrections changed since the freeze.');
    return manifest;
  }
  const git = gitState(V4_FILES);
  if (!git.head) throw new Error(`Cannot read the git commit (${git.error || 'unknown'}).`);
  if (git.dirty.length) throw new Error(`Commit the v4 files before the first POST: ${git.dirty.join(', ')}`);
  const next = { run: V4_RUN, frozen: { ...current, gitHead: git.head, frozenAt: new Date().toISOString() }, limits: V4_LIMITS, cap: V4_CAP, orderSeed: V4_ORDER_SEED, batch: BATCH, streamSeconds: STREAM_SECONDS };
  writeJson(paths.manifest, next);
  return next;
}

// Budget and session.

function openBudget(file, prices) {
  mkdirSync(path.dirname(file), { recursive: true });
  const budget = createCampaignBudget({ ...V4_LIMITS, prices, onEvent: (event) => appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8') });
  budget.applyJournal(readJsonl(file));
  return budget;
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

function requireComplete(source) {
  if (source.rows.length !== source.planned) {
    throw new Error(`${source.runId}: ${source.rows.length} of ${source.planned} primary questions are complete; finishing waits for the whole test.`);
  }
}

async function runRun(paths, source) {
  requireComplete(source);
  const cells = v4Cells(source.sources);
  const manifest = freezeV4(paths, source, cells);
  const routes = v4Routes(source.selection);
  const routeMap = probeRoutes(routes);
  const listings = {};
  for (const route of routes) listings[route.id] = await listingOf(route.id);
  const needs = Object.fromEntries(routes.map((route) => [route.id, { needPrompt: largestPrompt(source, route.id), cap: V4_CAP }]));
  const checks = routeCheck(routes, listings, needs);
  writeJson(paths.route, { at: new Date().toISOString(), required: REQUIRED_PARAMETERS, checks, reasoning: Object.fromEntries(routes.map((route) => [route.id, routeMap[route.id].reasoning])) });
  const blocked = new Set(Object.entries(checks).filter(([, row]) => !row.usable).map(([id]) => id));
  for (const id of blocked) appendFileSync(paths.stops, `${JSON.stringify({ at: new Date().toISOString(), kind: 'route', model: id, problems: checks[id].problems })}\n`, 'utf8');
  settings.apiKey = paidKey();
  const budget = openBudget(paths.budget, Object.fromEntries(routes.map((route) => [route.id, route.pricing])));
  if (budget.unresolvedAttempts().length) {
    try {
      await reconcileBudget({ dir: paths.dir }, budget, { journals: existsSync(paths.events) ? [paths.events] : [] });
    } catch (error) {
      console.log(`reconcile skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await audit(budget, 'run', 'start');
  const session = createSession({
    runDir: paths.main,
    budget,
    prepareOptions: prepareProbe(routeMap, () => V4_CAP),
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
  let out;
  try {
    out = await runStage({
      cells, tasks: source.tasks, session, blocked,
      log: (round, ready, index) => {
        const done = cells.filter((cell) => isConfirmed(outcomesFor([cell], source.tasks, index).get(cell.id))).length;
        console.log(`v4 batch ${round} (${ready.length} cells): ${done} of ${cells.length} confirmed`);
      },
    });
  } finally {
    session.uninstall();
    restore();
    await audit(budget, 'run', 'end');
    console.log(`v4 budget: settled $${budget.state.settledUsd.toFixed(4)}, held $${budget.state.unresolvedUsd.toFixed(4)}, ${budget.state.posts} POSTs (frozen at ${manifest.frozen.gitHead.slice(0, 12)})`);
  }
  appendFileSync(paths.stops, `${JSON.stringify({ at: new Date().toISOString(), kind: 'run', end: out.end, blocked: out.blocked })}\n`, 'utf8');
  console.log(`v4 run ended: ${out.end}`);
  if (out.end === 'done') return 0;
  if (out.end === 'budget') return 5;
  if (out.end === 'route_unavailable') return 6;
  return 2;
}

// Report.

function journalIndex(files) {
  const indexes = files.filter((file) => existsSync(file)).map((file) => stageIndex([...readSlotJournal(file).values()]));
  return indexes;
}

// The outcome of every cell. Several journals are read only in a dry run: a
// cell takes the first journal that finished it, as in the v2 report.
export function outcomesOfJournals(cells, tasks, files) {
  const indexes = journalIndex(files);
  if (!indexes.length) return outcomesFor(cells, tasks, new Map());
  let merged = indexes[0];
  for (const next of indexes.slice(1)) merged = stageIndex(mergedSlots(cells, merged, next));
  return outcomesFor(cells, tasks, merged);
}

export function buildV4Report(paths, source, { journals = [paths.events], dry = false } = {}) {
  const manifest = readJson(paths.manifest);
  const cells = v4Cells(source.sources);
  const notes = [];
  if (!dry && manifest) {
    const now = sourceRecord(source, cells);
    for (const key of ['test', 'selection', 'campaign', 'sourceDigest', 'orderDigest']) {
      if (manifest.frozen.source[key] !== now[key]) throw new Error(`The ${key} of the source changed since the freeze.`);
    }
  }
  if (dry) notes.push(`Dry run on ${source.runId} with ${journals.map((file) => path.relative(EVAL_ROOT, file).replace(/\\/g, '/')).join(', ')}: a check of the code, not a result of finish-probe-v4.`);
  if (!manifest && !dry) notes.push('No manifest: nothing was frozen or sent yet.');
  const outcomes = outcomesOfJournals(cells, source.tasks, journals);
  const outcome = (id) => outcomes.get(id);
  const inputs = source.sources.filter((item) => item.kind === 'input');
  const models = source.councilModels;
  const recount = handRecount({ rows: source.rows, ctx: source.ctx, sources: source.sources, outcome, primaryBlocks: source.campaign.primaryBlocks });
  const criteria = evaluateV4({ inputs, outcome, recount });
  const byRoute = (model, condition) => inputs.filter((item) => item.model === model).map((item) => outcome(`${item.id}|${condition}`));
  const pending = { v3: 'pending', correct: 0 };
  const result = {
    decision: criteria.decision,
    k4: criteria.k4,
    kp: criteria.kp,
    kw: criteria.kw,
    inputs: inputs.length,
    syntheses: source.sources.length - inputs.length,
    questions: new Set(inputs.map((item) => item.questionId)).size,
    acceptance: models.map((model) => ({ route: model, F: criterion1Bounded(inputs.filter((item) => item.model === model), (item) => outcome(`${item.id}|F`) || pending), C: criterion1Bounded(inputs.filter((item) => item.model === model), (item) => outcome(`${item.id}|C`) || pending) })),
    forms: v3FormTable(source.sources, outcome, models),
    tokens: models.flatMap((model) => V4_CONDITIONS.map((condition) => ({ route: model, condition, ...tokenSpread(byRoute(model, condition)) }))),
    calls: [
      ...models.flatMap((model) => V4_CONDITIONS.map((condition) => ({ route: model, condition, ...callStats(byRoute(model, condition)) }))),
      { route: 'syntheses', condition: 'F', ...callStats(source.sources.filter((item) => item.kind === 'synthesis').map((item) => outcome(`${item.id}|F`))) },
    ],
    recount,
    synthesis: synthesisTable({ rows: source.rows, ctx: source.ctx, sources: source.sources, outcome }),
  };
  result.failures = result.forms.rows.map((row) => ({ route: row.route, condition: row.condition, ...failureKinds(row) }));
  const meta = {
    run: V4_RUN,
    sourceRun: source.runId,
    dry,
    freeze: manifest?.frozen ? { gitHead: manifest.frozen.gitHead, frozenAt: manifest.frozen.frozenAt, codeUnchanged: manifest.frozen.codeHash === filesHash(V4_FILES) } : null,
    cap: V4_CAP,
    limits: V4_LIMITS,
    selection: { b: source.bModel, h: source.chairmanModel, council: source.councilModels },
    gold: source.overrides,
    rows: source.rows.length,
    planned: source.planned,
    route: readJson(paths.route),
    stops: readJsonl(paths.stops),
    money: dry ? null : moneyOf(readJsonl(paths.budget)),
    notes,
  };
  return { meta, result };
}

// Rendering.

const pct = (value) => (value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const usd4 = (value) => `$${Number(value || 0).toFixed(4)}`;
const usd2 = (value) => `$${Number(value || 0).toFixed(2)}`;
const span = (low, high) => (low === high ? `${low}` : `${low}..${high}`);
const armCell = (row) => `+${row.wins} / -${row.losses} / =${row.unchanged} / ?${row.undetermined}`;
const ppOf = (pair) => (pair?.delta == null ? 'n/a' : `${(pair.delta * 100).toFixed(1)}`);
const interval = (row) => (row?.low == null ? 'n/a' : `[${(row.low * 100).toFixed(1)}, ${(row.high * 100).toFixed(1)}]`);
const short = (model) => String(model).split('/')[0];

export const DECISION_EN = Object.freeze({
  no_cut_inputs: 'the test left no cut input to finish',
  text_benefit_not_shown: 'K4 fails: on the new questions the saved text is not shown to help over the control',
  accepted_often_wrong: 'K4 holds and KP fails: the accepted answers are right less than half the time',
  no_use_for_arms: 'K4 and KP hold and KW fails: fill gives the arms no win over the fallback on this block',
  incomplete: 'the result is incomplete: measurements are missing',
  confirmed_for_arms: 'K4, KP, and KW hold: confirmed on new questions for the arms with a win',
});

export const DECISION_RU = Object.freeze({
  no_cut_inputs: 'в тесте не осталось оборванных входов для дописывания',
  text_benefit_not_shown: 'K4 не выполнен: польза сохранённого текста на новых вопросах не показана',
  accepted_often_wrong: 'K4 выполнен, KP нет: принятые ответы верны реже чем в половине случаев',
  no_use_for_arms: 'K4 и KP выполнены, KW нет: заполнение не даёт рукам выигрыша над fallback на этом блоке',
  incomplete: 'результат неполный, не хватает измерений',
  confirmed_for_arms: 'K4, KP и KW выполнены: подтверждено на новых вопросах для рук с выигрышем',
});

const VERDICT_RU = Object.freeze({ pass: 'выполнен', fail: 'не выполнен', not_evaluable: 'не определён' });

export function renderV4Report({ meta, result }) {
  const lines = ['# Finishing cut answers on new questions: finish-probe-v4', ''];
  lines.push(`Source: ${meta.sourceRun}, read only: ${meta.rows} of ${meta.planned} primary questions complete; ${result.inputs} cut inputs from ${result.questions} questions and ${result.syntheses} cut syntheses. Rules: ${PROTOCOL_V4}.`);
  lines.push(meta.freeze ? `Freeze: commit ${meta.freeze.gitHead}, ${meta.freeze.frozenAt}. Code ${meta.freeze.codeUnchanged ? 'unchanged since the freeze' : 'CHANGED since the freeze'}.` : 'Freeze: none yet.');
  lines.push(`Selection of the source: B = H = ${meta.selection.b}; council ${meta.selection.council.join(', ')}. Cap ${meta.cap} on every route. Gold corrections: ${meta.gold.file ? `${meta.gold.file} (${meta.gold.sha.slice(0, 12)})` : 'none'}.`);
  for (const note of meta.notes) lines.push(note);
  if (meta.route) lines.push(`Routes (${meta.route.at}): ${Object.entries(meta.route.checks).map(([id, row]) => `${id} ${row.endpoint ?? 'not listed'}${row.problems.length ? ` (${row.problems.join('; ')})` : ''}`).join('; ')}. Reasoning: ${JSON.stringify(meta.route.reasoning)}.`);
  lines.push('', '## Decision', '', `${DECISION_EN[result.decision.code]}${result.decision.arms.length ? `: ${result.decision.arms.join(', ')}` : ''}.`, '');
  const k4 = result.k4;
  lines.push(`- K4, F over C on ${k4.n} cut inputs: F correct ${k4.fCorrect} (unconfirmed ${k4.fUnconfirmed}), C correct ${k4.cCorrect} (unconfirmed ${k4.cUnconfirmed}); difference ${span(k4.differenceLow, k4.differenceHigh)} texts, need ${k4.needDifference}; question mean ${pct(k4.questionMeanLow)}–${pct(k4.questionMeanHigh)}, need ${pct(2 / 23)}; ${k4.verdict}.`);
  const kp = result.kp;
  lines.push(`- KP, right among accepted F: ${kp.right} right of ${kp.accepted} accepted, unconfirmed ${kp.unconfirmed}; share ${pct(kp.shareLow)}–${pct(kp.shareHigh)}, need 50%; question mean ${pct(kp.questionMeanLow)}–${pct(kp.questionMeanHigh)}, need 50%; ${kp.verdict}.`);
  const kw = result.kw;
  lines.push(`- KW, wins of fill over the fallback in ${VOTE_ARMS.join(', ')}: ${kw.arms.map((row) => `${row.arm} ${armCell(row)}`).join('; ')}; ${kw.verdict}.`);
  lines.push('', '## Acceptance by route (shown only)', '', '| Route | F accepted | F rejected | F unconfirmed | C accepted | C rejected | C unconfirmed | n |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of result.acceptance) lines.push(`| ${row.route} | ${row.F.accepted} | ${row.F.rejected} | ${row.F.unconfirmed} | ${row.C.accepted} | ${row.C.rejected} | ${row.C.unconfirmed} | ${row.F.n} |`);
  lines.push('', '## Form of the calls', '', `| Route | Condition | n | ${V3_FORMS.join(' | ')} |`, `| --- | --- | --- | ${V3_FORMS.map(() => '---').join(' | ')} |`);
  for (const row of result.forms.rows) lines.push(`| ${row.route} | ${row.condition} | ${row.n} | ${V3_FORMS.map((name) => row[name]).join(' | ')} |`);
  const s = result.forms.syntheses;
  lines.push(`| syntheses | F | ${s.n} | ${V3_FORMS.map((name) => s[name]).join(' | ')} |`);
  lines.push('', 'Not accepted, by category (cap, refusal, format, transport):', '');
  for (const row of result.failures) lines.push(`- ${row.route} ${row.condition}: cap ${row.cap}, refusal ${row.refusal}, format ${row.format}, transport ${row.transport}.`);
  lines.push('', '## Completion tokens of the calls that came back', '', '| Route | Condition | n | median | max | <=512 | 513-2048 | ended at the cap |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of result.tokens) lines.push(`| ${row.route} | ${row.condition} | ${row.n} | ${row.median ?? 'n/a'} | ${row.max ?? 'n/a'} | ${row.upTo512} | ${row.upTo2048} | ${row.atCap} |`);
  const rc = result.recount;
  lines.push('', '## Recount of the arms', '', `All ${rc.rows} questions. Cells: wins / losses / unchanged / undetermined. Only wins over the fallback in ${VOTE_ARMS.join(', ')} decide KW; A8 and S8 are shown only.`, '', `| Policy | Against | ${ARMS.join(' | ')} |`, `| --- | --- | ${ARMS.map(() => '---').join(' | ')} |`);
  for (const policy of ['fill', 'all']) {
    const name = `${policy}${policy === 'all' ? ' (shown only)' : ''}`;
    lines.push(`| ${name} | stored arms | ${ARMS.map((arm) => armCell(rc[policy].all[arm])).join(' | ')} |`);
    lines.push(`| ${name} | fallback | ${ARMS.map((arm) => armCell(rc[policy].overFallback[arm])).join(' | ')} |`);
  }
  lines.push('', '| Policy | A8 correct | S8 correct | A8 - S8, pp | wins/losses | 95% | 90% |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const [name, row] of [['original', rc.original], ['fallback', rc.fallback], ['fill', rc.fill], ['all', rc.all]]) {
    const pair = row.a8MinusS8;
    lines.push(`| ${name} | ${row.primaryCorrect.A8} | ${row.primaryCorrect.S8} | ${ppOf(pair)} | ${pair.wins}/${pair.losses} | ${interval(pair.interval)} | ${interval(pair.interval90)} |`);
  }
  lines.push('', '## Cut syntheses (shown only)', '', '| Arm | n | fallback right | finished accepted | finished right | chain right | unconfirmed |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const [arm, row] of Object.entries(result.synthesis)) lines.push(`| ${arm} | ${row.n} | ${row.fallbackRight} | ${row.finishedAccepted} | ${row.finishedRight} | ${row.chainRight} | ${row.unconfirmed} |`);
  lines.push('', '## Price and time of the calls, failed ones included', '', '| Route | Condition | cells posted | POSTs | known cost | without a cost | median s | max s |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  const sec = (ms) => (ms == null ? 'n/a' : (ms / 1000).toFixed(1));
  for (const row of result.calls) lines.push(`| ${row.route} | ${row.condition} | ${row.cells} | ${row.posts} | ${usd4(row.knownUsd)} | ${row.withoutCost} | ${sec(row.medianMs)} | ${sec(row.maxMs)} |`);
  const m = meta.money;
  if (m) {
    lines.push('', '## Money', '', `One budget journal for every v4 POST: settled ${usd4(m.settledUsd)}, held ${usd4(m.heldUsd)}, ${m.posts} POSTs; limits ${usd2(meta.limits.maxUsd)} and ${meta.limits.maxPosts}.`);
    lines.push(`Key usage: ${m.key.first == null ? 'n/a' : `$${m.key.first.toFixed(4)}`} at the first audit, ${m.key.last == null ? 'n/a' : `$${m.key.last.toFixed(4)}`} at the last; moved by ${m.key.delta == null ? 'n/a' : usd4(m.key.delta)}. Other use of the key and billing delay are not attributed to cells.`);
  }
  return lines.join('\n');
}

export function renderV4Readme({ meta, result }) {
  const lines = [
    '### Дописывание оборванных ответов на новых вопросах (`finish-probe-v4`)',
    '',
    `Источник — тест \`${meta.sourceRun}\` (ArXivMath, ${meta.rows} из ${meta.planned} вопросов): ${result.inputs} оборванных входов из ${result.questions} вопросов и ${result.syntheses} оборванных синтезов. Правила — в [${PROTOCOL_V4}](${PROTOCOL_V4}), заморожены до первого вопроса теста. Лимит 2048 на всех маршрутах. Числа, границы и решение посчитаны кодом; блок собран из отчёта без толкования.`,
    '',
    `**Решение по заранее заданному правилу:** ${DECISION_RU[result.decision.code]}${result.decision.arms.length ? ` (${result.decision.arms.join(', ')})` : ''}.`,
    '',
    '| Критерий | Значение | Порог | Итог |',
    '| --- | --- | --- | --- |',
  ];
  const k4 = result.k4;
  const kp = result.kp;
  const kw = result.kw;
  lines.push(`| K4. F выше C | F верно ${k4.fCorrect}, C верно ${k4.cCorrect}, разница ${span(k4.differenceLow, k4.differenceHigh)} из ${k4.n} | ${k4.needDifference} текстов и 2/23 по вопросам | ${VERDICT_RU[k4.verdict]} |`);
  lines.push(`| KP. Принятые F верны | ${kp.right} из ${kp.accepted} принятых, без исхода ${kp.unconfirmed} | половина и 1/2 по вопросам | ${VERDICT_RU[kp.verdict]} |`);
  lines.push(`| KW. Выигрыш заполнения над fallback | ${kw.arms.map((row) => `${row.arm} +${row.wins}${row.undetermined ? ` (?${row.undetermined})` : ''}`).join(', ')} | хотя бы один | ${VERDICT_RU[kw.verdict]} |`);
  lines.push('', '| Маршрут | F принят / не принят / без исхода | C принят / не принят / без исхода |', '| --- | --- | --- |');
  for (const row of result.acceptance) lines.push(`| ${short(row.route)} | ${row.F.accepted} / ${row.F.rejected} / ${row.F.unconfirmed} | ${row.C.accepted} / ${row.C.rejected} / ${row.C.unconfirmed} |`);
  const rc = result.recount;
  lines.push('', `A8 − S8 (только показано): исходно ${ppOf(rc.original.a8MinusS8)} п. п., fallback ${ppOf(rc.fallback.a8MinusS8)}, заполнение ${ppOf(rc.fill.a8MinusS8)} ${interval(rc.fill.a8MinusS8.interval)}.`);
  if (meta.money) lines.push('', `Расход v4: подтверждено ${usd2(meta.money.settledUsd)}, удержано ${usd2(meta.money.heldUsd)}, ${meta.money.posts} POST из ${meta.limits.maxPosts} (лимит ${usd2(meta.limits.maxUsd)}).`);
  lines.push('', `Полный отчёт — \`.runs/${V4_RUN}/report.md\`. Воспроизвести без сети:`, '', '```bash', 'node frontend/eval/finishProbeV4Cli.js --phase report', '```');
  return lines.join('\n');
}

// Analysis: one OpenRouter model writes it, another checks it.

export const V4_INSTRUCTION = [
  'You analyse the result of a measurement for the README of the project. The protocol and the report are given below as data.',
  'Write the body of a section titled "Анализ", in Russian, 150 to 300 words, as short paragraphs or a short list. No heading: the heading is added separately.',
  'Use only numbers that appear in the report. Do not introduce any other number.',
  'Cover: the decision and why the pre-set rule gives it; what the forms of the calls show; what the result can and cannot support; the main limits.',
  'Do not present any follow-up experiment as decided. You may say what stays open.',
  'Return only the text of the section.',
].join('\n');

export function v4AnalysisSection(text, check, writer, checker) {
  return [
    '#### Анализ (v4)',
    '',
    `_Текст написала модель ${writer} через OpenRouter по \`.runs/${V4_RUN}/report.md\` и протоколу v4; модель ${checker} сверила его с отчётом (замечаний: ${check.problems.length}). Claude этот текст не писал и не правил._`,
    '',
    String(text).trim(),
  ].join('\n');
}

async function runAnalysis(paths) {
  if (!existsSync(paths.reportMd)) throw new Error('Build the report first.');
  const { runAnalysis: writeAndCheckLive } = await import('./evalAnalysis.js');
  const rules = [PROTOCOL_V4, 'finish-probe-protocol.md'].map((name) => `# File ${name}\n\n${readFileSync(path.join(EVAL_ROOT, name), 'utf8')}`).join('\n\n');
  const record = await writeAndCheckLive({ dir: paths.analysis, instruction: V4_INSTRUCTION, rules, report: readFileSync(paths.reportMd, 'utf8'), limits: ANALYSIS_LIMITS, key: paidKey() });
  console.log(`analysis spend: settled $${record.spend.settledUsd.toFixed(4)}, ${record.spend.posts} POSTs`);
  if (!record.text) {
    console.log(`analysis not placed: ${record.reason}`);
    return 2;
  }
  const body = v4AnalysisSection(record.text, record.check, record.writer, record.checker);
  writeFileSync(path.join(paths.analysis, 'analysis.md'), `${body}\n`, 'utf8');
  const text = readFileSync(README, 'utf8');
  if (!text.includes(README_END)) throw new Error('Place the v4 block first (report --readme).');
  writeFileSync(README, placeBlock(text, ANALYSIS_START, ANALYSIS_END, body, README_END), 'utf8');
  console.log('analysis placed in README');
  return 0;
}

// Phases.

function runInspect(paths, source) {
  const cells = v4Cells(source.sources);
  const routes = v4Routes(source.selection);
  const keys = new Set(cells.map((cell) => cellKey(cell)));
  const out = {
    source: sourceRecord(source, cells),
    complete: source.rows.length === source.planned,
    cells: cells.length,
    duplicates: cells.length - keys.size,
    inputsBeforeSyntheses: cells.findIndex((cell) => cell.source.kind === 'synthesis') < 0 || cells.slice(cells.findIndex((cell) => cell.source.kind === 'synthesis')).every((cell) => cell.source.kind === 'synthesis'),
    byRoute: Object.fromEntries(routes.map((route) => [route.id, cells.filter((cell) => cell.model === route.id).length])),
    worst: worstCase(cells, source, routes),
    limits: V4_LIMITS,
  };
  writeJson(paths.inspect, out);
  console.log(JSON.stringify(out, null, 2));
  return out.duplicates || !out.inputsBeforeSyntheses ? 3 : 0;
}

function runReport(paths, source, argv, { dry, journals }) {
  const built = buildV4Report(paths, source, { dry, journals });
  writeJson(paths.report, built);
  writeFileSync(paths.reportMd, `${renderV4Report(built)}\n`, 'utf8');
  const block = renderV4Readme(built);
  writeFileSync(paths.readme, `${block}\n`, 'utf8');
  if (argv.includes('--readme')) {
    if (dry) throw new Error('A dry report does not go into the README.');
    const text = readFileSync(README, 'utf8');
    const next = placeBlock(text, README_START, README_END, block, AFTER);
    if (next !== text) writeFileSync(README, next, 'utf8');
  }
  console.log(`report written: ${paths.reportMd}`);
  console.log(`decision: ${built.result.decision.code}`);
  return 0;
}

export async function runFinishProbeV4Command(argv) {
  const phase = flagValue(argv, '--phase');
  const sourceId = flagValue(argv, '--source') || SOURCE_RUN;
  const dry = sourceId !== SOURCE_RUN;
  if (dry && !['inspect', 'report'].includes(phase)) throw new Error('Another source is allowed for inspect and a dry report only.');
  const live = argv.includes('--live');
  if (['run', 'analysis'].includes(phase) && !live) throw new Error(`${phase} posts only with --live`);
  const paths = v4Paths(dry ? `${V4_RUN}-dry-${sourceId}` : V4_RUN);
  if (phase === 'analysis') return runAnalysis(paths);
  const source = loadCampaignSource(sourceId, { goldFile: goldFileOf(sourceId) });
  if (phase === 'inspect') return runInspect(paths, source);
  if (phase === 'run') return runRun(paths, source);
  if (phase === 'report') {
    const listed = flagValue(argv, '--dry-journals');
    if (listed && !dry) throw new Error('--dry-journals is for a dry report only.');
    const journals = listed ? listed.split(',').map((file) => path.resolve(EVAL_ROOT, file.trim())) : [paths.events];
    return runReport(paths, source, argv, { dry, journals });
  }
  throw new Error('Usage: finishProbeV4Cli.js --phase inspect | run --live | report [--readme] | analysis --live [--source <run> for inspect and a dry report]');
}
