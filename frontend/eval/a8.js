import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { freeEndpointsUrl } from '../src/engine/browser/freeRoster.js';
import { catalogueEntry, OPENROUTER_KEY_URL, OPENROUTER_MODELS_URL, queryModelResult } from '../src/engine/browser/openrouter.js';
import { settings } from '../src/engine/browser/settings.js';
import { taskPublicId } from './datasets.js';
import { answerPrompt, gradeResponse, failureKind } from './grade.js';
import { BudgetPaused, createCampaignBudget } from './budget.js';
import { createSession, readSlotJournal, snapshotLocal } from './runtime.js';
import { runIsolated } from './questionScope.js';
import { installTransport } from './transport.js';
import { runComparison } from './a8Variants.js';
import { renderA8Report } from './a8Report.js';
import {
  CALLS_PER_QUESTION,
  CAMPAIGN_ID,
  COUNCIL_SIZE,
  DEFAULT_JOBS,
  DEFAULT_MAX_RESUMES,
  DEFAULT_MODEL_IN_FLIGHT,
  DEV_PER_BLOCK,
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
const SOURCE_FILES = [
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
  '../src/engine/browser/council.js',
  '../src/engine/browser/openrouter.js',
];

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

function loadBank() {
  const bank = readJson(BANK_PATH);
  if (!bank?.items) throw new Error('No cached bank. Run prepare first.');
  const items = bank.items.map((item) => ({
    ...item,
    id: `${item.split}:${taskPublicId(item)}`,
  }));
  const digest = sha256(stableStringify(items.map((item) => ({
    split: item.split,
    block: item.block,
    dataset: item.dataset,
    sourceId: item.sourceId,
    kind: item.kind,
    gold: item.goldCanon,
    fingerprint: item.fingerprint,
    choiceCount: item.choiceCount,
  }))));
  return { bank, items, digest };
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
    reports: path.join(dir, 'reports'),
  };
}

function questionFile(dir, id) {
  return path.join(dir, `${String(id).replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`);
}

function interleave(items) {
  const blocks = ['aime', 'gpqa', 'mmlu'];
  const groups = Object.fromEntries(blocks.map((block) => [
    block,
    items.filter((item) => item.block === block).sort((left, right) => compareHash(SCHEDULE_SEED, left.id, right.id)),
  ]));
  const order = [];
  let index = 0;
  while (order.length < items.length) {
    for (const block of blocks) {
      if (groups[block][index]) order.push(groups[block][index]);
    }
    index += 1;
  }
  return order;
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
  const files = [path.join(paths.probe, 'events.jsonl'), path.join(paths.dev, 'events.jsonl')];
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
// slot is called again here, and the attempts it already spent count.
export function loadReplaySources(runIds, { maxAttempts = MAX_ATTEMPTS, journals = journalsOf } = {}) {
  const reuse = new Map();
  const prior = new Map();
  for (const id of runIds) {
    for (const file of journals(id)) {
      for (const [key, slot] of readSlotJournal(file)) {
        if (String(slot.meta?.model || '').endsWith(':free')) continue;
        if (reuse.has(key)) continue;
        const attempts = slot.httpAttempts || 0;
        const answered = slot.state === 'completed' && slot.result?.ok === true;
        const exhausted = slot.state === 'failed' && attempts >= maxAttempts;
        if (answered || exhausted) {
          reuse.set(key, { ...slot, sourceRun: id });
          prior.delete(key);
        } else if (attempts > 0) {
          prior.set(key, Math.max(prior.get(key) || 0, attempts));
        }
      }
    }
  }
  return { reuse, prior };
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

function policyFrom(preflight) {
  const routes = {};
  for (const route of preflight.routes || []) routes[route.id] = route;
  return { caps: STAGE_CAPS, routes };
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
      aliasOf: (model) => model,
      replayTerminal: true,
    } : {}),
  };
}

function assertCompatible(campaignPaths, phase) {
  const campaign = readJson(campaignPaths.campaign);
  if (!campaign) throw new Error('Run preflight before this phase.');
  sameSource(campaign.sourceHash, 'Campaign');
  const bank = loadBank();
  if (campaign.bankDigest !== bank.digest) throw new Error('Bank digest does not match the campaign.');
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

// Fields whose change would alter a request or a score. A replay source must
// agree on all of them, or its slots are not this method's slots.
const REPLAY_PROFILE_FIELDS = [
  'maxAttempts', 'councilSize', 'selfSamples', 'stageCaps', 'temperature', 'topP',
  'nSamples', 'topK', 'selfExclusion', 'scheduleSeed', 'redTeam', 'generationSeed',
];

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
async function inheritPreflight(campaignPaths, runId, fromIds) {
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
  const profile = profileDocument();
  const runs = [];
  for (const id of fromIds) {
    const source = pathsFor(id);
    const sourceCampaign = readJson(source.campaign);
    if (sourceCampaign.bankDigest !== digest) throw new Error(`Replay source ${id} used another bank.`);
    for (const field of REPLAY_PROFILE_FIELDS) {
      if (stableStringify(sourceCampaign[field] ?? null) !== stableStringify(profile[field] ?? null)) {
        throw new Error(`Replay source ${id} differs on ${field}.`);
      }
    }
    runs.push({ run: id, ...journalSpend(source.budget, sourceCampaign) });
  }
  const sourcePreflight = readJson(pathsFor(fromIds[0]).preflight);
  if (!sourcePreflight?.routes?.length) throw new Error(`Replay source ${fromIds[0]} has no route snapshot.`);
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
  });
  console.log(
    `preflight inherited ${sourcePreflight.routes.length} routes from ${fromIds[0]}; `
    + `carried spend $${carriedSpend.settledUsd.toFixed(4)} settled, $${carriedSpend.unresolvedUsd.toFixed(4)} unresolved, `
    + `${carriedSpend.posts} posts`,
  );
  return 0;
}

async function preflight(campaignPaths, live) {
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
  const counts = {
    smoke: items.filter((item) => item.split === 'smoke').length,
    dev: items.filter((item) => item.split === 'dev').length,
    test: items.filter((item) => item.split === 'test').length,
  };
  if (counts.smoke !== SMOKE_COUNT || counts.dev !== DEV_PER_BLOCK * 3 || counts.test !== TEST_QUESTIONS) {
    throw new Error(`Unexpected bank counts ${JSON.stringify(counts)}`);
  }
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
  if (routes.length < COUNCIL_SIZE) throw new Error(`Only ${routes.length} paid routes qualified.`);
  const synthesisTokens = (SELF_SAMPLES * STAGE_CAPS.stage1) + 4000;
  for (const route of routes.slice(0, SHORTLIST_LIMIT)) {
    const fits = route.context == null || synthesisTokens <= route.context;
    const quote = quoteReservation({
      pricing: route.pricing,
      promptTokens: Math.min(synthesisTokens, route.context || synthesisTokens),
      maxTokens: STAGE_CAPS.stage3,
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
    id: CAMPAIGN_ID,
    ...profileDocument(),
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

function prepareFor(policy) {
  return (model, stage, options) => {
    const cap = policy.caps?.[stage];
    const route = policy.routes?.[model];
    if (cap == null) throw new EvalInvariantError(`No token cap for stage ${stage || 'missing'}`);
    if (!route) throw new EvalInvariantError(`Model ${model} is outside the paid allowlist`);
    const next = { ...options, maxTokens: cap, provider: route.provider };
    if (route.temperature != null) next.temperature = route.temperature;
    if (route.topP != null) next.topP = route.topP;
    if (route.reasoning) next.reasoning = route.reasoning;
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
  const active = [...(preflightDoc.candidates || [])];
  const reserves = [...(preflightDoc.reserves || [])];
  const routes = preflightDoc.routes.filter((route) => active.includes(route.id) || reserves.includes(route.id));
  // The probe checks that each route answers today, so it never replays.
  const session = createSession({
    runDir: campaignPaths.probe,
    budget,
    prepareOptions: prepareFor(policyFrom({ routes })),
    maxInFlight: active.length,
    ...sessionBudget(),
  });
  session.install();
  const restore = installPaid(session, budget, routes);
  const smoke = bank.items.filter((item) => item.split === 'smoke');
  const results = readJson(path.join(campaignPaths.probe, 'rows.json'), []);
  const baseSnap = snapshotLocal();
  try {
    let replacements = saved?.replacements || 0;
    for (let index = 0; index < smoke.length; index += 1) {
      const task = smoke[index];
      console.log(`probe ${index + 1}/${smoke.length} ${task.block}: ${active.length} routes at once`);
      const models = [...active];
      const answered = await runIsolated(baseSnap, 0, async () => {
        session.setContext({ questionId: task.id, branch: 'probe', stage: 'stage1', sample: 1 });
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
        const slot = session.slots().find((item) => item.meta?.questionId === task.id && item.meta?.model === model);
        const grade = result?.ok ? gradeResponse(task, result.content || '') : gradeResponse(task, '', failureKind(result));
        results.push({
          id: task.id,
          model,
          http: slot?.httpStatus ?? null,
          correct: grade.correct,
          status: grade.status,
        });
        console.log(`probe ${model} http ${slot?.httpStatus ?? 'n/a'} ${grade.status}`);
        if (slot?.httpStatus === 401) {
          writeJson(path.join(campaignPaths.probe, 'rows.json'), results);
          console.log('probe paused: auth');
          return 2;
        }
        const bad = slot?.httpStatus === 400 || slot?.httpStatus === 404;
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
    writeJson(path.join(campaignPaths.probe, 'results.json'), {
      done: true,
      active,
      replacements,
      settledUsd: budget.state.settledUsd,
      unresolvedUsd: budget.state.unresolvedUsd,
      posts: budget.state.posts,
    });
    console.log(`probe done. Active: ${active.join(', ')}`);
    return 0;
  } finally {
    session.uninstall();
    restore();
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
  const models = probe.active;
  const routes = preflightDoc.routes.filter((route) => models.includes(route.id));
  const key = loadPaidKey();
  settings.apiKey = key;
  const budget = openBudget(campaignPaths, priceMap(preflightDoc), campaign);
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
    prepareOptions: prepareFor(policyFrom({ routes })),
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
  }
}

function runnerNote(run) {
  return {
    jobs: run.jobs,
    httpInFlight: run.inFlight,
    perModelInFlight: run.modelInFlight,
    note: 'Pacing only. Requests, caps, and retry limits are unchanged.',
  };
}

async function runPipeline(campaignPaths, phase, run) {
  const { campaign, bank, preflight: preflightDoc } = assertCompatible(campaignPaths, phase);
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
  if (phase === 'smoke') items = bank.items.filter((item) => item.split === 'smoke');
  else if (phase === 'pilot') {
    const dev = bank.items.filter((item) => item.split === 'dev');
    items = ['aime', 'gpqa', 'mmlu'].flatMap((block) => (
      dev.filter((item) => item.block === block)
        .sort((left, right) => compareHash(SCHEDULE_SEED, left.id, right.id))
        .slice(0, PILOT_PER_BLOCK)
    ));
  } else items = interleave(bank.items.filter((item) => item.split === 'test'));
  const dir = path.join(campaignPaths.comparison, phase);
  mkdirSync(dir, { recursive: true });
  const orderFile = path.join(dir, 'order.json');
  const order = readJson(orderFile) || items.map((item) => item.id);
  if (!existsSync(orderFile)) writeJson(orderFile, order);
  writeJson(path.join(dir, 'runner.json'), { ...runnerNote(run), startedAt: new Date().toISOString() });
  const byId = new Map(items.map((item) => [item.id, item]));
  const key = loadPaidKey();
  settings.apiKey = key;
  const baseSnap = snapshotLocal();
  const budget = openBudget(campaignPaths, priceMap({ routes }), campaign);
  const replay = replaySources(campaign);
  const session = createSession({
    runDir: dir,
    budget,
    prepareOptions: prepareFor(policyFrom({ routes })),
    maxInFlight: run.inFlight,
    maxInFlightPerModel: run.modelInFlight,
    ...sessionBudget(replay),
  });
  session.install();
  const restore = installPaid(session, budget, routes);
  try {
    const code = await runPasses({
      label: phase,
      order,
      isDone: (id) => readJson(questionFile(dir, id))?.status === 'complete',
      budget,
      session,
      run,
      runOne: async (id, index) => {
        const task = byId.get(id);
        try {
          const result = await runIsolated(baseSnap, index, () => (
            runComparison(task, session, frozen, { scheduleSeed: SCHEDULE_SEED })
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
    if (code) return code;
    if (phase === 'pilot') {
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
  }
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

async function report(campaignPaths) {
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
  });
  console.log(text);
  console.log(`Wrote ${path.join(campaignPaths.reports, 'report.md')}`);
  return complete ? 0 : 2;
}

export async function runA8Command(argv) {
  const phase = flagValue(argv, '--phase');
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
  const campaignPaths = pathsFor(runId);
  mkdirSync(campaignPaths.dir, { recursive: true });
  const existing = readJson(campaignPaths.campaign);
  if (existing) {
    if (maxUsd != null && Number(maxUsd) !== existing.maxUsd) throw new Error('Refusing to change maxUsd on an existing campaign.');
    if (maxPosts != null && Number(maxPosts) !== existing.maxPosts) throw new Error('Refusing to change maxPosts on an existing campaign.');
  } else if (phase !== 'preflight') {
    throw new Error('Run preflight before this phase.');
  } else if (maxUsd != null && Number(maxUsd) !== MAX_USD) {
    throw new Error(`This profile locks maxUsd at ${MAX_USD}.`);
  } else if (maxPosts != null && Number(maxPosts) !== MAX_POSTS) {
    throw new Error(`This profile locks maxPosts at ${MAX_POSTS}.`);
  }
  const fromFlag = flagValue(argv, '--from');
  const from = fromFlag ? fromFlag.split(',').map((id) => id.trim()).filter(Boolean) : null;
  if (from && phase !== 'preflight') {
    const pinned = existing?.replayFrom || [];
    if (from.join(',') !== pinned.join(',')) {
      throw new Error(`This campaign replays from [${pinned.join(', ')}]. --from is fixed at preflight.`);
    }
  }
  const release = acquireLock(campaignPaths.dir);
  try {
    if (phase === 'preflight') {
      if (from) return await inheritPreflight(campaignPaths, runId, from);
      return await preflight(campaignPaths, live);
    }
    if (phase === 'report') return await report(campaignPaths);
    if (!live) throw new Error(`${phase} posts only with --live`);
    if (phase === 'probe') return await runProbe(campaignPaths);
    const run = runFlags(argv);
    if (phase === 'dev') return await runDev(campaignPaths, run);
    if (phase === 'smoke' || phase === 'pilot' || phase === 'test') {
      return await runPipeline(campaignPaths, phase, run);
    }
    throw new Error(`Unknown a8 phase ${phase}`);
  } finally {
    release();
  }
}
