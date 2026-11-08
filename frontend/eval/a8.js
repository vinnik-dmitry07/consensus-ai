import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { freeEndpointsUrl } from '../src/engine/browser/freeRoster.js';
import { detectLoop, LOOP_GUARD_DEFAULTS } from '../src/engine/browser/loopGuard.js';
import { catalogueEntry, OPENROUTER_KEY_URL, OPENROUTER_MODELS_URL, queryModelResult } from '../src/engine/browser/openrouter.js';
import { settings } from '../src/engine/browser/settings.js';
import { taskPublicId } from './datasets.js';
import { answerPrompt, canonAnswer, gradeResponse, failureKind, LENIENT_RULES } from './grade.js';
import { BudgetPaused, createCampaignBudget } from './budget.js';
import { createSession, readSlotJournal, snapshotLocal, spentAttempts } from './runtime.js';
import { runIsolated } from './questionScope.js';
import { installTransport } from './transport.js';
import { COMPARISON_BRANCHES, runComparison } from './a8Variants.js';
import { applyGoldOverrides, lenientRows, renderA8Report, renderV5Report } from './a8Report.js';
import {
  chronologyGroup,
  EXTENSION_BLOCKS,
  LEGACY_BLOCKS,
  orderBlocks,
  primaryBlocksOf,
} from './a8Blocks.js';
import { extensionItemId, itemsDigest, legacyProvenance, loadExtensionBank, runPrepare } from './a8Prepare.js';
import {
  CALLS_PER_QUESTION,
  CAMPAIGN_ID,
  COUNCIL_SIZE,
  DEFAULT_JOBS,
  DEFAULT_MAX_RESUMES,
  DEFAULT_MODEL_IN_FLIGHT,
  DEV_PER_BLOCK,
  FORECAST_STRESS_FACTOR,
  MAX_ATTEMPTS,
  MAX_IN_FLIGHT,
  MAX_POSTS,
  MAX_USD,
  PILOT_PER_BLOCK,
  PRIMARY_PAIR,
  profileDocument,
  RESERVE_LIMIT,
  SCHEDULE_SEED,
  SELF_SAMPLES,
  SHORTLIST_LIMIT,
  SMOKE_COUNT,
  STAGE_CAPS,
  capsFrom,
  contextProblems,
  maxCommonCap,
  v5Policy,
} from './a8Profile.js';
import {
  chooseEndpoint,
  quoteReservation,
  routePolicy,
  selectFromDev,
  selectPaidShortlist,
} from './paid.js';
import { PUBLISHED_KEY_SHA256, TEST_COUNTS } from './protocol.js';
import { compareHash, sha256, stableStringify } from './util.js';
import { EvalInvariantError, isEvalInvariant } from './invariant.js';

const TEST_QUESTIONS = TEST_COUNTS.aime + TEST_COUNTS.gpqa + TEST_COUNTS.mmlu;

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(EVAL_ROOT, '.runs');
const BANK_PATH = path.join(EVAL_ROOT, '.cache', 'bank.json');
// Every local module a8.js loads, directly or not. A test keeps this list
// equal to the import closure, so no module that shapes a call, a schedule,
// or a grade can change without changing the hash.
export const SOURCE_FILES = [
  'a8.js',
  'a8Variants.js',
  'a8Report.js',
  'a8Profile.js',
  'paid.js',
  'budget.js',
  'transport.js',
  'runtime.js',
  'grade.js',
  'protocol.js',
  'variants.js',
  'invariant.js',
  'report.js',
  'a8Blocks.js',
  'a8Prepare.js',
  'datasets.js',
  'questionScope.js',
  'sources.js',
  'util.js',
  '../src/engine/browser/council.js',
  '../src/engine/browser/openrouter.js',
  '../src/engine/browser/loopGuard.js',
  '../src/engine/browser/roster.js',
  '../src/engine/browser/settings.js',
  '../src/engine/browser/freeRoster.js',
];

// The commit the method runs on, and every hashed file that differs from it
// or is not tracked. Preflight of an extended campaign refuses a dirty method:
// the protocol commits the code first.
export function gitState(files = SOURCE_FILES, cwd = EVAL_ROOT) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const head = git(['rev-parse', 'HEAD']).trim();
    // Each porcelain line is "XY path"; X may be a space, so lines are not trimmed.
    const status = git(['status', '--porcelain', '--untracked-files=all', '--', ...files]);
    const dirty = status.split('\n').filter((line) => line.trim()).map((line) => line.slice(3).trim());
    return { head, dirty };
  } catch (error) {
    return { head: null, dirty: null, error: error instanceof Error ? error.message : String(error) };
  }
}

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
  return readFileSync(file, 'utf8').split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  return argv[index + 1] ?? null;
}

function loadPaidKey() {
  const key = String(process.env.or_key || process.env.OR_KEY || '').trim();
  if (!key) throw new Error('or_key is missing');
  if (sha256(key) === PUBLISHED_KEY_SHA256) throw new Error('Refusing the published OpenRouter key.');
  return key;
}

function acquireLock(dir) {
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
      // The lock is already gone.
    }
  };
}

export function sourceHash() {
  const parts = SOURCE_FILES.map((relative) => {
    const file = path.join(EVAL_ROOT, relative);
    return `${relative}\n${sha256(readFileSync(file, 'utf8'))}`;
  });
  return sha256(parts.join('\n'));
}

// The base bank as v1-v4 pinned it. An extended campaign adds the items of
// its chosen extension blocks and pins their own digest beside this one.
function loadBank(campaign = null) {
  const bank = readJson(BANK_PATH);
  if (!bank?.items) throw new Error('No cached bank. Run prepare first.');
  const base = bank.items.map((item) => ({
    ...item,
    id: `${item.split}:${taskPublicId(item)}`,
    provenance: item.provenance || legacyProvenance(item),
  }));
  const digest = sha256(stableStringify(base.map((item) => ({
    split: item.split,
    block: item.block,
    dataset: item.dataset,
    sourceId: item.sourceId,
    kind: item.kind,
    gold: item.goldCanon,
    fingerprint: item.fingerprint,
    choiceCount: item.choiceCount,
  }))));
  if (!campaign?.bankExtension) return { bank, items: base, digest, extensionDigest: null, extension: null };
  const blocks = new Set(campaign.blocks || []);
  const extension = loadExtensionBank();
  const added = extension.items
    .filter((item) => blocks.has(item.block))
    .map((item) => ({ ...item, id: extensionItemId(item) }));
  const items = [...base.filter((item) => blocks.has(item.block)), ...added];
  return { bank, items, digest, extensionDigest: itemsDigest(added), extension };
}

export function bankCounts(items) {
  const counts = { smoke: 0, dev: 0, test: 0, blocks: {} };
  for (const item of items) {
    counts[item.split] = (counts[item.split] || 0) + 1;
    counts.blocks[item.block] ||= { dev: 0, smoke: 0, test: 0 };
    counts.blocks[item.block][item.split] = (counts.blocks[item.block][item.split] || 0) + 1;
  }
  return counts;
}

function pathsFor(runId) {
  const dir = path.join(RUNS_ROOT, runId);
  return {
    dir,
    campaign: path.join(dir, 'campaign.json'),
    budget: path.join(dir, 'budget.jsonl'),
    preflight: path.join(dir, 'preflight.json'),
    probe: path.join(dir, 'probe'),
    dev: path.join(dir, 'dev'),
    selection: path.join(dir, 'selection.json'),
    comparison: path.join(dir, 'comparison'),
    reconcile: path.join(dir, 'reconcile'),
    reports: path.join(dir, 'reports'),
  };
}

function questionFile(dir, id) {
  return path.join(dir, `${String(id).replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`);
}

// Round-robin over every block present, each in seeded order. The loop is
// bounded by the longest block, so an unknown or empty block cannot stall it,
// and every item appears exactly once.
export function interleave(items, seed = SCHEDULE_SEED) {
  const blocks = orderBlocks(items.map((item) => item.block));
  const groups = blocks.map((block) => (
    items.filter((item) => item.block === block).sort((left, right) => compareHash(seed, left.id, right.id))
  ));
  const longest = Math.max(0, ...groups.map((group) => group.length));
  const order = [];
  for (let index = 0; index < longest; index += 1) {
    for (const group of groups) {
      if (group[index]) order.push(group[index]);
    }
  }
  return order;
}

// Test order. A campaign with primary blocks runs all of them before the
// legacy blocks, so a budget stop leaves the secondary comparison short, not
// the primary one. Older campaigns keep the single interleave.
export function testOrder(items, primaryBlocks = [], seed = SCHEDULE_SEED) {
  if (!primaryBlocks?.length) return interleave(items, seed);
  const primary = items.filter((item) => primaryBlocks.includes(item.block));
  const rest = items.filter((item) => !primaryBlocks.includes(item.block));
  return [...interleave(primary, seed), ...interleave(rest, seed)];
}

// Stages of a test run. A campaign with primary blocks finishes every primary
// question before the first legacy question is sent: with many workers, one
// queue would let legacy questions spend while primary ones still wait on a
// retry or a cooldown.
export function testStages(order, items, primaryBlocks = []) {
  if (!primaryBlocks?.length) return [order];
  const blockOf = new Map(items.map((item) => [item.id, item.block]));
  const primary = order.filter((id) => primaryBlocks.includes(blockOf.get(id)));
  const legacy = order.filter((id) => !primaryBlocks.includes(blockOf.get(id)));
  return [primary, legacy];
}

// Runs stages in order. A stage that stops (pause, fatal, unfinished) leaves
// every later stage unstarted.
export async function runStages(stages, runStage) {
  for (const [index, ids] of stages.entries()) {
    if (!ids.length) continue;
    const code = await runStage(ids, index);
    if (code) return code;
  }
  return 0;
}

async function fetchJson(url, key) {
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(url, { headers });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function openBudget(campaignPaths, prices, campaign) {
  const budget = createCampaignBudget({
    maxUsd: campaign.maxUsd,
    maxPosts: campaign.maxPosts,
    prices,
    onEvent: (event) => appendFileSync(campaignPaths.budget, `${JSON.stringify(event)}\n`, 'utf8'),
  });
  budget.applyJournal(readJsonl(campaignPaths.budget));
  // A replaying campaign continues the runs it reuses: their spend and posts
  // count against the same cap.
  const carried = campaign.carriedSpend;
  if (carried) {
    budget.state.settledUsd += Number(carried.settledUsd || 0);
    budget.state.unresolvedUsd += Number(carried.unresolvedUsd || 0);
    budget.state.posts += Number(carried.posts || 0);
  }
  return budget;
}

function journalSpend(file, campaign = {}) {
  const replayed = createCampaignBudget({
    maxUsd: campaign.maxUsd || MAX_USD,
    maxPosts: campaign.maxPosts || MAX_POSTS,
    prices: {},
  });
  replayed.applyJournal(readJsonl(file));
  return {
    settledUsd: replayed.state.settledUsd,
    unresolvedUsd: replayed.state.unresolvedUsd,
    posts: replayed.state.posts,
  };
}

const REFUSED_SOURCES = new Set(['main', 'a8-strong-v1']);

function assertReplaySource(id, runId) {
  if (!id || REFUSED_SOURCES.has(id) || id.includes('repair') || id.includes('complete') || id === runId) {
    throw new Error(`Refusing replay source ${id || '(empty)'}.`);
  }
  if (!existsSync(pathsFor(id).campaign)) throw new Error(`Replay source ${id} has no campaign.json.`);
}

function journalsOf(runId) {
  const paths = pathsFor(runId);
  const files = [
    path.join(paths.probe, 'events.jsonl'),
    path.join(paths.dev, 'events.jsonl'),
    path.join(paths.reconcile, 'events.jsonl'),
  ];
  if (existsSync(paths.comparison)) {
    for (const name of readdirSync(paths.comparison).sort()) {
      files.push(path.join(paths.comparison, name, 'events.jsonl'));
    }
  }
  return files.filter((file) => existsSync(file));
}

// Slots another run may lend this one. A slot is lent only under its exact key,
// which carries the hash of the full request, so a different prompt, route,
// cap, or order never matches. Answered slots are reused whatever they say.
// A slot that used every allowed attempt is reused as a failure. Any other
// slot is called again here, and the attempts it already spent count. Spent
// means real attempts: a refusal before generation and a POST cut off when the
// source's runner stopped are carried in `free`, so they are not counted.
export function loadReplaySources(runIds, { maxAttempts = MAX_ATTEMPTS, journals = journalsOf } = {}) {
  const reuse = new Map();
  const prior = new Map();
  const free = new Map();
  for (const id of runIds) {
    for (const file of journals(id)) {
      for (const [key, slot] of readSlotJournal(file)) {
        if (String(slot.meta?.model || '').endsWith(':free')) continue;
        if (reuse.has(key)) continue;
        const attempts = slot.httpAttempts || 0;
        const answered = slot.state === 'completed' && slot.result?.ok === true;
        const exhausted = slot.state === 'failed' && spentAttempts(slot) >= maxAttempts;
        if (answered || exhausted) {
          reuse.set(key, { ...slot, sourceRun: id });
          prior.delete(key);
          free.delete(key);
        } else if (attempts > 0) {
          prior.set(key, Math.max(prior.get(key) || 0, attempts));
          const unspent = attempts - spentAttempts(slot);
          if (unspent > 0) free.set(key, Math.max(free.get(key) || 0, unspent));
        }
      }
    }
  }
  return { reuse, prior, free };
}

function replaySources(campaign) {
  if (!campaign?.replayFrom?.length) return null;
  const replay = loadReplaySources(campaign.replayFrom);
  console.log(
    `replay sources ${campaign.replayFrom.join(', ')}: ${replay.reuse.size} reusable slots, `
    + `${replay.prior.size} slots with spent attempts`,
  );
  return replay;
}

function priceMap(preflight) {
  const map = {};
  for (const route of preflight.routes || []) map[route.id] = route.pricing;
  return map;
}

// Caps and the stream deadline come from the campaign, so a run keeps the
// values its preflight fixed even after the profile defaults change.
export function policyFrom(preflight, campaign = null) {
  const routes = {};
  for (const route of preflight.routes || []) routes[route.id] = route;
  return {
    caps: campaign?.stageCaps || STAGE_CAPS,
    timeout: campaign?.streamTimeoutSeconds ?? null,
    loopGuard: campaign?.loopGuard || null,
    annotate: campaign?.evalAnnotations === true,
    contextCheck: campaign?.contextCheck === true,
    routes,
  };
}

function assertSnapshot(file, label) {
  const saved = readJson(file);
  if (!saved) return false;
  if (saved.sourceHash !== sourceHash()) {
    throw new Error(`${label} source hash changed after it was recorded. Refusing to mix methods.`);
  }
  return true;
}

function sameSource(stored, label) {
  if (stored !== sourceHash()) {
    throw new Error(`${label} source hash does not match this code. Refusing to mix methods.`);
  }
}

function sessionBudget(replay = null) {
  return {
    retainRoster: true,
    retryAfterCooldown: true,
    retryLimit: MAX_ATTEMPTS,
    ...(replay ? {
      replayFrom: replay.reuse,
      priorAttempts: replay.prior,
      priorFreeAttempts: replay.free,
      aliasOf: (model) => model,
      replayTerminal: true,
    } : {}),
  };
}

function assertCompatible(campaignPaths, phase) {
  const campaign = readJson(campaignPaths.campaign);
  if (!campaign) throw new Error('Run preflight before this phase.');
  sameSource(campaign.sourceHash, 'Campaign');
  const bank = loadBank(campaign);
  if (campaign.bankDigest !== bank.digest) throw new Error('Bank digest does not match the campaign.');
  if (campaign.bankExtension && campaign.bankExtension.digest !== bank.extensionDigest) {
    throw new Error('Extension bank items do not match the campaign.');
  }
  if (campaign.counts && stableStringify(campaign.counts) !== stableStringify(bankCounts(bank.items))) {
    throw new Error('Bank counts do not match the campaign.');
  }
  if (phase === 'probe') return { campaign, bank };
  const preflight = readJson(campaignPaths.preflight);
  if (!preflight?.routes?.length) throw new Error('Preflight has no paid routes.');
  return { campaign, bank, preflight };
}

function positiveFlag(argv, name, fallback) {
  const raw = flagValue(argv, name);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} needs a positive number`);
  return Math.trunc(value);
}

export function runFlags(argv) {
  const jobs = positiveFlag(argv, '--jobs', DEFAULT_JOBS);
  return {
    jobs,
    inFlight: positiveFlag(argv, '--in-flight', jobs * CALLS_PER_QUESTION),
    modelInFlight: positiveFlag(argv, '--model-in-flight', DEFAULT_MODEL_IN_FLIGHT),
    maxResumes: positiveFlag(argv, '--max-resumes', DEFAULT_MAX_RESUMES),
  };
}

// Fields whose change would alter a score without changing the request. A
// replay source must agree on all of them, or its slots are not this method's
// slots.
const REPLAY_PROFILE_FIELDS = [
  'maxAttempts', 'councilSize', 'selfSamples', 'temperature', 'topP',
  'nSamples', 'topK', 'selfExclusion', 'scheduleSeed', 'redTeam', 'generationSeed',
  'loopGuard', 'tailRule',
];
// Fields a source may differ on. A cap is part of the request, so the request
// hash already keeps a slot made under another cap from being reused. The
// difference is recorded in campaign.json for the reader.
const REPLAY_REPORTED_FIELDS = ['stageCaps', 'streamTimeoutSeconds'];

export function compareReplayProfile(id, sourceCampaign, profile) {
  for (const field of REPLAY_PROFILE_FIELDS) {
    if (stableStringify(sourceCampaign[field] ?? null) !== stableStringify(profile[field] ?? null)) {
      throw new Error(`Replay source ${id} differs on ${field}.`);
    }
  }
  const differences = {};
  for (const field of REPLAY_REPORTED_FIELDS) {
    const theirs = sourceCampaign[field] ?? null;
    if (stableStringify(theirs) !== stableStringify(profile[field] ?? null)) differences[field] = theirs;
  }
  return differences;
}

function checkBankCounts(items) {
  const counts = {
    smoke: items.filter((item) => item.split === 'smoke').length,
    dev: items.filter((item) => item.split === 'dev').length,
    test: items.filter((item) => item.split === 'test').length,
  };
  if (counts.smoke !== SMOKE_COUNT || counts.dev !== DEV_PER_BLOCK * 3 || counts.test !== TEST_QUESTIONS) {
    throw new Error(`Unexpected bank counts ${JSON.stringify(counts)}`);
  }
}

// Starts a campaign that reuses earlier runs. It takes the first source's
// route snapshot as is: a fresh catalogue read could pick another endpoint,
// and a changed provider changes every request hash. No network calls.
async function inheritPreflight(campaignPaths, runId, fromIds, caps = STAGE_CAPS) {
  for (const id of fromIds) assertReplaySource(id, runId);
  const existing = readJson(campaignPaths.campaign);
  if (existing) {
    if ((existing.replayFrom || []).join(',') !== fromIds.join(',')) {
      throw new Error('This campaign already exists with other replay sources.');
    }
    sameSource(existing.sourceHash, 'Campaign');
    console.log(`preflight already inherited from ${existing.inheritedPreflightFrom}`);
    return 0;
  }
  const { items, digest, bank } = loadBank();
  checkBankCounts(items);
  const profile = profileDocument(caps);
  const runs = [];
  const sourceDifferences = {};
  for (const id of fromIds) {
    const source = pathsFor(id);
    const sourceCampaign = readJson(source.campaign);
    if (sourceCampaign.bankDigest !== digest) throw new Error(`Replay source ${id} used another bank.`);
    const differences = compareReplayProfile(id, sourceCampaign, profile);
    if (Object.keys(differences).length) sourceDifferences[id] = differences;
    runs.push({ run: id, ...journalSpend(source.budget, sourceCampaign) });
  }
  const sourcePreflight = readJson(pathsFor(fromIds[0]).preflight);
  if (!sourcePreflight?.routes?.length) throw new Error(`Replay source ${fromIds[0]} has no route snapshot.`);
  // The inherited routes were admitted against the source's caps. Each one
  // must be able to emit the largest cap of this campaign.
  const largestCap = Math.max(...Object.values(profile.stageCaps));
  for (const route of sourcePreflight.routes) {
    if (route.maxCompletion != null && route.maxCompletion < largestCap) {
      throw new Error(`Route ${route.id} (${route.tag}) allows ${route.maxCompletion} completion tokens, below the ${largestCap} cap.`);
    }
  }
  writeJson(campaignPaths.preflight, {
    ...sourcePreflight,
    inheritedFrom: fromIds[0],
    inheritedAt: new Date().toISOString(),
  });
  const carriedSpend = runs.reduce((sum, row) => ({
    settledUsd: sum.settledUsd + row.settledUsd,
    unresolvedUsd: sum.unresolvedUsd + row.unresolvedUsd,
    posts: sum.posts + row.posts,
    runs: sum.runs,
  }), { settledUsd: 0, unresolvedUsd: 0, posts: 0, runs });
  writeJson(campaignPaths.campaign, {
    id: runId,
    ...profile,
    primaryPair: PRIMARY_PAIR,
    bankProtocolHash: bank.protocolHash,
    bankDigest: digest,
    sourceHash: sourceHash(),
    createdAt: new Date().toISOString(),
    replayFrom: fromIds,
    inheritedPreflightFrom: fromIds[0],
    carriedSpend,
    sourceDifferences,
  });
  console.log(
    `preflight inherited ${sourcePreflight.routes.length} routes from ${fromIds[0]}; `
    + `carried spend $${carriedSpend.settledUsd.toFixed(4)} settled, $${carriedSpend.unresolvedUsd.toFixed(4)} unresolved, `
    + `${carriedSpend.posts} posts`,
  );
  console.log(
    `preflight caps stage1 ${profile.stageCaps.stage1} stage2 ${profile.stageCaps.stage2} final ${profile.stageCaps.stage3}; `
    + `stream deadline ${profile.streamTimeoutSeconds}s`,
  );
  for (const [id, differences] of Object.entries(sourceDifferences)) {
    console.log(`preflight source ${id} differs on ${Object.keys(differences).join(', ')}; only slots with an identical request are reused`);
  }
  return 0;
}

// Listing dates of the models in the cached catalogue. A listing date is when
// OpenRouter added the model, not its knowledge cutoff.
function listingDates(ids) {
  const catalogue = readJson(path.join(EVAL_ROOT, '.cache', 'catalogue.json'), {});
  const rows = Array.isArray(catalogue?.models) ? catalogue.models : [];
  const out = {};
  for (const id of ids) {
    const row = rows.find((item) => item.id === id);
    out[id] = row?.created ? new Date(row.created * 1000).toISOString().slice(0, 10) : null;
  }
  return { fetchedAt: catalogue?.fetchedAt || null, dates: out };
}

// Starts an extended campaign on another run's route snapshot. Only the
// routes come over: no slot is replayed and no spend is carried. No network.
export async function routesPreflight(campaignPaths, runId, options) {
  const {
    routesFrom,
    capsMode = null,
    capFlags = {},
    blocks: requested = [],
    maxUsd = MAX_USD,
    maxPosts = MAX_POSTS,
    replayFrom: fromIds = null,
  } = options;
  const existing = readJson(campaignPaths.campaign);
  if (existing) {
    if (existing.routesInheritedFrom !== routesFrom) throw new Error('This campaign already exists with other routes.');
    if ((existing.replayFrom || []).join(',') !== (fromIds || []).join(',')) {
      throw new Error('This campaign already exists with other replay sources.');
    }
    sameSource(existing.sourceHash, 'Campaign');
    console.log(`preflight already done on routes from ${existing.routesInheritedFrom}`);
    return 0;
  }
  if (!routesFrom || routesFrom === runId) throw new Error('--routes-from needs another run.');
  const git = (options.gitState || gitState)();
  if (!git.head) throw new Error(`Cannot read the git commit (${git.error || 'unknown'}). Preflight pins the commit it runs on.`);
  if (git.dirty.length) {
    throw new Error(`Commit the method before preflight. Changed or untracked hashed files: ${git.dirty.join(', ')}`);
  }
  const sourcePreflight = readJson(pathsFor(routesFrom).preflight);
  if (!sourcePreflight?.routes?.length) throw new Error(`Run ${routesFrom} has no route snapshot.`);
  const candidates = sourcePreflight.candidates || [];
  const candidateRoutes = sourcePreflight.routes.filter((route) => candidates.includes(route.id));
  if (candidateRoutes.length < COUNCIL_SIZE) throw new Error(`Run ${routesFrom} has only ${candidateRoutes.length} candidates.`);
  let caps;
  if (capsMode === 'max') {
    if (Object.values(capFlags).some((value) => value != null)) {
      throw new Error('Use either --caps max or explicit cap flags.');
    }
    const cap = maxCommonCap(candidateRoutes);
    caps = capsFrom({ stage1: cap, stage2: cap, stage3: cap });
  } else if (capsMode != null) {
    throw new Error(`Unknown --caps ${capsMode}`);
  } else {
    caps = capsFrom(capFlags);
  }
  const largest = Math.max(...Object.values(caps));
  const problems = candidateRoutes.flatMap((route) => contextProblems(route, largest));
  if (problems.length) throw new Error(`Routes cannot take a ${largest}-token cap: ${problems.join('; ')}`);
  const unknown = requested.filter((block) => !EXTENSION_BLOCKS.includes(block));
  if (unknown.length) throw new Error(`Unknown blocks ${unknown.join(', ')}`);
  const extra = orderBlocks(requested);
  const blocks = orderBlocks([...LEGACY_BLOCKS, ...extra]);
  const loaded = loadBank({ blocks, bankExtension: { blocks: extra } });
  for (const block of extra) {
    if (!loaded.items.some((item) => item.block === block && item.split === 'test')) {
      throw new Error(`Block ${block} has no test items. Run a8 --phase prepare.`);
    }
  }
  const counts = bankCounts(loaded.items);
  const routeIds = sourcePreflight.routes.map((route) => route.id);
  const coverage = {};
  for (const [name, row] of Object.entries(loaded.extension.coverage || {})) {
    if (extra.includes(row.block)) coverage[name] = row;
  }
  writeJson(campaignPaths.preflight, {
    ...sourcePreflight,
    routesInheritedFrom: routesFrom,
    inheritedAt: new Date().toISOString(),
  });
  const profile = profileDocument(caps, { ...v5Policy(), smokeCount: counts.smoke });
  const replay = fromIds?.length
    ? extendedReplay(runId, fromIds, {
      profile, blocks, routesFrom, maxUsd, maxPosts, digest: loaded.digest, extensionDigest: loaded.extensionDigest,
    })
    : null;
  writeJson(campaignPaths.campaign, {
    id: runId,
    ...profile,
    maxUsd,
    maxPosts,
    primaryPair: PRIMARY_PAIR,
    blocks,
    primaryBlocks: primaryBlocksOf(blocks),
    bankProtocolHash: loaded.bank.protocolHash,
    bankDigest: loaded.digest,
    bankExtension: {
      file: '.cache/bank-a8x.json',
      blocks: extra,
      digest: loaded.extensionDigest,
      bankVersion: loaded.extension.version,
      sources: Object.fromEntries(Object.entries(loaded.extension.sources || {})
        .filter(([name]) => coverage[name])),
      coverage,
    },
    counts,
    routesInheritedFrom: routesFrom,
    modelListings: listingDates(routeIds),
    sourceHash: sourceHash(),
    gitHead: git.head,
    createdAt: new Date().toISOString(),
    ...(replay ? { replayFrom: fromIds, carriedSpend: replay.carriedSpend } : {}),
  });
  console.log(`preflight: commit ${git.head.slice(0, 12)}, source hash ${sourceHash().slice(0, 12)}`);
  if (replay) {
    const carried = replay.carriedSpend;
    console.log(
      `preflight: routes from ${routesFrom}, ${candidateRoutes.length} candidates; replays every identical request of ${fromIds.join(', ')}; `
      + `carried spend $${carried.settledUsd.toFixed(4)} settled, $${carried.unresolvedUsd.toFixed(4)} unresolved, ${carried.posts} posts`,
    );
  } else {
    console.log(`preflight: routes from ${routesFrom}, ${candidateRoutes.length} candidates, no replay, no carried spend`);
  }
  console.log(`preflight caps: one cap of ${largest} tokens on every stage; stream deadline ${profile.streamTimeoutSeconds}s`);
  console.log(`preflight blocks: ${blocks.join(', ')}; primary ${primaryBlocksOf(blocks).join(', ')}`);
  console.log(`preflight counts: smoke ${counts.smoke}, dev ${counts.dev}, test ${counts.test}; budget $${maxUsd} / ${maxPosts} POSTs`);
  const primaryTest = primaryBlocksOf(blocks).reduce((sum, block) => sum + (counts.blocks[block]?.test || 0), 0);
  console.log(`preflight test: ${primaryTest} primary questions (${primaryBlocksOf(blocks).join(', ')}), then ${counts.test - primaryTest} legacy (${LEGACY_BLOCKS.join(', ')})`);
  return 0;
}

// A v5 campaign that continues another v5 campaign under a fixed runtime. It
// replays every slot whose request is identical, so the source must agree on
// everything that shapes a request or a score: routes, bank, blocks, caps and
// the profile. Its spend and POSTs count against the same caps, which must be
// the source's caps. No network calls.
export function extendedReplay(
  runId,
  fromIds,
  expected,
  { readCampaign = (id) => readJson(pathsFor(id).campaign), readSpend = journalSpend, assertSource = assertReplaySource } = {},
) {
  const runs = [];
  for (const id of fromIds) {
    assertSource(id, runId);
    const source = readCampaign(id);
    if (!source) throw new Error(`Replay source ${id} has no campaign.json.`);
    const mismatch = [
      ['routes', source.routesInheritedFrom, expected.routesFrom],
      ['bank', source.bankDigest, expected.digest],
      ['bank extension', source.bankExtension?.digest, expected.extensionDigest],
      ['blocks', (source.blocks || []).join(','), expected.blocks.join(',')],
      ['maxUsd', source.maxUsd, expected.maxUsd],
      ['maxPosts', source.maxPosts, expected.maxPosts],
    ].find(([, theirs, ours]) => stableStringify(theirs ?? null) !== stableStringify(ours ?? null));
    if (mismatch) throw new Error(`Replay source ${id} differs on ${mismatch[0]}.`);
    const differences = compareReplayProfile(id, source, expected.profile);
    if (Object.keys(differences).length) {
      throw new Error(`Replay source ${id} differs on ${Object.keys(differences).join(', ')}; nothing would be reused.`);
    }
    runs.push({ run: id, ...readSpend(pathsFor(id).budget, source) });
  }
  const carriedSpend = runs.reduce((sum, row) => ({
    settledUsd: sum.settledUsd + row.settledUsd,
    unresolvedUsd: sum.unresolvedUsd + row.unresolvedUsd,
    posts: sum.posts + row.posts,
    runs: sum.runs,
  }), { settledUsd: 0, unresolvedUsd: 0, posts: 0, runs });
  return { carriedSpend };
}

async function preflight(campaignPaths, live, caps = STAGE_CAPS) {
  if (!live) {
    const saved = readJson(campaignPaths.preflight);
    if (!saved) throw new Error('Dry-run preflight needs a saved snapshot.');
    console.log(`preflight dry-run: ${saved.routes?.length || 0} routes`);
    return 0;
  }
  const probeDir = campaignPaths.probe;
  const probeStarted = ['results.json', 'rows.json', 'source.json', 'events.jsonl'].some((name) => (
    existsSync(path.join(probeDir, name))
  ));
  if (probeStarted) {
    throw new Error('Probe already started. Refusing to rewrite the route snapshot.');
  }
  const { items, digest, bank } = loadBank();
  checkBankCounts(items);
  console.log('preflight: reading the weekly catalogue');
  const weekly = await fetchJson(`${OPENROUTER_MODELS_URL}?sort=top-weekly`);
  const rows = Array.isArray(weekly.body?.data) ? weekly.body.data : [];
  if (weekly.status !== 200 || !rows.length) throw new Error(`Catalogue HTTP ${weekly.status}`);
  const models = rows.map((row, index) => ({ ...row, weeklyRank: index + 1 }));
  const shortlist = selectPaidShortlist(models);
  const pool = [...shortlist.candidates, ...shortlist.reserves];
  console.log(`preflight: checking ${pool.length} endpoint lists`);
  const routes = [];
  const rejected = [];
  for (let index = 0; index < pool.length; index += 1) {
    const model = pool[index];
    const url = freeEndpointsUrl(model.id);
    console.log(`preflight endpoint ${index + 1}/${pool.length} ${model.id}`);
    const payload = url ? await fetchJson(url) : { status: 0, body: null };
    const endpoints = payload.body?.data?.endpoints || [];
    const choice = chooseEndpoint(endpoints);
    if (!choice.endpoint) {
      rejected.push({ id: model.id, reason: 'no-qualified-route', rejected: choice.rejected });
      continue;
    }
    const policy = routePolicy(model, choice.endpoint);
    if (!policy) {
      rejected.push({ id: model.id, reason: 'unbounded-price' });
      continue;
    }
    routes.push({
      ...policy,
      catalogue: catalogueEntry(rows.find((row) => row.id === model.id) || {}, model.weeklyRank),
      quality: {
        source: shortlist.qualitySource,
        score: model.score,
        weeklyRank: model.weeklyRank,
      },
    });
  }
  // chooseEndpoint admits a route that can emit MIN_COMPLETION tokens. A
  // campaign with a larger cap needs the route to reach that cap too.
  const largestCap = Math.max(...Object.values(caps));
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    const route = routes[index];
    if (route.maxCompletion != null && route.maxCompletion < largestCap) {
      rejected.push({ id: route.id, reason: 'completion-cap', maxCompletion: route.maxCompletion, cap: largestCap });
      routes.splice(index, 1);
    }
  }
  if (routes.length < COUNCIL_SIZE) throw new Error(`Only ${routes.length} paid routes qualified.`);
  const synthesisTokens = (SELF_SAMPLES * caps.stage1) + 4000;
  for (const route of routes.slice(0, SHORTLIST_LIMIT)) {
    const fits = route.context == null || synthesisTokens <= route.context;
    const quote = quoteReservation({
      pricing: route.pricing,
      promptTokens: Math.min(synthesisTokens, route.context || synthesisTokens),
      maxTokens: caps.stage3,
    });
    console.log(
      `preflight synthesis ${route.id} fits=${fits} `
      + `quote=${quote ? quote.usd.toFixed(4) : 'unbounded'} quantization=${route.quantization ?? 'unknown'}`,
    );
    if (!fits) console.log(`preflight ${route.id} context cannot hold five full Stage 1 answers; answers are not truncated`);
  }
  let keyLimitRemaining = null;
  if (process.env.or_key || process.env.OR_KEY) {
    const paidKey = loadPaidKey();
    try {
      const keyInfo = await fetchJson(OPENROUTER_KEY_URL, paidKey);
      const data = keyInfo.body?.data || {};
      keyLimitRemaining = data.limit_remaining === undefined ? null : data.limit_remaining;
    } catch {
      keyLimitRemaining = null;
    }
  }
  const preflightDoc = {
    retrievedAt: new Date().toISOString(),
    qualitySource: shortlist.qualitySource,
    routes,
    rejected,
    candidates: routes.slice(0, SHORTLIST_LIMIT).map((route) => route.id),
    reserves: routes.slice(SHORTLIST_LIMIT).map((route) => route.id),
    accountBalance: 'unknown',
    keyLimitRemaining,
  };
  const existing = readJson(campaignPaths.campaign);
  if (existing?.sourceHash && existing.sourceHash !== sourceHash()) {
    throw new Error('Campaign source hash changed. Refusing to rewrite this run.');
  }
  writeJson(campaignPaths.preflight, preflightDoc);
  const campaign = existing || {
    id: path.basename(campaignPaths.dir),
    ...profileDocument(caps),
    primaryPair: PRIMARY_PAIR,
    bankProtocolHash: bank.protocolHash,
    bankDigest: digest,
    sourceHash: sourceHash(),
    createdAt: new Date().toISOString(),
  };
  if (existing && (existing.maxUsd !== campaign.maxUsd || existing.bankDigest !== digest)) {
    throw new Error('Existing campaign limits or bank digest do not match.');
  }
  writeJson(campaignPaths.campaign, campaign);
  console.log(`preflight: ${routes.length} billable routes, candidates ${preflightDoc.candidates.join(', ')}`);
  return 0;
}

const GENERATION_URL = 'https://openrouter.ai/api/v1/generation';

// Key-level spend as an audit event. Other requests on the key and billing
// delay make it unusable for releasing a single reserve, so it never does.
async function auditKey(budget, phase, moment) {
  if (!(process.env.or_key || process.env.OR_KEY)) return null;
  try {
    const info = await fetchJson(OPENROUTER_KEY_URL, loadPaidKey());
    const data = info.body?.data || {};
    return budget.audit({
      phase,
      moment,
      status: info.status,
      usage: data.usage ?? null,
      limitRemaining: data.limit_remaining ?? null,
    });
  } catch (error) {
    return budget.audit({ phase, moment, error: error instanceof Error ? error.message : String(error) });
  }
}

function generationIds(files) {
  const ids = new Map();
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"generationId"')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.kind === 'http' && event.phase === 'finished' && event.attemptId && event.generationId) {
        ids.set(event.attemptId, event.generationId);
      }
    }
  }
  return ids;
}

// Asks OpenRouter what each unresolved attempt really cost. A cost it does
// not report (no id, 404, an unfinished record, a failed GET) stays held.
export async function reconcileBudget(campaignPaths, budget, {
  log = console.log,
  fetchImpl = fetchJson,
  journals = null,
} = {}) {
  const pending = budget.unresolvedAttempts();
  const summary = { unresolved: pending.length, lookedUp: 0, settled: 0, withoutId: 0 };
  if (!pending.length) return summary;
  const ids = generationIds(journals || journalsOf(path.basename(campaignPaths.dir)));
  const key = loadPaidKey();
  for (const row of pending) {
    const generationId = ids.get(row.attemptId);
    if (!generationId) {
      summary.withoutId += 1;
      continue;
    }
    summary.lookedUp += 1;
    let info;
    try {
      info = await fetchImpl(`${GENERATION_URL}?id=${encodeURIComponent(generationId)}`, key);
    } catch {
      continue;
    }
    const cost = info?.status === 200 ? info.body?.data?.total_cost : null;
    if (cost == null) continue;
    if (budget.resettle({ attemptId: row.attemptId, cost, source: `generation:${generationId}` }).applied) {
      summary.settled += 1;
    }
  }
  log(
    `reconcile: ${summary.unresolved} unresolved reserves, ${summary.lookedUp} looked up, `
    + `${summary.settled} settled, ${summary.withoutId} without a generation id; `
    + `held now $${budget.state.unresolvedUsd.toFixed(4)}`,
  );
  return summary;
}

// The exact total cost of a run's reserves that no generation record prices,
// such as streams cut when its runner stopped. It needs the key's usage at two
// moments with only this run's POSTs between them: the run's first audit,
// taken before its first POST, and the next run's first audit, taken before
// that run's first POST. What the key spent between them, less every cost
// the run already knows, is what the held reserves cost together. The total
// is measured; the split over the held reserves goes by reserve size.
const RESIDUAL_TOLERANCE_USD = 1e-6;

export function keyResidual({ before, after, settledUsd, held }) {
  if (![before, after, settledUsd].every(Number.isFinite)) throw new Error('Key residual needs both usage audits and the settled spend.');
  const reserved = held.reduce((sum, row) => sum + Number(row.usd || 0), 0);
  let total = after - before - settledUsd;
  if (total < -RESIDUAL_TOLERANCE_USD) {
    throw new Error(`The key spent $${(after - before).toFixed(9)} but the run settled $${settledUsd.toFixed(9)}: something else is missing from the run's ledger.`);
  }
  if (total > reserved + RESIDUAL_TOLERANCE_USD) {
    throw new Error(`The key spent $${total.toFixed(9)} more than the run settled, above its $${reserved.toFixed(9)} of held reserves: another client used the key.`);
  }
  // Below the tolerance the difference is float noise of the summed costs.
  if (Math.abs(total) <= RESIDUAL_TOLERANCE_USD) total = 0;
  const shares = held.map((row) => ({
    attemptId: row.attemptId,
    cost: reserved > 0 ? (total * Number(row.usd || 0)) / reserved : 0,
  }));
  return { total, reserved, shares };
}

// The first usage audit of a budget journal and whether it came before the
// journal's first POST.
function firstUsageAudit(file) {
  const events = readJsonl(file);
  const auditAt = events.findIndex((event) => event.kind === 'audit' && event.usage != null);
  const reserveAt = events.findIndex((event) => event.kind === 'reserve');
  if (auditAt < 0) return null;
  return { ...events[auditAt], beforeFirstPost: reserveAt < 0 || auditAt < reserveAt };
}

// Called under the run's own lock, so no runner of this run is streaming.
export async function reconcileByKeyResidual(campaignPaths, budget, nextRunId, { log = console.log, nextPaths = null } = {}) {
  const runId = path.basename(campaignPaths.dir);
  if (!nextRunId || nextRunId === runId) throw new Error('--key-residual-until needs the run that used the key next.');
  const next = nextPaths || pathsFor(nextRunId);
  const open = Object.entries(budget.state.reservations).filter(([, row]) => row && !row.settled);
  if (!open.length && !budget.unresolvedAttempts().length) {
    log('key residual: no held reserves');
    return { total: 0, reserved: 0, shares: [] };
  }
  const start = firstUsageAudit(campaignPaths.budget);
  const end = firstUsageAudit(next.budget);
  if (!start?.beforeFirstPost) throw new Error(`${runId} has no usage audit before its first POST.`);
  if (!end?.beforeFirstPost) throw new Error(`${nextRunId} has no usage audit before its first POST.`);
  // Audits of the phases that post; a reconcile only reads.
  const posting = readJsonl(campaignPaths.budget)
    .filter((event) => event.kind === 'audit' && event.usage != null && event.phase !== 'reconcile');
  const last = posting[posting.length - 1];
  if (last && (last.at > end.at || Number(last.usage) > Number(end.usage) + RESIDUAL_TOLERANCE_USD)) {
    throw new Error(`${runId} has an audit after ${nextRunId} started, so the two runs overlap on the key.`);
  }
  // A stream cut when the runner stopped never settled; it is settled here as
  // an attempt without usage, and then priced with the others.
  for (const [attemptId] of open) budget.settle({ attemptId, incomplete: true });
  const held = budget.unresolvedAttempts();
  const own = ledgerOf(campaignPaths.budget, readJson(campaignPaths.campaign, {}));
  const result = keyResidual({
    before: Number(start.usage),
    after: Number(end.usage),
    settledUsd: own.state.settledUsd,
    held,
  });
  const source = `key-residual:${start.at}..${end.at}`;
  for (const share of result.shares) budget.resettle({ attemptId: share.attemptId, cost: share.cost, source });
  log(
    `key residual: key usage $${Number(start.usage).toFixed(9)} -> $${Number(end.usage).toFixed(9)}, `
    + `${runId} settled $${own.state.settledUsd.toFixed(9)}; ${held.length} held reserves ($${result.reserved.toFixed(4)}) `
    + `cost $${result.total.toFixed(9)} together, split by reserve; held now $${budget.state.unresolvedUsd.toFixed(4)}`,
  );
  return result;
}

const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const CURABLE_PAUSES = ['auth', 'key_budget', 'insufficient_funds'];

// Whether OpenRouter shows the cause of a durable pause gone: the key works
// again, the key has limit left, or the account has credit. An unknown payment
// refusal stays for a person to read.
export function durablePauseCure(reason, keyInfo, creditsInfo = null) {
  const key = keyInfo?.status === 200 ? keyInfo.body?.data : null;
  if (!CURABLE_PAUSES.includes(reason) || !key) return { cured: false };
  if (reason === 'auth') return { cured: true, evidence: 'GET /api/v1/key answered 200' };
  if (reason === 'key_budget') {
    const left = key.limit_remaining;
    return left == null || Number(left) > 0
      ? { cured: true, evidence: `key limit remaining ${left == null ? 'unlimited' : Number(left).toFixed(2)}` }
      : { cured: false };
  }
  const credits = creditsInfo?.status === 200 ? creditsInfo.body?.data : null;
  const balance = credits ? Number(credits.total_credits) - Number(credits.total_usage) : NaN;
  return Number.isFinite(balance) && balance > 0
    ? { cured: true, evidence: `account balance ${balance.toFixed(2)}` }
    : { cured: false };
}

// A durable pause waits for a person: a new key, a raised key limit, or more
// credit. At the start of a phase it lifts only when OpenRouter shows the cause
// gone, and the evidence is journaled; otherwise it stays.
async function liftDurablePause(budget) {
  if (!budget.state.paused || budget.state.fatal || !CURABLE_PAUSES.includes(budget.state.pauseReason)) return;
  const reason = budget.state.pauseReason;
  let keyInfo = null;
  let creditsInfo = null;
  try {
    const key = loadPaidKey();
    keyInfo = await fetchJson(OPENROUTER_KEY_URL, key);
    if (reason === 'insufficient_funds') creditsInfo = await fetchJson(CREDITS_URL, key);
  } catch (error) {
    console.log(`budget: the ${reason} pause stays; the check failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const cure = durablePauseCure(reason, keyInfo, creditsInfo);
  if (cure.cured && budget.resumeDurable({ reason, evidence: cure.evidence }).applied) {
    console.log(`budget: lifted the ${reason} pause (${cure.evidence})`);
  } else {
    console.log(`budget: the ${reason} pause stays; OpenRouter does not show its cause gone`);
  }
}

async function phaseStart(campaignPaths, budget, phase) {
  await liftDurablePause(budget);
  try {
    await reconcileBudget(campaignPaths, budget);
  } catch (error) {
    console.log(`reconcile skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
  await auditKey(budget, phase, 'start');
}

function installPaid(session, budget, routes) {
  const allow = new Set(routes.map((route) => route.id));
  return installTransport({
    allowModels: allow,
    allowPaid: true,
    rejectFree: true,
    budget,
    onHttp: session.onHttp,
    onCooldown: session.onCooldown,
  });
}

export function prepareFor(policy) {
  return (model, stage, options) => {
    const cap = policy.caps?.[stage];
    const route = policy.routes?.[model];
    if (cap == null) throw new EvalInvariantError(`No token cap for stage ${stage || 'missing'}`);
    if (!route) throw new EvalInvariantError(`Model ${model} is outside the paid allowlist`);
    const next = { ...options, maxTokens: cap, provider: route.provider };
    if (route.temperature != null) next.temperature = route.temperature;
    if (route.topP != null) next.topP = route.topP;
    if (route.reasoning) next.reasoning = route.reasoning;
    // The deadline is a client setting, not a request field, so it does not
    // enter the request hash and a replayed slot still matches.
    if (policy.timeout) next.timeout = policy.timeout;
    // Client-only too: the loop guard, provenance marks, and the context
    // check change what the engine does with a stream, not what it sends.
    if (policy.loopGuard) next.loopGuard = policy.loopGuard;
    if (policy.annotate) next.evalAnnotations = true;
    if (policy.contextCheck && route.context) next.contextTokens = route.context;
    return next;
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RESUME_FLOOR_MS = 5_000;
const IN_FLIGHT_WAIT_MS = 60_000;
const MAX_RESUME_WAIT_MS = 30 * 60_000;

// How long to wait before another pass can make progress, or null when only
// a person can fix the stop (credit, auth, spend cap, fatal).
function resumeWait(budget, session) {
  const now = Date.now();
  if (budget.state.fatal) return null;
  if (budget.state.paused) {
    if (!budget.isTransientPause()) return null;
    const until = budget.state.resumeAfter ?? (now + IN_FLIGHT_WAIT_MS);
    return Math.max(RESUME_FLOOR_MS, until - now);
  }
  const cooling = [...session.cooldowns.values()].filter((until) => until > now);
  if (!cooling.length) return RESUME_FLOOR_MS;
  return Math.max(RESUME_FLOOR_MS, Math.min(...cooling) - now + 1_000);
}

export function reuseStats(slots, questionId = null) {
  let reused = 0;
  let fresh = 0;
  for (const slot of slots) {
    if (questionId && slot.meta?.questionId !== questionId) continue;
    if (slot.reusedFrom) reused += 1;
    else fresh += slot.httpAttempts || 0;
  }
  return { reusedSlots: reused, freshPosts: fresh };
}

// Runs questions through a pool of workers. A question left pending by a
// cooldown does not stop the others. A budget pause stops new work; when the
// pause is one that waiting cures, the pool sleeps and takes another pass in
// the same process instead of exiting.
async function runPasses({ label, order, isDone, runOne, budget, session, run }) {
  let resumes = 0;
  for (;;) {
    const pending = order.filter((id) => !isDone(id));
    if (!pending.length) return 0;
    let finished = order.length - pending.length;
    let cursor = 0;
    let stopCode = 0;
    console.log(
      `${label} pass ${resumes + 1}: ${run.jobs} questions at once, ${finished} complete, ${pending.length} left, `
      + `http cap ${run.inFlight}, per model ${run.modelInFlight}`,
    );
    async function worker(index) {
      while (!stopCode) {
        if (budget.state.paused || budget.state.fatal) return;
        const at = cursor;
        cursor += 1;
        if (at >= pending.length) return;
        const id = pending[at];
        let result;
        try {
          result = await runOne(id, index);
        } catch (error) {
          if (isEvalInvariant(error)) {
            console.log(`w${index} ${label} fatal: ${error.message}`);
            stopCode = 1;
            return;
          }
          throw error;
        }
        if (result?.status === 'complete') {
          finished += 1;
          const reuse = reuseStats(session.slots());
          console.log(
            `w${index} ${label} ${finished}/${order.length} done ${id} `
            + `settled $${budget.state.settledUsd.toFixed(4)} reserved $${budget.state.unresolvedUsd.toFixed(4)} `
            + `reused ${reuse.reusedSlots} fresh posts ${reuse.freshPosts}`,
          );
          continue;
        }
        console.log(`w${index} ${label} pending ${id}: ${result?.reason || 'unknown'}`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(run.jobs, pending.length) }, (_, index) => worker(index)));
    if (stopCode) return stopCode;
    if (!order.some((id) => !isDone(id))) return 0;
    const wait = resumeWait(budget, session);
    if (wait == null) {
      console.log(`${label} paused: ${budget.state.pauseReason || 'stopped'}`);
      return 2;
    }
    if (resumes >= run.maxResumes || wait > MAX_RESUME_WAIT_MS) {
      console.log(`${label} paused after ${resumes} resumes; next wait ${Math.ceil(wait / 1000)}s`);
      return 2;
    }
    const why = budget.state.paused ? budget.state.pauseReason : 'cooldown';
    console.log(`${label} waiting ${Math.ceil(wait / 1000)}s (${why}) before pass ${resumes + 2}`);
    await sleep(wait);
    budget.resumeTransient();
    resumes += 1;
  }
}

// The cap is confirmed on a route once a request carrying it came back HTTP
// 200 as a finished stream with a usage block. HTTP 200 alone is not enough:
// a stream can carry an error.
export function confirmsCap(row) {
  return row?.http === 200 && row.usageKnown === true && (row.finishReason === 'stop' || row.finishReason === 'length');
}

// Which round the probe runs and on which routes. A probe that ended without
// confirming every route runs again as a new round on the routes still
// unconfirmed, as a new attempt of the same request: a finished slot never
// posts again, so the round goes into the slot key. Round 1 asks every route.
export function probePlan(saved, rows, preflightDoc) {
  const round = saved ? (saved.round || 1) + 1 : 1;
  const active = saved?.active ? [...saved.active] : [...(preflightDoc.candidates || [])];
  const reserves = (preflightDoc.reserves || []).filter((id) => !active.includes(id));
  const retry = round === 1
    ? null
    : active.filter((model) => !(rows || []).some((row) => row.model === model && confirmsCap(row)));
  return { round, attempt: round - 1, active, reserves, retry };
}

// A campaign that must confirm its cap is done only once every route has
// confirmed it; until then the probe can run again.
export function probeOutcome(rows, active, requireCapConfirmation) {
  const capConfirmed = {};
  const parsedAnswers = {};
  for (const model of active) {
    const own = (rows || []).filter((row) => row.model === model);
    capConfirmed[model] = own.some(confirmsCap);
    parsedAnswers[model] = own.filter((row) => row.status === 'graded').length;
  }
  const allConfirmed = Object.values(capConfirmed).every(Boolean);
  return { capConfirmed, parsedAnswers, allConfirmed, done: allConfirmed || !requireCapConfirmation };
}

async function runProbe(campaignPaths) {
  const { campaign, bank } = assertCompatible(campaignPaths, 'probe');
  const preflightDoc = readJson(campaignPaths.preflight);
  const saved = readJson(path.join(campaignPaths.probe, 'results.json'));
  if (saved?.done) {
    console.log('probe already complete');
    return 0;
  }
  const sourceFile = path.join(campaignPaths.probe, 'source.json');
  if (!assertSnapshot(sourceFile, 'Probe')) {
    writeJson(sourceFile, {
      sourceHash: sourceHash(),
      recordedAt: new Date().toISOString(),
    });
  }
  const key = loadPaidKey();
  settings.apiKey = key;
  const budget = openBudget(campaignPaths, priceMap(preflightDoc), campaign);
  await phaseStart(campaignPaths, budget, 'probe');
  const results = readJson(path.join(campaignPaths.probe, 'rows.json'), []);
  const plan = probePlan(saved, results, preflightDoc);
  const { round, attempt, active, reserves } = plan;
  const routes = preflightDoc.routes.filter((route) => active.includes(route.id) || reserves.includes(route.id));
  // The probe checks that each route answers today, so it never replays.
  const session = createSession({
    runDir: campaignPaths.probe,
    budget,
    prepareOptions: prepareFor(policyFrom({ routes }, campaign)),
    maxInFlight: active.length,
    ...sessionBudget(),
  });
  session.install();
  const restore = installPaid(session, budget, routes);
  const smoke = bank.items.filter((item) => item.split === 'smoke');
  const baseSnap = snapshotLocal();
  try {
    let replacements = saved?.replacements || 0;
    if (plan.retry) console.log(`probe round ${round}: retrying ${plan.retry.join(', ')}`);
    for (let index = 0; index < smoke.length; index += 1) {
      const task = smoke[index];
      const models = plan.retry ? active.filter((model) => plan.retry.includes(model)) : [...active];
      if (!models.length) break;
      console.log(`probe ${index + 1}/${smoke.length} ${task.block}: ${models.length} routes at once`);
      const answered = await runIsolated(baseSnap, 0, async () => {
        session.setContext({
          questionId: task.id,
          branch: 'probe',
          stage: 'stage1',
          sample: 1,
          ...(attempt > 0 ? { attempt } : {}),
        });
        const settled = await Promise.allSettled(models.map((model) => (
          queryModelResult(model, [{ role: 'user', content: answerPrompt(task) }])
        )));
        await session.drain();
        return settled;
      });
      const invariant = answered.find((item) => item.status === 'rejected' && isEvalInvariant(item.reason));
      if (invariant) throw invariant.reason;
      for (let at = 0; at < models.length; at += 1) {
        const model = models[at];
        const result = answered[at].status === 'fulfilled' ? answered[at].value : null;
        if (result?.skipped) {
          writeJson(path.join(campaignPaths.probe, 'rows.json'), results);
          console.log('probe paused: cooldown');
          return 2;
        }
        const slot = session.slots().find((item) => (
          item.meta?.questionId === task.id && item.meta?.model === model && (item.meta?.attempt || 0) === attempt
        ));
        const grade = result?.ok ? gradeResponse(task, result.content || '') : gradeResponse(task, '', failureKind(result));
        // A resumed round answers again from its journal; keep one row per
        // question, route, and round.
        const stale = results.findIndex((row) => row.id === task.id && row.model === model && (row.round || 1) === round);
        if (stale >= 0) results.splice(stale, 1);
        results.push({
          id: task.id,
          round,
          model,
          http: slot?.httpStatus ?? null,
          correct: grade.correct,
          status: grade.status,
          finishReason: slot?.finishReason ?? null,
          usageKnown: slot?.usageKnown === true,
          maxTokens: slot?.request?.max_tokens ?? null,
        });
        console.log(`probe ${model} http ${slot?.httpStatus ?? 'n/a'} ${grade.status}`);
        if (slot?.httpStatus === 401) {
          writeJson(path.join(campaignPaths.probe, 'rows.json'), results);
          console.log('probe paused: auth');
          return 2;
        }
        const bad = slot?.httpStatus === 400 || slot?.httpStatus === 404;
        // A campaign that confirms its cap never swaps a route silently: a
        // refused request may mean the route cannot take the cap.
        if (bad && campaign.requireCapConfirmation) {
          writeJson(path.join(campaignPaths.probe, 'rows.json'), results);
          console.log(`probe stopped: ${model} answered HTTP ${slot.httpStatus}: ${result?.error?.detail || result?.error?.message || ''}`);
          console.log(
            'Caps are fixed at this campaign\'s preflight. Check the route limit, then start a new campaign id '
            + 'with explicit cap flags (--stage1-cap, --stage2-cap, --final-cap) before any dev.',
          );
          return 2;
        }
        if (bad && replacements < RESERVE_LIMIT && reserves.length) {
          const replacement = reserves.shift();
          const place = active.indexOf(model);
          if (place >= 0) active.splice(place, 1, replacement);
          replacements += 1;
          console.log(`probe replaced ${model} with ${replacement}`);
        }
      }
      if (budget.state.paused) {
        writeJson(path.join(campaignPaths.probe, 'rows.json'), results);
        console.log(`probe paused: ${budget.state.pauseReason}`);
        return 2;
      }
    }
    writeJson(path.join(campaignPaths.probe, 'rows.json'), results);
    const { capConfirmed, parsedAnswers: parsed, allConfirmed, done } = probeOutcome(
      results,
      active,
      campaign.requireCapConfirmation === true,
    );
    writeJson(path.join(campaignPaths.probe, 'results.json'), {
      done,
      round,
      active,
      replacements,
      capConfirmed,
      parsedAnswers: parsed,
      allConfirmed,
      settledUsd: budget.state.settledUsd,
      unresolvedUsd: budget.state.unresolvedUsd,
      posts: budget.state.posts,
    });
    for (const model of active) {
      console.log(`probe cap ${capConfirmed[model] ? 'confirmed' : 'NOT confirmed'} on ${model}; parsed answers ${parsed[model]}`);
    }
    console.log(`probe done. Active: ${active.join(', ')}`);
    if (!done) {
      console.log('probe: the cap is not confirmed on every route; dev will not start. Run the probe again to retry the unconfirmed routes.');
      return 2;
    }
    return 0;
  } finally {
    session.uninstall();
    restore();
    await auditKey(budget, 'probe', 'end');
  }
}

function pendingFrom(settled, budget) {
  const invariant = settled.find((item) => item.status === 'rejected' && isEvalInvariant(item.reason));
  if (invariant) throw invariant.reason;
  const rejected = settled.find((item) => item.status === 'rejected');
  if (rejected && !(rejected.reason instanceof BudgetPaused) && !budget.state.paused) throw rejected.reason;
  const values = settled.map((item) => (item.status === 'fulfilled' ? item.value : null));
  if (rejected) return { reason: budget.state.pauseReason || rejected.reason?.reason || 'paused', values };
  if (values.some((value) => value?.skipped)) return { reason: 'cooldown', values };
  if (budget.state.paused && values.some((value) => !value?.ok)) return { reason: budget.state.pauseReason, values };
  return { reason: null, values };
}

async function runDev(campaignPaths, run) {
  const { campaign, bank, preflight: preflightDoc } = assertCompatible(campaignPaths, 'dev');
  const probe = readJson(path.join(campaignPaths.probe, 'results.json'));
  if (!probe?.done) throw new Error('Finish the probe before dev.');
  if (campaign.requireCapConfirmation && !probe.allConfirmed) {
    throw new Error('The probe did not confirm the cap on every route.');
  }
  const models = probe.active;
  const routes = preflightDoc.routes.filter((route) => models.includes(route.id));
  const key = loadPaidKey();
  settings.apiKey = key;
  const budget = openBudget(campaignPaths, priceMap(preflightDoc), campaign);
  await phaseStart(campaignPaths, budget, 'dev');
  const devDir = campaignPaths.dev;
  mkdirSync(devDir, { recursive: true });
  const devSource = path.join(devDir, 'source.json');
  if (!assertSnapshot(devSource, 'Dev')) {
    writeJson(devSource, { sourceHash: sourceHash(), recordedAt: new Date().toISOString() });
  }
  const replay = replaySources(campaign);
  const session = createSession({
    runDir: devDir,
    budget,
    prepareOptions: prepareFor(policyFrom({ routes }, campaign)),
    maxInFlight: run.inFlight,
    maxInFlightPerModel: run.modelInFlight,
    ...sessionBudget(replay),
  });
  session.install();
  const restore = installPaid(session, budget, routes);
  const devItems = bank.items.filter((item) => item.split === 'dev');
  const byId = new Map(devItems.map((item) => [item.id, item]));
  const baseSnap = snapshotLocal();
  try {
    const code = await runPasses({
      label: 'dev',
      order: devItems.map((item) => item.id),
      isDone: (id) => readJson(questionFile(devDir, id))?.status === 'complete',
      budget,
      session,
      run,
      runOne: async (id, index) => {
        const task = byId.get(id);
        const file = questionFile(devDir, id);
        const settled = await runIsolated(baseSnap, index, async () => {
          session.setContext({ questionId: task.id, branch: 'dev', stage: 'stage1', sample: 1 });
          const all = await Promise.allSettled(models.map((model) => (
            queryModelResult(model, [{ role: 'user', content: answerPrompt(task) }])
          )));
          await session.drain();
          return all;
        });
        const { reason, values } = pendingFrom(settled, budget);
        if (reason) {
          const row = { id: task.id, status: 'pending', reason };
          writeJson(file, row);
          return row;
        }
        const answers = models.map((model, at) => {
          const result = values[at];
          const grade = result?.ok ? gradeResponse(task, result.content || '') : gradeResponse(task, '', failureKind(result));
          const slot = session.slots().find((item) => (
            item.meta?.questionId === task.id && item.meta?.model === model && item.meta?.branch === 'dev'
          ));
          return {
            id: model,
            correct: grade.correct,
            status: grade.status,
            success: result?.ok === true,
            cost: slot?.usage?.cost ?? null,
            latencyMs: slot?.occupiedMs ?? null,
            reused: Boolean(slot?.reusedFrom),
          };
        });
        const row = { id: task.id, block: task.block, status: 'complete', answers };
        writeJson(file, row);
        return row;
      },
    });
    if (code) return code;
    const tally = new Map(models.map((id) => [id, {
      id,
      configId: id,
      vendor: id.split('/')[0],
      expected: devItems.length,
      attempts: 0,
      correct: 0,
      successes: 0,
      latencyMs: null,
      latencyCount: 0,
      costUsd: 0,
    }]));
    for (const task of devItems) {
      const saved = readJson(questionFile(devDir, task.id));
      if (saved?.status !== 'complete') {
        console.log('dev paused before selection: not every dev question finished');
        return 2;
      }
      for (const answer of saved.answers || []) {
        const row = tally.get(answer.id);
        row.attempts += 1;
        row.correct += answer.correct === 1 ? 1 : 0;
        row.successes += answer.success ? 1 : 0;
        if (answer.latencyMs != null) {
          row.latencyCount += 1;
          row.latencyMs = (row.latencyMs || 0) + answer.latencyMs;
        }
        if (answer.cost != null) row.costUsd += Number(answer.cost);
      }
    }
    for (const row of tally.values()) {
      row.latencyMs = row.latencyCount ? row.latencyMs / row.latencyCount : null;
    }
    const choice = selectFromDev([...tally.values()]);
    if (!choice) throw new Error('Dev did not yield three vendors.');
    const previous = readJson(campaignPaths.selection);
    if (previous?.sourceHash) sameSource(previous.sourceHash, 'Selection');
    const comparisonStarted = existsSync(campaignPaths.comparison);
    if (previous && comparisonStarted) {
      console.log('dev selection already frozen');
      return 0;
    }
    const selectedRoutes = choice.council.map((row) => routes.find((route) => route.id === row.id));
    writeJson(campaignPaths.selection, {
      basis: choice.basis,
      sourceHash: sourceHash(),
      b: choice.b.id,
      h: choice.h.id,
      council: choice.council.map((row) => row.id),
      routes: selectedRoutes,
      table: choice.ranked,
      selectedAt: new Date().toISOString(),
      runner: runnerNote(run),
    });
    console.log('dev table');
    for (const row of choice.ranked) {
      console.log(
        `${row.id} ${row.correct}/${row.expected} completion ${row.successes}/${row.expected} `
        + `usd ${Number(row.costUsd || 0).toFixed(4)}`,
      );
    }
    console.log(`dev selected B=H ${choice.b.id}; council ${choice.council.map((row) => row.id).join(', ')}`);
    return 0;
  } finally {
    session.uninstall();
    restore();
    await auditKey(budget, 'dev', 'end');
  }
}

// Pilot questions: the first `perBlock` dev questions of every block in
// seeded order, chosen before any answer is seen.
export function pilotItems(items, perBlock, seed = SCHEDULE_SEED) {
  const dev = items.filter((item) => item.split === 'dev');
  return orderBlocks(dev.map((item) => item.block)).flatMap((block) => (
    dev.filter((item) => item.block === block)
      .sort((left, right) => compareHash(seed, left.id, right.id))
      .slice(0, perBlock)
  ));
}

const FORECAST_FORMULA = 'Per block: base = mean cost of a pilot question; stress = max(factor x mean, dearest pilot question). '
  + 'Same for POSTs. A pilot question counts all its comparison calls and retries, a settled call at its cost and an unresolved one at its whole reserve; '
  + 'dev calls on the same question are left out. A block without pilot questions takes, for each value, the largest among the blocks with pilot data. '
  + 'The gate is the stress forecast of the primary set against what is left; the factor is an assumption, not a quantile or a guarantee.';

// Spend and posts of each pilot question from the campaign ledger: a settled
// attempt counts at its cost, an unresolved one at its whole reserve. Only
// comparison calls count: pilot questions are dev questions, and the dev
// phase posted its own calls on the same question ids. Two forecasts: the
// primary set alone, which gates the test, and the whole test.
export function pilotForecast({ campaign, budget, items, order }) {
  const perQuestion = new Map(order.map((id) => [id, { usd: 0, posts: 0 }]));
  for (const [attemptId, row] of Object.entries(budget.state.reservations || {})) {
    const [questionId, branch] = attemptId.split('|');
    if (!COMPARISON_BRANCHES.includes(branch)) continue;
    const entry = perQuestion.get(questionId);
    if (!entry) continue;
    entry.posts += 1;
    entry.usd += row.unresolved || row.cost == null ? Number(row.usd || 0) : Number(row.cost || 0);
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const blocks = {};
  for (const [id, entry] of perQuestion) {
    const block = byId.get(id)?.block;
    if (!block) continue;
    blocks[block] ||= { usd: [], posts: [] };
    blocks[block].usd.push(entry.usd);
    blocks[block].posts.push(entry.posts);
  }
  const factor = campaign.forecastStressFactor ?? FORECAST_STRESS_FACTOR;
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const stats = {};
  for (const [block, row] of Object.entries(blocks)) {
    stats[block] = {
      pilotQuestions: row.usd.length,
      observedUsd: row.usd,
      observedPosts: row.posts,
      meanUsd: mean(row.usd),
      stressUsd: Math.max(factor * mean(row.usd), Math.max(...row.usd)),
      meanPosts: mean(row.posts),
      stressPosts: Math.max(factor * mean(row.posts), Math.max(...row.posts)),
    };
  }
  // A block without pilot questions takes, value by value, the largest among
  // all blocks with pilot data, not only the choice blocks.
  const known = Object.values(stats);
  const largest = (field) => (known.length ? Math.max(...known.map((row) => row[field])) : null);
  const proxy = known.length ? {
    pilotQuestions: 0,
    meanUsd: largest('meanUsd'),
    stressUsd: largest('stressUsd'),
    meanPosts: largest('meanPosts'),
    stressPosts: largest('stressPosts'),
  } : null;
  const primaryBlocks = campaign.primaryBlocks || [];
  const sums = () => ({ baseUsd: 0, stressUsd: 0, basePosts: 0, stressPosts: 0 });
  const primary = sums();
  const full = sums();
  const lines = [];
  for (const [block, counts] of Object.entries(campaign.counts?.blocks || {})) {
    const testCount = counts.test || 0;
    if (!testCount) continue;
    const row = stats[block] || proxy;
    if (!row) throw new Error(`No pilot cost for block ${block}`);
    const targets = primaryBlocks.length && !primaryBlocks.includes(block) ? [full] : [primary, full];
    for (const target of targets) {
      target.baseUsd += row.meanUsd * testCount;
      target.stressUsd += row.stressUsd * testCount;
      target.basePosts += row.meanPosts * testCount;
      target.stressPosts += row.stressPosts * testCount;
    }
    lines.push({ block, testCount, primary: !primaryBlocks.length || primaryBlocks.includes(block), proxy: stats[block] ? null : 'largest over the pilot blocks', ...row });
  }
  const remainingUsd = campaign.maxUsd - (budget.state.settledUsd + budget.state.unresolvedUsd);
  const remainingPosts = campaign.maxPosts - budget.state.posts;
  const fits = (sum) => sum.stressUsd <= remainingUsd && sum.stressPosts <= remainingPosts;
  primary.fits = fits(primary);
  full.fits = fits(full);
  const all = [...perQuestion.values()];
  return {
    formula: FORECAST_FORMULA,
    stressFactor: factor,
    blocks: lines,
    primary,
    full,
    pilotMeanUsd: all.length ? mean(all.map((entry) => entry.usd)) : 0,
    pilotMeanPosts: all.length ? mean(all.map((entry) => entry.posts)) : 0,
    remainingUsd,
    remainingPosts,
    gate: primary.fits ? 'pass' : 'fail',
  };
}

function runnerNote(run) {
  return {
    jobs: run.jobs,
    httpInFlight: run.inFlight,
    perModelInFlight: run.modelInFlight,
    acceptForecast: run.acceptForecast === true,
    note: 'Pacing only. Requests, caps, and retry limits are unchanged.',
  };
}

async function runPipeline(campaignPaths, phase, run) {
  const { campaign, bank, preflight: preflightDoc } = assertCompatible(campaignPaths, phase);
  if (phase === 'test' && campaign.pilotGate) {
    const forecast = readJson(path.join(campaignPaths.comparison, 'pilot', 'forecast.json'));
    if (forecast?.gate !== 'pass' && !run.acceptForecast) {
      console.log(
        forecast?.primary
          ? `test not started: the stress forecast of the primary set, $${forecast.primary.stressUsd.toFixed(2)} / ${Math.ceil(forecast.primary.stressPosts)} POSTs, `
            + `exceeds what is left ($${forecast.remainingUsd.toFixed(2)} / ${forecast.remainingPosts}). `
            + 'Pass --accept-forecast to start anyway.'
          : 'test not started: run the pilot first.',
      );
      return 2;
    }
    if (forecast?.full && !forecast.full.fits) {
      console.log('test: the legacy blocks may not all fit what is left; they run only after the primary set, within the remaining budget');
    }
  }
  const selection = readJson(campaignPaths.selection);
  if (!selection?.council || selection.council.length !== COUNCIL_SIZE) throw new Error('Selection is not frozen.');
  if (selection.sourceHash !== sourceHash()) {
    throw new Error('Source hash changed after selection. Refusing to mix methods in this run.');
  }
  if (selection.h !== selection.b) throw new Error('H and B must be the same model.');
  const frozen = {
    councilModels: selection.council,
    chairmanModel: selection.h,
    bModel: selection.b,
  };
  const routes = selection.routes || preflightDoc.routes.filter((route) => selection.council.includes(route.id) || route.id === selection.b);
  const shared = routes.find((route) => route.id === selection.h);
  if (!shared) throw new Error('Selection is missing the shared H/B route.');
  let items;
  const pilotFirst = campaign.pilotPerBlock ?? PILOT_PER_BLOCK;
  const pilotMax = campaign.pilotPerBlockMax ?? pilotFirst;
  if (phase === 'smoke') items = bank.items.filter((item) => item.split === 'smoke');
  else if (phase === 'pilot') items = pilotItems(bank.items, pilotMax);
  else items = testOrder(bank.items.filter((item) => item.split === 'test'), campaign.primaryBlocks);
  const dir = path.join(campaignPaths.comparison, phase);
  mkdirSync(dir, { recursive: true });
  const orderFile = path.join(dir, 'order.json');
  const initial = phase === 'pilot' ? pilotItems(bank.items, pilotFirst).map((item) => item.id) : items.map((item) => item.id);
  const order = readJson(orderFile) || initial;
  if (!existsSync(orderFile)) writeJson(orderFile, order);
  writeJson(path.join(dir, 'runner.json'), { ...runnerNote(run), startedAt: new Date().toISOString() });
  const byId = new Map(items.map((item) => [item.id, item]));
  const key = loadPaidKey();
  settings.apiKey = key;
  const baseSnap = snapshotLocal();
  const budget = openBudget(campaignPaths, priceMap({ routes }), campaign);
  await phaseStart(campaignPaths, budget, phase);
  const replay = replaySources(campaign);
  const session = createSession({
    runDir: dir,
    budget,
    prepareOptions: prepareFor(policyFrom({ routes }, campaign)),
    maxInFlight: run.inFlight,
    maxInFlightPerModel: run.modelInFlight,
    ...sessionBudget(replay),
  });
  session.install();
  const restore = installPaid(session, budget, routes);
  const passes = (ids = order, label = phase) => runPasses({
    label,
    order: ids,
    isDone: (id) => readJson(questionFile(dir, id))?.status === 'complete',
    budget,
    session,
    run,
    runOne: async (id, index) => {
      const task = byId.get(id);
      try {
        const result = await runIsolated(baseSnap, index, () => (
          runComparison(task, session, frozen, { scheduleSeed: SCHEDULE_SEED, tailRule: campaign.tailRule || null })
        ));
        const fresh = session.slots().filter((item) => item.meta?.questionId === id);
        if (fresh.some((item) => String(item.meta?.model || '').endsWith(':free'))) {
          throw new EvalInvariantError('A free model id reached the journal.');
        }
        result.reuse = reuseStats(fresh);
        writeJson(questionFile(dir, id), result);
        return result;
      } catch (error) {
        if (isEvalInvariant(error)) writeJson(questionFile(dir, id), { id, status: 'fatal', reason: error.message });
        throw error;
      }
    },
  });
  try {
    const stages = phase === 'test' ? testStages(order, items, campaign.primaryBlocks) : [order];
    let code = await runStages(stages, (ids, index) => {
      if (stages.length > 1) {
        console.log(index === 0
          ? `test: ${ids.length} primary questions first; the legacy blocks wait until every one is complete`
          : `test: every primary question is complete; starting ${ids.length} legacy questions`);
      }
      return passes(ids, stages.length > 1 ? `${phase}:${index === 0 ? 'primary' : 'legacy'}` : phase);
    });
    if (code) return code;
    if (phase === 'pilot' && campaign.pilotGate) {
      // Prices first: a held reserve that the generation record can settle
      // should not inflate the forecast.
      const settle = async () => {
        try {
          await reconcileBudget(campaignPaths, budget);
        } catch (error) {
          console.log(`reconcile skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      await settle();
      let forecast = pilotForecast({ campaign, budget, items, order });
      let extensionNote = null;
      if (forecast.gate !== 'pass' && order.length < items.length) {
        // Extend once, and only when it could change the decision: the base
        // forecast of the primary set must fit what the extension leaves.
        const added = items.length - order.length;
        const extensionUsd = forecast.pilotMeanUsd * added;
        const extensionPosts = forecast.pilotMeanPosts * added;
        const room = forecast.primary.baseUsd + extensionUsd <= forecast.remainingUsd
          && forecast.primary.basePosts + extensionPosts <= forecast.remainingPosts;
        if (room) {
          console.log(
            `pilot: the stress forecast of the primary set, $${forecast.primary.stressUsd.toFixed(2)}, does not fit the $${forecast.remainingUsd.toFixed(2)} left; `
            + `extending the pilot by ${added} questions to at most ${pilotMax} per block, as set before the run`,
          );
          for (const item of items) if (!order.includes(item.id)) order.push(item.id);
          writeJson(orderFile, order);
          code = await passes();
          if (code) return code;
          await settle();
          forecast = pilotForecast({ campaign, budget, items, order });
        } else {
          extensionNote = `not extended: even the base forecast of the primary set plus the expected $${extensionUsd.toFixed(2)} of the extension exceeds what is left`;
          console.log(`pilot: ${extensionNote}`);
        }
      }
      writeJson(path.join(dir, 'forecast.json'), {
        ...forecast,
        pilotQuestions: order.length,
        extended: order.length > initial.length,
        extensionNote,
        computedAt: new Date().toISOString(),
      });
      for (const row of forecast.blocks) {
        console.log(
          `pilot ${row.block}${row.primary ? '' : ' (legacy)'}: ${row.testCount} test questions at $${row.meanUsd.toFixed(4)} base, `
          + `$${row.stressUsd.toFixed(4)} stress${row.proxy ? ` (${row.proxy})` : ''}`,
        );
      }
      const show = (sum) => `$${sum.baseUsd.toFixed(2)} base, $${sum.stressUsd.toFixed(2)} stress, ${Math.ceil(sum.stressPosts)} POSTs stress`;
      console.log(
        `pilot forecast: primary set ${show(forecast.primary)}; whole test ${show(forecast.full)}; `
        + `left $${forecast.remainingUsd.toFixed(2)} / ${forecast.remainingPosts} POSTs; gate ${forecast.gate}`
        + `${forecast.full.fits ? '' : '; the legacy blocks may not all fit and run last'}`,
      );
    } else if (phase === 'pilot') {
      const rows = order.map((id) => readJson(questionFile(dir, id))).filter(Boolean);
      const fresh = rows.reduce((sum, row) => sum + (row.reuse?.freshPosts || 0), 0);
      const spent = budget.state.settledUsd - Number(campaign.carriedSpend?.settledUsd || 0);
      const per = order.length ? spent / order.length : null;
      writeJson(path.join(dir, 'forecast.json'), {
        settledUsd: spent,
        unresolvedUsd: budget.state.unresolvedUsd,
        perQuestion: per,
        forecastTestUsd: per == null ? null : per * TEST_QUESTIONS,
        pilotFreshPosts: fresh,
        note: 'Forecast divides this run\'s own settled spend so far (probe, dev, smoke, pilot; not the carried spend of replay sources) by pilot questions. Replayed calls cost nothing, so it depends on how much each phase could reuse.',
      });
      console.log(`pilot forecast for ${TEST_QUESTIONS} questions at the current average: $${per == null ? 'n/a' : (per * TEST_QUESTIONS).toFixed(2)}`);
    }
    console.log(`${phase} complete`);
    return 0;
  } finally {
    session.uninstall();
    restore();
    await auditKey(budget, phase, 'end');
  }
}

// One deliberately cut stream on a route the campaign uses, then a lookup of
// its generation: shows whether reconcile can price an aborted attempt.
async function reconcileSelfTest(campaignPaths, campaign, preflightDoc, budget, modelFlag) {
  const selection = readJson(campaignPaths.selection);
  const model = modelFlag || selection?.b;
  if (!model) throw new Error('--self-test needs --model until dev has chosen B.');
  const route = preflightDoc.routes.find((item) => item.id === model);
  if (!route) throw new Error(`${model} is not a route of this campaign.`);
  const policy = prepareFor(policyFrom({ routes: [route] }, campaign));
  // Any repeated character trips this guard, so the stream is cut within its
  // first tokens, through the same path a real loop stop takes.
  const tripwire = { tailChars: 1, historyChars: 1, shingleChars: 1, stride: 1, checkEvery: 1, consecutive: 1, threshold: 0.01 };
  const session = createSession({
    runDir: campaignPaths.reconcile,
    budget,
    prepareOptions: (id, stage, options) => ({ ...policy(id, stage, options), maxTokens: 256, loopGuard: tripwire }),
    maxInFlight: 1,
    ...sessionBudget(),
    retryLimit: 1,
  });
  session.install();
  const restore = installPaid(session, budget, [route]);
  let result;
  try {
    session.setContext({ questionId: `selftest-${Date.now()}`, branch: 'reconcile', stage: 'stage1', sample: 1 });
    result = await queryModelResult(model, [{ role: 'user', content: 'Write the numbers from 1 to 200, one per line.' }]);
    await session.drain();
  } finally {
    session.uninstall();
    restore();
  }
  const attempt = budget.unresolvedAttempts().find((row) => row.attemptId.startsWith('selftest-'));
  console.log(`self-test: ${model} stream ${result?.loopCut ? 'cut by the tripwire' : 'not cut'}; unresolved reserve ${attempt ? 'held' : 'absent'}`);
  let summary = null;
  for (let wait = 0; wait < 3 && attempt; wait += 1) {
    await sleep(10_000);
    summary = await reconcileBudget(campaignPaths, budget);
    if (!budget.unresolvedAttempts().some((row) => row.attemptId === attempt.attemptId)) break;
  }
  const priced = attempt ? !budget.unresolvedAttempts().some((row) => row.attemptId === attempt.attemptId) : false;
  const record = { model, at: new Date().toISOString(), cut: result?.loopCut === true, attemptId: attempt?.attemptId || null, priced, summary };
  writeJson(path.join(campaignPaths.reconcile, 'selftest.json'), record);
  console.log(`self-test: an aborted attempt ${priced ? 'was priced by its generation record' : 'stayed unresolved'}`);
  return record;
}

async function runReconcile(campaignPaths, argv) {
  const campaign = readJson(campaignPaths.campaign);
  if (!campaign) throw new Error('Run preflight before this phase.');
  const preflightDoc = readJson(campaignPaths.preflight);
  settings.apiKey = loadPaidKey();
  const budget = openBudget(campaignPaths, priceMap(preflightDoc), campaign);
  if (argv.includes('--self-test')) {
    sameSource(campaign.sourceHash, 'Campaign');
    await reconcileSelfTest(campaignPaths, campaign, preflightDoc, budget, flagValue(argv, '--model'));
  }
  await reconcileBudget(campaignPaths, budget);
  const until = flagValue(argv, '--key-residual-until');
  if (until) await reconcileByKeyResidual(campaignPaths, budget, until);
  await auditKey(budget, 'reconcile', 'end');
  console.log(
    `budget: settled $${budget.state.settledUsd.toFixed(4)}, held $${budget.state.unresolvedUsd.toFixed(4)}, `
    + `${budget.state.posts} POSTs of ${campaign.maxPosts}; key usage ${budget.state.lastAudit?.usage ?? 'n/a'}`,
  );
  return 0;
}

function historicalNote() {
  const dir = path.join(RUNS_ROOT, 'main', 'questions');
  if (!existsSync(dir)) return null;
  let correct = 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const row = readJson(path.join(dir, name));
    if (row?.split !== 'test' || row?.status !== 'complete' || !row.arms?.A7) continue;
    n += 1;
    correct += row.arms.A7.correct === 1 ? 1 : 0;
  }
  if (!n) return null;
  return {
    label: 'main as-run, strict gradeResponse, separate from this campaign',
    pooled: correct / n,
    n,
  };
}

function stageName(meta) {
  if (meta.stage === 'stage3') return `${meta.branch} synthesis`;
  if (meta.stage === 'stage2') return 'judges';
  if (meta.stage === 'sample') return 'B samples';
  return 'Stage 1';
}

// Per-stage counts from one phase journal: calls, cap hits, loop stops (every
// aborted attempt), answers kept after a second loop, context refusals, and
// failed slots. A replaying campaign passes its sources' journals too: a
// reused slot's loop stops and credit retries happened there.
export function stageCounters(file, sourceFiles = []) {
  const counters = {};
  const slots = readSlotJournal(file);
  for (const slot of slots.values()) {
    if (!slot.meta) continue;
    const row = counters[stageName(slot.meta)] ||= {
      calls: 0, cap: 0, belowCap: 0, loopStops: 0, loopCut: 0, context: 0, failed: 0, creditRetries: 0,
    };
    row.calls += 1;
    const reason = slot.result?.finishReason ?? slot.finishReason;
    if (reason === 'length') row.cap += 1;
    // A length stop with fewer completion tokens than were asked for. In v4
    // every length stop sat exactly on the cap, so this is a sign to check for
    // a provider clamp, not proof of one. Without usage it stays unknown.
    const asked = Number(slot.request?.max_tokens);
    const used = slot.usage?.completion_tokens;
    if (reason === 'length' && used != null && Number.isFinite(asked) && Number(used) < asked) row.belowCap += 1;
    if (slot.result?.loopCut) row.loopCut += 1;
    if (slot.result?.error?.kind === 'context') row.context += 1;
    if (slot.state === 'failed') row.failed += 1;
  }
  for (const journal of [...sourceFiles, file]) {
    if (!existsSync(journal)) continue;
    for (const line of readFileSync(journal, 'utf8').split('\n')) {
      const loop = line.includes('"cancelReason":"loop"');
      const credit = line.includes('"credit":"in_flight_budget"');
      if (!loop && !credit) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const slot = slots.get(event.key);
      if (!slot?.meta) continue;
      const row = counters[stageName(slot.meta)];
      if (loop && event.cancelReason === 'loop') row.loopStops += 1;
      if (credit && event.credit === 'in_flight_budget') row.creditRetries += 1;
    }
  }
  return counters;
}

// Cost of the test questions from the ledger: once as paid, and per method
// as if each ran alone, with B's first answer counted in both. A held
// (unresolved) attempt counts at its whole reserve and is shown apart.
export function armCosts(reservations, bModel) {
  const out = { test: 0, A8: 0, S8: 0, heldA8: 0, heldS8: 0 };
  for (const [attemptId, row] of Object.entries(reservations || {})) {
    const [questionId, branch, stage, , model] = attemptId.split('#')[0].split('|');
    if (!String(questionId).startsWith('test:')) continue;
    const held = row.unresolved === true || row.cost == null;
    const usd = held ? Number(row.usd || 0) : Number(row.cost || 0);
    out.test += usd;
    const add = (arm) => {
      out[arm] += usd;
      if (held) out[`held${arm}`] += usd;
    };
    if (branch === 'council' && stage === 'stage1') {
      add('A8');
      if (model === bModel) add('S8');
    } else if ((branch === 'council' && stage === 'stage2') || branch === 'A8') {
      add('A8');
    } else if (branch === 'replicates' || branch === 'S8') {
      add('S8');
    }
  }
  return out;
}

// One ledger over several budget journals. A replaying campaign's attempts
// carry on the numbering of its source's attempts, so their ids never clash
// and the union is every POST paid for these questions.
function ledgerOf(files, campaign) {
  const ledger = createCampaignBudget({ maxUsd: campaign.maxUsd || MAX_USD, maxPosts: campaign.maxPosts || MAX_POSTS, prices: {} });
  for (const file of [].concat(files)) ledger.applyJournal(readJsonl(file));
  return ledger;
}

// Reserves priced from the key's usage across a run rather than by their own
// generation record.
function residualLine(files) {
  let count = 0;
  let total = 0;
  for (const file of files) {
    for (const event of readJsonl(file)) {
      if (event.kind !== 'resettle' || !String(event.source || '').startsWith('key-residual')) continue;
      count += 1;
      total += Number(event.cost || 0);
    }
  }
  return count ? { count, total } : null;
}

// What a replaying campaign took from its sources and what it posted itself.
function replayLine(campaign, slots, ownBudgetFile) {
  if (!campaign.replayFrom?.length) return null;
  const reused = slots.filter((slot) => slot.reusedFrom).length;
  const fresh = readJsonl(ownBudgetFile).filter((event) => event.kind === 'reserve').length;
  return { from: campaign.replayFrom, reused, fresh };
}

function goldOverridesFrom(argv, byId) {
  const file = flagValue(argv, '--gold-overrides');
  if (!file) return null;
  const raw = readJson(path.resolve(file));
  if (!raw || typeof raw !== 'object') throw new Error(`Cannot read gold overrides from ${file}`);
  const canonical = {};
  for (const [id, entry] of Object.entries(raw)) {
    const task = byId.get(id);
    if (!task) throw new Error(`Gold override for unknown question ${id}`);
    const gold = canonAnswer(String(entry?.gold ?? entry), task);
    if (gold == null) throw new Error(`Gold override for ${id} does not read as a ${task.kind} answer`);
    canonical[id] = gold;
  }
  return { file, sha: sha256(readFileSync(path.resolve(file), 'utf8')), canonical, raw };
}

async function reportV5(campaignPaths, campaign, argv) {
  const dir = path.join(campaignPaths.comparison, 'test');
  let rows = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || name === 'order.json' || name === 'runner.json') continue;
      const row = readJson(path.join(dir, name));
      if (row?.id) rows.push(row);
    }
  }
  const { items } = loadBank(campaign);
  const byId = new Map(items.map((item) => [item.id, item]));
  const selection = readJson(campaignPaths.selection) || {};
  const listings = Object.fromEntries((selection.council || []).map((id) => [id, campaign.modelListings?.dates?.[id] ?? null]));
  const overrides = goldOverridesFrom(argv, byId);
  if (overrides) rows = applyGoldOverrides(rows, overrides.canonical).rows;
  const primaryBlocks = campaign.primaryBlocks || [];
  rows = rows.map((row) => ({
    ...row,
    set: primaryBlocks.includes(row.block) ? 'primary' : 'legacy',
    group: chronologyGroup(byId.get(row.id)?.provenance, Object.values(listings)),
    adapted: Boolean(byId.get(row.id)?.provenance?.adapted),
  }));
  const tasksInForce = new Map(items.map((item) => {
    const gold = overrides?.canonical?.[item.id];
    return [item.id, gold == null ? item : { ...item, goldCanon: gold }];
  }));
  // Oracles from the stored canonical answers against the gold in force.
  rows = rows.map((row) => {
    const gold = tasksInForce.get(row.id)?.goldCanon;
    const hit = (answers) => (Array.isArray(answers) ? Number(answers.some((answer) => answer != null && answer === gold)) : null);
    return {
      ...row,
      oracleCouncil: hit(row.diagnostics?.councilAnswers),
      oracleB3: hit(row.diagnostics?.replicateAnswers?.slice(0, 3)),
    };
  });
  const tailApplied = { stage1: 0, samples: 0, stage2: 0 };
  for (const row of rows) {
    for (const key of Object.keys(tailApplied)) tailApplied[key] += row.tailApplied?.[key] || 0;
  }
  // A replaying campaign reports the money of its sources too: their answers
  // are its answers, and their POSTs count against the same cap.
  const sourceBudgets = (campaign.replayFrom || []).map((id) => pathsFor(id).budget);
  const ledger = ledgerOf([...sourceBudgets, campaignPaths.budget], campaign);
  const replay = replayLine(campaign, [...readSlotJournal(path.join(dir, 'events.jsonl')).values()], campaignPaths.budget);
  const residual = residualLine([...sourceBudgets, campaignPaths.budget]);
  const testBlocks = campaign.counts?.blocks || {};
  const plannedPrimary = primaryBlocks.reduce((sum, block) => sum + (testBlocks[block]?.test || 0), 0);
  const planned = campaign.counts?.test ?? rows.length;
  const plannedLegacy = planned - plannedPrimary;
  // The primary set, the legacy blocks, and the money each have a status of
  // their own: a budget stop on the legacy blocks does not make the primary
  // reading interim, and unresolved reserves leave only the money preliminary.
  const isDone = (row) => row.status === 'complete';
  const primaryAll = rows.filter((row) => row.set === 'primary');
  const legacyAll = rows.filter((row) => row.set === 'legacy');
  const primaryComplete = primaryAll.length === plannedPrimary && primaryAll.every(isDone);
  const legacyComplete = legacyAll.length === plannedLegacy && legacyAll.every(isDone);
  const moneyFinal = Number(ledger.state.unresolvedUsd || 0) === 0;
  const complete = primaryComplete && legacyComplete;
  const amc = (campaign.blocks || []).includes('amc');
  const goldLines = [];
  if (amc) goldLines.push('AMC 2026 gold: unofficial key published by Think Academy on 2026-11-06; rescore with --gold-overrides once the official key is out.');
  if (overrides) goldLines.push(`Gold overrides from ${overrides.file} (sha ${overrides.sha.slice(0, 12)}) applied to ${Object.keys(overrides.canonical).length} questions; the uncorrected report is kept apart.`);
  const text = renderV5Report({
    rows,
    planned,
    plannedPrimary,
    plannedLegacy,
    complete,
    primaryComplete,
    legacyComplete,
    moneyFinal,
    primaryBlocks,
    family: campaign.secondaryFamily,
    dev: selection.table ? {
      table: selection.table,
      blocks: Object.fromEntries(Object.entries(campaign.counts?.blocks || {})
        .filter(([, counts]) => counts.dev).map(([block, counts]) => [block, counts.dev])),
    } : null,
    lenientRows: lenientRows(rows, tasksInForce),
    lenientRules: LENIENT_RULES,
    listings,
    coverage: campaign.bankExtension?.coverage,
    counters: stageCounters(
      path.join(dir, 'events.jsonl'),
      (campaign.replayFrom || []).map((id) => path.join(pathsFor(id).comparison, 'test', 'events.jsonl')),
    ),
    tailApplied,
    spend: {
      settledUsd: ledger.state.settledUsd,
      unresolvedUsd: ledger.state.unresolvedUsd,
      posts: ledger.state.posts,
      audit: ledger.state.lastAudit || null,
    },
    armCost: armCosts(ledger.state.reservations, selection.b),
    replay,
    residual,
    maxUsd: campaign.maxUsd,
    maxPosts: campaign.maxPosts,
    gold: goldLines.join(' '),
    caps: campaign.stageCaps,
    loopGuard: campaign.loopGuard,
    tailRule: campaign.tailRule,
  });
  const name = overrides ? 'report-corrected' : 'report';
  mkdirSync(campaignPaths.reports, { recursive: true });
  writeFileSync(path.join(campaignPaths.reports, `${name}.md`), text, 'utf8');
  writeJson(path.join(campaignPaths.reports, `${name}.json`), {
    campaign: campaign.id || null,
    complete,
    primaryComplete,
    legacyComplete,
    moneyFinal,
    planned,
    plannedPrimary,
    plannedLegacy,
    scored: rows.filter((row) => row.status === 'complete').length,
    groups: rows.reduce((map, row) => ({ ...map, [row.group]: (map[row.group] || 0) + 1 }), {}),
    tailApplied,
    overrides: overrides ? { file: overrides.file, sha: overrides.sha, entries: overrides.raw } : null,
  });
  console.log(text);
  console.log(`Wrote ${path.join(campaignPaths.reports, `${name}.md`)}`);
  return primaryComplete ? 0 : 2;
}

// ---------------------------------------------------------------------------
// Review of loop stops. The protocol reads every pilot stop by hand before
// test; a false stop halts the campaign. Read-only: no call, no budget.

// Text of one saved stream body: the reasoning channel the engine reads first,
// and the visible content, each as the stream accumulated it.
export function streamTexts(body) {
  const parts = { reasoning: '', reasoningContent: '', details: '', content: '' };
  for (const line of String(body || '').split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const delta = chunk?.choices?.[0]?.delta || {};
    if (typeof delta.reasoning === 'string') parts.reasoning += delta.reasoning;
    if (typeof delta.reasoning_content === 'string') parts.reasoningContent += delta.reasoning_content;
    for (const item of Array.isArray(delta.reasoning_details) ? delta.reasoning_details : []) {
      if (String(item?.type || '').includes('encrypted')) continue;
      const text = [item?.text, item?.summary, item?.content].find((value) => typeof value === 'string');
      if (text) parts.details += text;
    }
    if (typeof delta.content === 'string') parts.content += delta.content;
  }
  let channel = null;
  if (parts.reasoning) channel = 'reasoning';
  else if (parts.reasoningContent) channel = 'reasoningContent';
  else if (parts.details) channel = 'details';
  return { channel, reasoning: channel ? parts[channel] : '', content: parts.content };
}

// Every attempt a phase stopped for a loop, rebuilt from its saved body: where
// the detector fired, how much repeated, what the slot kept in the end, and
// the text just before the stop for a person to judge.
export function loopReview(dir, config, { excerptChars = 1200 } = {}) {
  const journal = path.join(dir, 'events.jsonl');
  if (!existsSync(journal)) return [];
  const slots = new Map();
  const stops = [];
  for (const line of readFileSync(journal, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.kind === 'slot' && event.key) slots.set(event.key, event.slot);
    if (event.kind === 'http' && event.phase === 'finished' && event.cancelReason === 'loop') stops.push(event);
  }
  return stops.map((event) => {
    const slot = slots.get(event.key) || {};
    const bodyFile = event.bodyFile ? path.join(dir, 'bodies', event.bodyFile) : null;
    const texts = streamTexts(bodyFile && existsSync(bodyFile) ? readFileSync(bodyFile, 'utf8') : '');
    let channel = null;
    let hit = texts.reasoning ? detectLoop(texts.reasoning, config) : null;
    if (hit) channel = texts.channel;
    else if (texts.content) {
      hit = detectLoop(texts.content, config);
      if (hit) channel = 'content';
    }
    const text = channel === 'content' ? texts.content : texts.reasoning;
    let outcome = 'pending';
    if (slot.result?.loopCut) outcome = 'kept after a second loop';
    else if (slot.state === 'completed') outcome = 'retried and finished';
    else if (slot.state) outcome = slot.state;
    return {
      attemptId: event.attemptId || null,
      questionId: slot.meta?.questionId ?? null,
      branch: slot.meta?.branch ?? null,
      stage: slot.meta?.stage ?? null,
      model: event.model || slot.meta?.model || null,
      bodyFile: event.bodyFile || null,
      channel,
      position: hit?.position ?? null,
      share: hit?.share ?? null,
      chars: text.length,
      reproduced: Boolean(hit),
      outcome,
      excerpt: hit ? text.slice(Math.max(0, hit.position - excerptChars), hit.position) : text.slice(-excerptChars),
    };
  });
}

const LOOP_REVIEW_DIRS = ['probe', 'dev', 'smoke', 'pilot', 'test'];

function runLoopReview(campaignPaths, argv) {
  const campaign = readJson(campaignPaths.campaign);
  if (!campaign?.loopGuard) throw new Error('This campaign has no loop guard.');
  const of = flagValue(argv, '--of') || 'pilot';
  if (!LOOP_REVIEW_DIRS.includes(of)) throw new Error(`--of takes one of ${LOOP_REVIEW_DIRS.join(', ')}`);
  let dir = path.join(campaignPaths.comparison, of);
  if (of === 'probe') dir = campaignPaths.probe;
  else if (of === 'dev') dir = campaignPaths.dev;
  const rows = loopReview(dir, campaign.loopGuard);
  mkdirSync(campaignPaths.reports, { recursive: true });
  const file = path.join(campaignPaths.reports, `loops-${of}.json`);
  writeJson(file, { phase: of, loopGuard: campaign.loopGuard, reviewedAt: new Date().toISOString(), stops: rows });
  console.log(`${of}: ${rows.length} loop stops`);
  for (const row of rows) {
    console.log(
      `\n${row.questionId} ${row.branch}/${row.stage} ${row.model} body ${row.bodyFile}: `
      + `${row.reproduced ? `${row.channel} at ${row.position} of ${row.chars} chars, ${(row.share * 100).toFixed(0)}% repeated` : 'NOT reproduced offline'}; `
      + `${row.outcome}`,
    );
    console.log(`--- last ${Math.min(400, row.excerpt.length)} chars before the stop ---`);
    console.log(row.excerpt.slice(-400));
  }
  console.log(`\nWrote ${file}. Read every stop: a stop on text that was not looping halts the campaign before test.`);
  return 0;
}

async function report(campaignPaths, argv = []) {
  const extended = readJson(campaignPaths.campaign, {});
  if (extended.primaryBlocks?.length) return reportV5(campaignPaths, extended, argv);
  const dir = path.join(campaignPaths.comparison, 'test');
  const rows = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || name === 'order.json') continue;
      const row = readJson(path.join(dir, name));
      if (row?.id) rows.push(row);
    }
  }
  const campaign = readJson(campaignPaths.campaign, {});
  const budgetEvents = readJsonl(campaignPaths.budget);
  const spend = journalSpend(campaignPaths.budget, campaign);
  const priorSpend = campaign.carriedSpend?.runs || [];
  let reuseSlots = [];
  for (const file of journalsOf(path.basename(campaignPaths.dir))) {
    reuseSlots = reuseSlots.concat([...readSlotJournal(file).values()]);
  }
  // A slot's httpAttempts also counts attempts its source run spent, so the
  // fresh count comes from this run's own budget journal: one reserve per POST.
  const reuse = { reusedSlots: reuseStats(reuseSlots).reusedSlots, freshPosts: spend.posts };
  const pause = [...budgetEvents].reverse().find((event) => event.kind === 'pause');
  const planned = TEST_QUESTIONS;
  const scored = rows.filter((row) => row.status === 'complete').length;
  const complete = rows.length === planned && scored === rows.length;
  const text = renderA8Report({
    rows,
    planned,
    complete,
    spend,
    priorSpend,
    reuse,
    armRules: campaign.armRules || null,
    stageCaps: campaign.stageCaps || null,
    streamTimeoutSeconds: campaign.streamTimeoutSeconds ?? null,
    secondaryPairs: campaign.secondaryPairs || null,
    history: historicalNote(),
    note: pause
      ? `Stop: ${pause.reason}. Questions left for that reason stay pending and are not scored incorrect.`
      : null,
  });
  mkdirSync(campaignPaths.reports, { recursive: true });
  writeFileSync(path.join(campaignPaths.reports, 'report.md'), text, 'utf8');
  writeJson(path.join(campaignPaths.reports, 'report.json'), {
    campaign: campaign.id || null,
    complete,
    planned,
    scored,
    spend,
    priorSpend,
    reuse,
    replayFrom: campaign.replayFrom || [],
    stageCaps: campaign.stageCaps || null,
    streamTimeoutSeconds: campaign.streamTimeoutSeconds ?? null,
    sourceDifferences: campaign.sourceDifferences || {},
  });
  console.log(text);
  console.log(`Wrote ${path.join(campaignPaths.reports, 'report.md')}`);
  return complete ? 0 : 2;
}

export async function runA8Command(argv) {
  const phase = flagValue(argv, '--phase');
  if (phase === 'prepare') return runPrepare(argv);
  const runId = flagValue(argv, '--run') || CAMPAIGN_ID;
  const live = argv.includes('--live');
  const dry = argv.includes('--dry-run');
  if (!phase) throw new Error('a8 requires --phase');
  if (live && dry) throw new Error('Choose either --live or --dry-run');
  if (runId === 'main' || runId === 'a8-strong-v1' || runId.includes('repair') || runId.includes('complete')) {
    throw new Error('Refusing to write this experiment into main, a8-strong-v1, repair, or complete.');
  }
  const maxUsd = flagValue(argv, '--max-usd');
  const maxPosts = flagValue(argv, '--max-posts');
  const routesFrom = flagValue(argv, '--routes-from');
  const campaignPaths = pathsFor(runId);
  mkdirSync(campaignPaths.dir, { recursive: true });
  // Caps are chosen once, at preflight, and then read from campaign.json.
  const capFlags = {
    stage1: positiveFlag(argv, '--stage1-cap', null),
    stage2: positiveFlag(argv, '--stage2-cap', null),
    stage3: positiveFlag(argv, '--final-cap', null),
  };
  const capsMode = flagValue(argv, '--caps');
  const caps = capsFrom(capFlags);
  const existing = readJson(campaignPaths.campaign);
  if (existing) {
    if (maxUsd != null && Number(maxUsd) !== existing.maxUsd) throw new Error('Refusing to change maxUsd on an existing campaign.');
    if (maxPosts != null && Number(maxPosts) !== existing.maxPosts) throw new Error('Refusing to change maxPosts on an existing campaign.');
    for (const [stage, value] of Object.entries(capFlags)) {
      if (value != null && existing.stageCaps?.[stage] !== value) {
        throw new Error(`This campaign caps ${stage} at ${existing.stageCaps?.[stage]}. Caps are fixed at preflight.`);
      }
    }
    if (routesFrom && existing.routesInheritedFrom !== routesFrom) {
      throw new Error(`This campaign takes its routes from ${existing.routesInheritedFrom || 'its own preflight'}.`);
    }
  } else if (phase !== 'preflight') {
    throw new Error('Run preflight before this phase.');
  } else if (!routesFrom && maxUsd != null && Number(maxUsd) !== MAX_USD) {
    throw new Error(`This profile locks maxUsd at ${MAX_USD}. A new extended campaign (--routes-from) sets its own.`);
  } else if (!routesFrom && maxPosts != null && Number(maxPosts) !== MAX_POSTS) {
    throw new Error(`This profile locks maxPosts at ${MAX_POSTS}. A new extended campaign (--routes-from) sets its own.`);
  }
  // With --routes-from, --from adds a replay of another extended campaign that
  // used the same routes (extendedReplay checks it).
  const fromFlag = flagValue(argv, '--from');
  const from = fromFlag ? fromFlag.split(',').map((id) => id.trim()).filter(Boolean) : null;
  if (from && phase !== 'preflight') {
    const pinned = existing?.replayFrom || [];
    if (from.join(',') !== pinned.join(',')) {
      throw new Error(`This campaign replays from [${pinned.join(', ')}]. --from is fixed at preflight.`);
    }
  }
  // Read-only and safe beside a running phase, so it takes no lock.
  if (phase === 'loops') return runLoopReview(campaignPaths, argv);
  const release = acquireLock(campaignPaths.dir);
  try {
    if (phase === 'preflight') {
      if (routesFrom) {
        const blocksFlag = flagValue(argv, '--blocks');
        return await routesPreflight(campaignPaths, runId, {
          routesFrom,
          capsMode,
          capFlags,
          blocks: blocksFlag ? blocksFlag.split(',').map((block) => block.trim()).filter(Boolean) : [],
          maxUsd: maxUsd != null ? positiveFlag(argv, '--max-usd', MAX_USD) : MAX_USD,
          maxPosts: maxPosts != null ? positiveFlag(argv, '--max-posts', MAX_POSTS) : MAX_POSTS,
          replayFrom: from,
        });
      }
      if (capsMode) throw new Error('--caps max needs --routes-from.');
      if (from) return await inheritPreflight(campaignPaths, runId, from, caps);
      return await preflight(campaignPaths, live, caps);
    }
    if (phase === 'report') return await report(campaignPaths, argv);
    if (phase === 'reconcile') {
      // Plain reconcile only reads prices; the self-test posts a paid call.
      if (argv.includes('--self-test') && !live) throw new Error('reconcile --self-test posts only with --live');
      return await runReconcile(campaignPaths, argv);
    }
    if (!live) throw new Error(`${phase} posts only with --live`);
    if (phase === 'probe') return await runProbe(campaignPaths);
    const run = { ...runFlags(argv), acceptForecast: argv.includes('--accept-forecast') };
    if (phase === 'dev') return await runDev(campaignPaths, run);
    if (phase === 'smoke' || phase === 'pilot' || phase === 'test') {
      return await runPipeline(campaignPaths, phase, run);
    }
    throw new Error(`Unknown a8 phase ${phase}`);
  } finally {
    release();
  }
}
