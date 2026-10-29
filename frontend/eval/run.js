import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OPENROUTER_KEY_URL,
  OPENROUTER_MODELS_URL,
  queryModelResult,
} from '../src/engine/browser/openrouter.js';
import { catalogueId, readBlockedIds } from '../src/engine/browser/roster.js';
import { settings } from '../src/engine/browser/settings.js';
import { createBudget } from './budget.js';
import { buildBank, taskPublicId } from './datasets.js';
import { answerPrompt, failureKind, gradeResponse } from './grade.js';
import {
  INCIDENT,
  PUBLISHED_KEY_SHA256,
  SCHEDULE_SEED,
  TEST_COUNTS,
  TOTAL_POST_CAP,
  protocolHash,
} from './protocol.js';
import { analyze, renderReport, renderSummary, replaceSection } from './report.js';
import { createSession, snapshotLocal } from './runtime.js';
import { configsFor, selectFromDev, selectSearchPool } from './select.js';
import { loadRawSources, sourceMetadata } from './sources.js';
import { installTransport } from './transport.js';
import { compareHash, sha256 } from './util.js';
import { runQuestion } from './variants.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(EVAL_ROOT, '.cache');
const RUNS_DIR = path.join(EVAL_ROOT, '.runs');
const README_PATH = path.resolve(EVAL_ROOT, '../../README.md');
const README_START = '<!-- eval-results:start -->';
const README_END = '<!-- eval-results:end -->';

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function redact(value) {
  if (typeof value === 'string') return value.replace(/sk-or-[A-Za-z0-9_-]+/g, '[redacted]');
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redact(item);
    return out;
  }
  return value;
}

function loadKey() {
  let key = process.env.OPENROUTER_API_KEY || '';
  if (!key.trim()) {
    for (const candidate of [path.resolve(EVAL_ROOT, '../../.env'), path.resolve(EVAL_ROOT, '../.env'), path.resolve('.env')]) {
      if (!existsSync(candidate)) continue;
      const line = readFileSync(candidate, 'utf8').split(/\r?\n/).find((row) => row.startsWith('OPENROUTER_API_KEY='));
      if (!line) continue;
      key = line.slice('OPENROUTER_API_KEY='.length).trim().replace(/^['"]|['"]$/g, '');
      if (key) break;
    }
  }
  key = key.trim();
  if (!key) throw new Error('OPENROUTER_API_KEY is missing. The bench will not use a key found in source.');
  if (sha256(key) === PUBLISHED_KEY_SHA256) {
    throw new Error('Refusing the published OpenRouter key. Revoke it and set a personal key.');
  }
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
    if (alive) throw new Error(`Another runner holds ${file} (pid ${pid})`);
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

function runPaths(runId) {
  const dir = path.join(RUNS_DIR, runId);
  return {
    dir,
    state: path.join(dir, 'state.json'),
    manifest: path.join(dir, 'manifest.json'),
    questions: path.join(dir, 'questions'),
    reportJson: path.join(dir, 'report.json'),
    reportMd: path.join(dir, 'report.md'),
    summaryMd: path.join(dir, 'summary.md'),
  };
}

function loadBank() {
  const bank = readJson(path.join(CACHE_DIR, 'bank.json'));
  if (!bank) throw new Error('No cached bank. Run: npm --prefix frontend run eval -- prepare');
  if (bank.protocolHash !== protocolHash()) {
    throw new Error('Cached bank was built for a different protocol. Run prepare again.');
  }
  return bank;
}

function identify(items) {
  return items.map((item) => ({ ...item, id: `${item.split}:${taskPublicId(item)}` }));
}

function shuffleIds(items, salt) {
  return [...items].sort((left, right) => compareHash(`${SCHEDULE_SEED}\n${salt}`, left.id, right.id));
}

function nominalCosts(councilSize, aliasA0) {
  const members = councilSize;
  return {
    A0: 1,
    A1: 1,
    A2: 5,
    A3: 6,
    A4: members,
    A5: members * 2,
    A6: members * 2 + 2,
    A7: members * 2 + 1,
    aliasA0,
    note: aliasA0
      ? 'A0 uses the same call as A1, so the bank omits one generation.'
      : 'A0 is a separate chairman call.',
  };
}

function applyFrozen(frozen, apiKey) {
  settings.apiKey = apiKey;
  settings.councilModels = [...frozen.councilModels];
  settings.chairmanModel = frozen.chairmanModel;
  settings.redTeamModel = null;
  settings.nSamples = 1;
  settings.topK = 3;
  settings.selfExclusion = true;
}

function openRun(runId, apiKey) {
  const paths = runPaths(runId);
  const release = acquireLock(paths.dir);
  const state = readJson(paths.state, {
    protocolHash: protocolHash(),
    budget: null,
    smokeComplete: false,
    frozen: false,
    checked40: false,
  });
  if (state.protocolHash !== protocolHash()) {
    release();
    throw new Error('This run directory belongs to a different protocol hash.');
  }
  const budget = createBudget({ totalCap: state.totalCap || TOTAL_POST_CAP });
  if (state.budget) budget.restore(state.budget);
  budget.rollDay();
  const reserved = countReserved(path.join(paths.dir, 'events.jsonl'));
  if (reserved > budget.state.attempted) budget.state.attempted = reserved;
  if (budget.state.pauseReason === 'provider_cooldown') {
    budget.state.paused = false;
    budget.state.pauseReason = null;
    budget.state.resumeAfter = null;
  }
  budget.resumeIfDue();
  const session = createSession({ runDir: paths.dir, budget });
  session.install();
  const allow = new Set(state.allowModels || []);
  const restoreFetch = installTransport({
    allowModels: allow,
    budget,
    onHttp: session.onHttp,
    onCooldown: session.onCooldown,
  });
  settings.apiKey = apiKey;
  return {
    paths,
    state,
    budget,
    session,
    allow,
    close() {
      session.uninstall();
      restoreFetch();
      state.budget = budget.snapshot();
      writeJson(paths.state, state);
      release();
    },
  };
}

async function refreshKey(budget) {
  const response = await fetch(OPENROUTER_KEY_URL, {
    headers: { Authorization: `Bearer ${settings.apiKey}` },
  });
  if (!response.ok) throw new Error(`Key endpoint HTTP ${response.status}`);
  const body = await response.json();
  const data = body.data || body;
  budget.noteServer(data);
  return redact(data);
}

async function refreshBudget(budget) {
  const data = await refreshKey(budget);
  if (budget.state.pauseReason === 'platform_day' && budget.state.serverRemaining > 0) {
    budget.state.paused = false;
    budget.state.pauseReason = null;
    budget.state.resumeAfter = null;
  }
  return data;
}

async function ensureDailyBudget(budget) {
  const today = new Date().toISOString().slice(0, 10);
  if (budget.state.utcDay === today && budget.state.serverRemaining != null && !budget.state.paused) {
    return;
  }
  budget.rollDay();
  await refreshBudget(budget);
}

function countReserved(file) {
  if (!existsSync(file)) return 0;
  let count = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"phase":"reserved"')) continue;
    try {
      const event = JSON.parse(line);
      if (event.kind === 'http' && event.phase === 'reserved') count += 1;
    } catch {
      // A torn final line is completed by a later append.
    }
  }
  return count;
}

async function prepare() {
  mkdirSync(CACHE_DIR, { recursive: true });
  console.log('Preparing the exact-answer bank. Question text stays in the gitignored cache.');
  const raw = await loadRawSources(CACHE_DIR);
  const bank = buildBank(raw);
  const saved = {
    protocolHash: protocolHash(),
    sources: sourceMetadata(),
    counts: bank.counts,
    mmluQuotas: bank.mmluQuotas,
    items: bank.items,
  };
  writeJson(path.join(CACHE_DIR, 'bank.json'), saved);
  console.log(`Bank ready: dev ${bank.counts.dev}, smoke ${bank.counts.smoke}, test ${bank.counts.test}.`);
  return 0;
}

async function preflight(runId) {
  const key = loadKey();
  const run = openRun(runId, key);
  try {
    console.log('Fetching the model catalogue and key counters.');
    const modelsResponse = await fetch(OPENROUTER_MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!modelsResponse.ok) {
      throw new Error(`Model catalogue HTTP ${modelsResponse.status}`);
    }
    const modelsBody = await modelsResponse.json();
    const models = modelsBody.data || [];
    const keyInfo = await refreshBudget(run.budget);
    const pool = selectSearchPool(models);
    writeJson(path.join(CACHE_DIR, 'catalogue.json'), redact({ fetchedAt: new Date().toISOString(), models }));
    writeJson(path.join(CACHE_DIR, 'key.json'), { fetchedAt: new Date().toISOString(), key: keyInfo });
    run.state.pool = pool.map((model) => ({
      id: model.id,
      vendor: model.vendor,
      size: model.size,
      supported_parameters: model.supported_parameters || [],
      context_length: model.context_length || null,
      pricing: model.pricing || null,
    }));
    run.state.allowModels = pool.map((model) => catalogueId(model.id));
    run.allow.clear();
    for (const id of run.state.allowModels) run.allow.add(id);
    console.log(`Pool: ${run.state.pool.length} vendors. Daily remaining: ${run.budget.state.serverRemaining ?? 'unknown, local conservative cap'}.`);
    return 0;
  } finally {
    run.close();
  }
}

function usablePool(state) {
  const blocked = new Set(state.blockedModels || []);
  return (state.pool || []).filter((model) => !blocked.has(catalogueId(model.id)));
}

function blockedFromJournal(dir) {
  const ids = new Set();
  const file = path.join(dir, 'events.jsonl');
  if (!existsSync(file)) return ids;
  for (const line of readFileSync(file, 'utf8').split(/\n/)) {
    if (!line.includes('"status":403') && !line.includes('"skipped":true')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.kind === 'http' && event.status === 403 && event.model) {
      ids.add(catalogueId(event.model));
    }
  }
  return ids;
}

function forgetStopped(dir, name) {
  const questions = path.join(dir, 'questions');
  if (!existsSync(questions)) return;
  for (const file of readdirSync(questions)) {
    const full = path.join(questions, file);
    const saved = readJson(full);
    if (saved?.split === name && saved.status === 'stopped') unlinkSync(full);
  }
}

function provisionalFrozen(pool) {
  const council = pool.slice(0, Math.min(5, pool.length)).map((model) => model.id);
  return {
    councilModels: council,
    chairmanModel: council[0],
    bModel: council[0],
    provisional: true,
  };
}

async function runSplit(run, name, items, frozen) {
  const orderFile = path.join(run.paths.dir, `${name}-order.json`);
  const existing = readJson(orderFile);
  const ordered = existing || shuffleIds(items, name).map((item) => item.id);
  if (!existing) writeJson(orderFile, ordered);
  const byId = new Map(items.map((item) => [item.id, item]));
  applyFrozen(frozen, settings.apiKey);
  const baseSnap = snapshotLocal();
  let completed = 0;
  for (const id of ordered) {
    const file = path.join(run.paths.questions, `${id.replace(/[^a-zA-Z0-9._-]+/g, '_')}.json`);
    const saved = readJson(file);
    if (saved?.status === 'complete') {
      completed += 1;
      continue;
    }
    if (saved?.status === 'stopped') return saved;
    if (run.budget.state.paused) {
      console.log(`Paused before item ${completed + 1}/${ordered.length}: ${run.budget.state.pauseReason}`);
      return { status: 'paused', reason: run.budget.state.pauseReason };
    }
    await ensureDailyBudget(run.budget);
    if (run.budget.state.paused) {
      console.log(`Paused before item ${completed + 1}/${ordered.length}: ${run.budget.state.pauseReason}`);
      return { status: 'paused', reason: run.budget.state.pauseReason };
    }
    const task = byId.get(id);
    console.log(`${name} ${completed + 1}/${ordered.length} ${task?.block || 'item'}`);
    const result = await runQuestion(byId.get(id), run.session, frozen, baseSnap);
    writeJson(file, result);
    run.state.budget = run.budget.snapshot();
    writeJson(run.paths.state, run.state);
    if (result.status !== 'complete') return result;
    completed += 1;
    if (name === 'test' && completed === 40 && !run.state.checked40) {
      await refreshBudget(run.budget);
      const check = {
        ok: run.state.protocolHash === protocolHash(),
        completed,
        posts: run.budget.state.attempted,
        exclusions: 0,
      };
      writeJson(path.join(run.paths.dir, 'checkpoint-40.json'), check);
      run.state.checked40 = true;
      console.log(`Operational checkpoint after 40: posts ${check.posts}. N stays 120.`);
      if (!check.ok) return { status: 'stopped', reason: 'protocol' };
    }
  }
  return { status: 'complete', completed };
}

async function smoke(runId) {
  const key = loadKey();
  const run = openRun(runId, key);
  try {
    if (!run.state.pool?.length) throw new Error('Run preflight before smoke.');
    await refreshBudget(run.budget);
    const bank = loadBank();
    const items = identify(bank.items.filter((item) => item.split === 'smoke'));
    const discovered = blockedFromJournal(run.paths.dir);
    if (discovered.size) {
      run.state.blockedModels = [...new Set([...(run.state.blockedModels || []), ...discovered])];
    }
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      forgetStopped(run.paths.dir, 'smoke');
      const pool = usablePool(run.state);
      if (!pool.length) throw new Error('No usable free models remain after exclusions.');
      const frozen = provisionalFrozen(pool);
      console.log(`Smoke council size ${frozen.councilModels.length}, attempt ${attempt}. This does not select models.`);
      const result = await runSplit(run, 'smoke', items, frozen);
      if (result.status === 'stopped' && result.reason === 'roster_mutation') {
        const blocked = new Set(run.state.blockedModels || []);
        for (const id of readBlockedIds()) blocked.add(id);
        run.state.blockedModels = [...blocked];
        console.log(`Excluded models the account cannot use: ${run.state.blockedModels.join(', ')}`);
        continue;
      }
      run.state.smokeComplete = result.status === 'complete';
      console.log(`Smoke ${result.status}.`);
      return exitCodeFor(result);
    }
    throw new Error('Provisional smoke roster was rejected too many times.');
  } finally {
    run.close();
  }
}

async function dev(runId) {
  const key = loadKey();
  const run = openRun(runId, key);
  try {
    if (!run.state.smokeComplete) throw new Error('Finish smoke before dev selection.');
    await refreshBudget(run.budget);
    const bank = loadBank();
    const devItems = identify(bank.items.filter((item) => item.split === 'dev'));
    const pool = usablePool(run.state);
    const configs = pool.flatMap((model) => configsFor(model));
    const provisional = provisionalFrozen(pool);
    applyFrozen(provisional, key);
    const rows = [];
    let index = 0;
    const total = configs.length * devItems.length;
    for (const config of configs) {
      if ((run.state.blockedModels || []).includes(catalogueId(config.model))) {
        index += devItems.length;
        console.log(`dev skip ${config.configId}`);
        continue;
      }
      let excluded = false;
      for (const task of devItems) {
        index += 1;
        if (excluded) continue;
        if (run.budget.state.paused) {
          console.log(`Dev paused at ${index - 1}/${total}: ${run.budget.state.pauseReason}`);
          return 2;
        }
        await ensureDailyBudget(run.budget);
        if (run.budget.state.paused) {
          console.log(`Dev paused at ${index - 1}/${total}: ${run.budget.state.pauseReason}`);
          return 2;
        }
        console.log(`dev ${index}/${total} ${config.configId} ${task.block}`);
        run.session.setContext({
          questionId: task.id,
          branch: 'dev',
          stage: config.configId,
          sample: 1,
        });
        const result = await queryModelResult(config.model, [{
          role: 'user',
          content: answerPrompt(task),
        }]);
        await run.session.drain();
        const drifted = settings.councilModels.join('\n') !== provisional.councilModels.join('\n')
          || settings.chairmanModel !== provisional.chairmanModel
          || settings.redTeamModel;
        if (drifted) {
          const blocked = new Set(run.state.blockedModels || []);
          for (const id of readBlockedIds()) blocked.add(catalogueId(id));
          blocked.add(catalogueId(config.model));
          run.state.blockedModels = [...blocked];
          const nextPool = usablePool(run.state);
          if (!nextPool.length) throw new Error('No usable free models remain during dev.');
          const next = provisionalFrozen(nextPool);
          provisional.councilModels = next.councilModels;
          provisional.chairmanModel = next.chairmanModel;
          provisional.bModel = next.bModel;
          applyFrozen(provisional, key);
          console.log(`Dev excluded ${catalogueId(config.model)} and left it out of selection.`);
          excluded = true;
          continue;
        }
        if (run.budget.state.paused) {
          console.log(`Dev paused at ${index}/${total}: ${run.budget.state.pauseReason}`);
          return 2;
        }
        const grade = result.ok
          ? gradeResponse(task, result.content || '')
          : gradeResponse(task, '', failureKind(result));
        const slot = run.session.slots().find((item) => (
          item.meta?.questionId === task.id && item.meta?.stage === config.configId
        ));
        rows.push({
          configId: config.configId,
          model: config.model,
          vendor: config.vendor,
          baseId: config.baseId,
          reasoning: config.reasoning,
          correct: grade.correct,
          success: Boolean(result.ok),
          latencyMs: slot?.serviceMs || slot?.occupiedMs || 0,
        });
        run.state.budget = run.budget.snapshot();
        writeJson(run.paths.state, run.state);
      }
    }
    if (run.budget.state.paused) return 2;
    const counts = new Map();
    for (const row of rows) counts.set(row.configId, (counts.get(row.configId) || 0) + 1);
    const completeRows = rows.filter((row) => counts.get(row.configId) === devItems.length);
    if (!completeRows.length) throw new Error('No dev configuration finished every item.');
    const selected = selectFromDev(completeRows);
    const frozen = {
      protocolHash: protocolHash(),
      frozen: true,
      frozenAt: new Date().toISOString(),
      provisional: false,
      devSelected: true,
      label: selected.label,
      councilModels: selected.council.map((row) => row.model),
      chairmanModel: selected.chairman.model,
      bModel: selected.b.model,
      a0AliasesA1: selected.chairman.model === selected.b.model,
      councilSize: selected.council.length,
      tieBreak: ['accuracy', 'completion', 'latency', 'configId'],
      bankCounts: bank.counts,
      mmluQuotas: bank.mmluQuotas,
      totalCap: TOTAL_POST_CAP,
      nominal: nominalCosts(selected.council.length, selected.chairman.model === selected.b.model),
    };
    writeJson(run.paths.manifest, frozen);
    writeJson(path.join(run.paths.dir, 'dev-rows.json'), rows);
    run.state.frozen = true;
    console.log(`Frozen council: ${frozen.councilModels.join(', ')}`);
    console.log(`Chairman ${frozen.chairmanModel}. ${frozen.label}.`);
    return 0;
  } finally {
    run.close();
  }
}

async function testSplit(runId) {
  const key = loadKey();
  const run = openRun(runId, key);
  try {
    const manifest = readJson(run.paths.manifest);
    if (!manifest?.frozen) throw new Error('Freeze the dev manifest before the first test call.');
    if (manifest.protocolHash !== protocolHash()) throw new Error('Manifest protocol hash does not match.');
    await refreshBudget(run.budget);
    for (const model of manifest.councilModels) run.allow.add(catalogueId(model));
    run.allow.add(catalogueId(manifest.chairmanModel));
    run.state.allowModels = [...run.allow];
    const bank = loadBank();
    const items = identify(bank.items.filter((item) => item.split === 'test'));
    const result = await runSplit(run, 'test', items, manifest);
    console.log(`Test ${result.status}.`);
    return exitCodeFor(result);
  } finally {
    run.close();
  }
}

function readQuestions(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)));
}

export function exitCodeFor(result) {
  if (result?.status === 'complete') return 0;
  if (result?.status === 'stopped') return 1;
  return 2;
}

export function costsFromJournal(dir) {
  const file = path.join(dir, 'events.jsonl');
  if (!existsSync(file)) return { attempted: 0, usageKnown: 0, usageUnknown: 0, serviceMs: 0 };
  let attempted = 0;
  let usageKnown = 0;
  let usageUnknown = 0;
  let serviceMs = 0;
  for (const line of readFileSync(file, 'utf8').split(/\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.kind === 'http' && event.phase === 'reserved') attempted += 1;
    if (event.kind === 'http' && (event.phase === 'finished' || event.phase === 'error')) {
      if (event.usageKnown) usageKnown += 1;
      else usageUnknown += 1;
      serviceMs += event.serviceMs || 0;
    }
  }
  return { attempted, usageKnown, usageUnknown, serviceMs };
}

export function updateReadme(file, summary) {
  if (!existsSync(file)) return false;
  const current = readFileSync(file, 'utf8');
  const next = replaceSection(current, README_START, README_END, summary);
  if (next == null) return false;
  if (next !== current) writeFileSync(file, next, 'utf8');
  return true;
}

function report(runId, argv = []) {
  const paths = runPaths(runId);
  const manifest = readJson(paths.manifest, {});
  const questions = readQuestions(paths.questions);
  const testRows = questions.filter((row) => row.split === 'test');
  const alternatives = manifest.a0AliasesA1 ? ['A1', 'A2', 'A3', 'A4'] : ['A0', 'A1', 'A2', 'A3', 'A4'];
  const expected = manifest.bankCounts?.test
    ?? Object.values(TEST_COUNTS).reduce((sum, count) => sum + count, 0);
  const analysis = analyze(testRows, { alternatives, expected });
  const costs = costsFromJournal(paths.dir);
  const complete = analysis.scored === expected && analysis.pending === 0 && analysis.notStarted === 0;
  const context = {
    complete,
    costs,
    expected,
    blockTotals: TEST_COUNTS,
    generatedAt: new Date().toISOString(),
    runId,
    protocolHash: protocolHash(),
    nominal: manifest.nominal || null,
    manifest: manifest.frozen ? {
      label: manifest.label,
      councilModels: manifest.councilModels,
      chairmanModel: manifest.chairmanModel,
      bModel: manifest.bModel,
      a0AliasesA1: manifest.a0AliasesA1,
    } : null,
  };
  const body = {
    protocolHash: protocolHash(),
    generatedAt: context.generatedAt,
    complete,
    expected,
    incident: INCIDENT,
    manifest: context.manifest,
    nominal: manifest.nominal || null,
    costs,
    analysis,
  };
  writeJson(paths.reportJson, body);
  writeFileSync(paths.reportMd, renderReport(analysis, context), 'utf8');
  const summary = renderSummary(analysis, context);
  writeFileSync(paths.summaryMd, summary, 'utf8');
  console.log(`Wrote ${paths.reportMd}`);
  console.log(`Wrote ${paths.summaryMd}`);
  if (!argv.includes('--no-readme')) {
    if (updateReadme(README_PATH, summary)) console.log(`Refreshed the results section in ${README_PATH}`);
    else console.log(`README markers ${README_START} / ${README_END} not found; README left unchanged.`);
  }
  console.log(`${complete ? 'Final' : 'Interim'}: scored ${analysis.scored}/${expected}, pending ${analysis.pending}, not started ${analysis.notStarted}.`);
  return complete ? 0 : 2;
}

export async function main(argv) {
  const command = argv[0] || 'report';
  const runFlag = argv.indexOf('--run');
  const runId = runFlag >= 0 ? argv[runFlag + 1] : 'main';
  if (command === 'prepare') return prepare();
  if (command === 'preflight') return preflight(runId);
  if (command === 'smoke') return smoke(runId);
  if (command === 'dev') return dev(runId);
  if (command === 'test') return testSplit(runId);
  if (command === 'report') return report(runId, argv);
  if (command === 'hash') {
    console.log(protocolHash());
    return 0;
  }
  throw new Error(`Unknown command ${command}`);
}
