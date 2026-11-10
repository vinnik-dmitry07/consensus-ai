// The gate of a8-open-v6 before its test, under a8-open-v6-protocol.md. It
// reads dev, the pilot, the pilot forecast, and the key (one free GET), and
// writes gate.json. No POST. The test starts only when every condition holds
// and the user has read the report of this stop.
//
//   node frontend/eval/a8Gate.js --run a8-open-v6 [--block arxiv] [--compare a8-open-v5d]

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEGACY_BLOCKS } from './a8Blocks.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(EVAL_ROOT, '.runs');
const KEY_URL = 'https://openrouter.ai/api/v1/key';
const SKIP = new Set(['order.json', 'runner.json', 'cooldowns.json', 'forecast.json', 'source.json', 'results.json']);
// At least 2 of the 12 Stage 1 answers of the council on the dev questions of
// the block are read as an answer, or A8 or S8 reads on one pilot question.
export const MIN_DEV_PARSED = 2;
export const MIN_PILOT_PARSED = 1;

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function questionRows(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !SKIP.has(name))
    .map((name) => readJson(path.join(dir, name)))
    .filter((row) => row?.id)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

const graded = (status) => status === 'graded';

export function gateVerdict({ selection, devRows, pilotRows, forecast, key, block = 'arxiv' }) {
  const council = selection?.council || [];
  const dev = devRows.filter((row) => row.block === block && row.status === 'complete');
  const devAnswers = dev.flatMap((row) => (row.answers || []).filter((answer) => council.includes(answer.id)));
  const devParsed = devAnswers.filter((answer) => graded(answer.status)).length;
  const pilot = pilotRows.filter((row) => row.block === block && row.status === 'complete');
  const pilotParsed = pilot.filter((row) => graded(row.arms?.A8?.status) || graded(row.arms?.S8?.status)).length;
  const base = forecast?.primary?.baseUsd ?? null;
  const stress = forecast?.primary?.stressUsd ?? null;
  const left = key?.limitRemaining;
  const conditions = {
    money: { holds: forecast?.gate === 'pass', forecastGate: forecast?.gate ?? null, stressUsd: stress, remainingUsd: forecast?.remainingUsd ?? null },
    measurable: {
      holds: devParsed >= MIN_DEV_PARSED || pilotParsed >= MIN_PILOT_PARSED,
      devQuestions: dev.length, devAnswers: devAnswers.length, devParsed, pilotQuestions: pilot.length, pilotParsed,
    },
    key: {
      holds: base != null && key?.status === 200 && (left == null || left >= base),
      limitRemaining: left ?? null, baseUsd: base,
      addForBaseUsd: base != null && left != null ? Math.max(0, base - left) : null,
      addForStressUsd: stress != null && left != null ? Math.max(0, stress - left) : null,
    },
  };
  const failed = Object.entries(conditions).filter(([, row]) => !row.holds).map(([name]) => name);
  return { verdict: failed.length ? 'stop' : 'pass', failed, conditions };
}

// Descriptive: each model's correct answers on the legacy dev questions both
// runs share.
export function legacyDevComparison(rows, previous) {
  const before = new Map(previous.filter((row) => LEGACY_BLOCKS.includes(row.block)).map((row) => [row.id, row]));
  const shared = rows.filter((row) => LEGACY_BLOCKS.includes(row.block) && before.has(row.id) && row.status === 'complete' && before.get(row.id).status === 'complete');
  const models = [...new Set(shared.flatMap((row) => (row.answers || []).map((answer) => answer.id)))].sort();
  return {
    questions: shared.length,
    models: models.map((id) => {
      const count = (list) => list.filter((row) => (row.answers || []).find((answer) => answer.id === id)?.correct === 1).length;
      return { id, now: count(shared), before: count(shared.map((row) => before.get(row.id))) };
    }),
  };
}

export function blockDetail(devRows, pilotRows, block = 'arxiv') {
  const dev = devRows.filter((row) => row.block === block);
  const models = [...new Set(dev.flatMap((row) => (row.answers || []).map((answer) => answer.id)))].sort();
  const pilot = pilotRows.filter((row) => row.block === block);
  return {
    dev: models.map((id) => {
      const answers = dev.map((row) => (row.answers || []).find((answer) => answer.id === id)).filter(Boolean);
      return { id, n: answers.length, parsed: answers.filter((answer) => graded(answer.status)).length, correct: answers.filter((answer) => answer.correct === 1).length, usd: answers.reduce((sum, answer) => sum + (Number(answer.cost) || 0), 0) };
    }),
    pilot: pilot.map((row) => ({
      id: row.id,
      status: row.status,
      arms: Object.fromEntries(Object.entries(row.arms || {}).map(([arm, value]) => [arm, { status: value?.status ?? null, correct: value?.correct ?? null }])),
    })),
  };
}

async function keyInfo(fetchImpl = fetch) {
  const key = String(process.env.or_key || process.env.OR_KEY || '').trim();
  if (!key) return { status: null, error: 'or_key is missing' };
  try {
    const response = await fetchImpl(KEY_URL, { headers: { Authorization: `Bearer ${key}` } });
    const body = await response.json().catch(() => null);
    const data = body?.data || {};
    return { status: response.status, at: new Date().toISOString(), usage: data.usage ?? null, limit: data.limit ?? null, limitRemaining: data.limit_remaining ?? null };
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function fileSha(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent';
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : (argv[index + 1] ?? null);
}

export async function runGate(argv, { root = RUNS_ROOT, fetchImpl = fetch } = {}) {
  const run = flagValue(argv, '--run');
  if (!run) throw new Error('--run is required');
  const block = flagValue(argv, '--block') || 'arxiv';
  const compare = flagValue(argv, '--compare') || 'a8-open-v5d';
  const dir = path.join(root, run);
  const selection = readJson(path.join(dir, 'selection.json'));
  const forecast = readJson(path.join(dir, 'comparison', 'pilot', 'forecast.json'));
  if (!selection || !forecast) throw new Error('Run dev and the pilot first.');
  const devRows = questionRows(path.join(dir, 'dev'));
  const pilotRows = questionRows(path.join(dir, 'comparison', 'pilot'));
  const key = await keyInfo(fetchImpl);
  const verdict = gateVerdict({ selection, devRows, pilotRows, forecast, key, block });
  const goldFile = path.join(EVAL_ROOT, `gold-corrections-${run}.json`);
  const record = {
    at: new Date().toISOString(),
    run,
    block,
    ...verdict,
    selection: { b: selection.b, h: selection.h, council: selection.council, table: (selection.table || []).map((row) => ({ id: row.id, correct: row.correct, expected: row.expected, successes: row.successes, costUsd: row.costUsd })) },
    forecast: { primary: forecast.primary, full: forecast.full, remainingUsd: forecast.remainingUsd, remainingPosts: forecast.remainingPosts, extended: forecast.extended ?? null },
    key,
    detail: blockDetail(devRows, pilotRows, block),
    legacyDev: { compare, ...legacyDevComparison(devRows, questionRows(path.join(root, compare, 'dev'))) },
    loops: Object.fromEntries(['smoke', 'pilot'].map((of) => [of, readJson(path.join(dir, 'reports', `loops-${of}.json`))?.stops?.length ?? null])),
    goldCorrections: { file: path.basename(goldFile), sha256: fileSha(goldFile) },
  };
  writeFileSync(path.join(dir, 'gate.json'), JSON.stringify(record, null, 2), 'utf8');
  console.log(`gate ${record.verdict}${record.failed.length ? `: ${record.failed.join(', ')}` : ''}`);
  console.log(JSON.stringify(record.conditions, null, 2));
  return record.verdict === 'pass' ? 0 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runGate(process.argv.slice(2));
}
