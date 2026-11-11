// README block, numbers only, for an a8 campaign whose test was stopped before
// any question finished. It reads the stored files of the campaign; it sends
// nothing and reads no answer text.
//
//   node frontend/eval/a8RunNote.js --run a8-open-v6 [--readme]

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCampaignBudget } from './budget.js';
import { readSlotJournal } from './runtime.js';
import { replaceSection } from './report.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(EVAL_ROOT, '.runs');
const README = path.join(EVAL_ROOT, 'README.md');
export const AFTER = '<!-- finish-probe-summary-analysis:end -->';

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
const readJsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const usd2 = (value) => `$${Number(value || 0).toFixed(2)}`;
const short = (model) => String(model).split('/')[0];

export function markers(run) {
  return { start: `<!-- ${run}:start -->`, end: `<!-- ${run}:end -->` };
}

// Counts of the test journal by slot state; no field of a result is read.
export function testCounts(slots, chairman) {
  const counts = { slots: slots.length, posts: 0, refusals: 0, failed: 0, chairmanDone: 0, byModel: {} };
  for (const slot of slots) {
    counts.posts += slot.httpAttempts || 0;
    counts.refusals += slot.limitedAttempts || 0;
    if (slot.state === 'failed') counts.failed += 1;
    if (slot.meta.model === chairman && slot.state === 'completed') counts.chairmanDone += 1;
    const row = counts.byModel[slot.meta.model] ||= { completed: 0, other: 0 };
    if (slot.state === 'completed') row.completed += 1;
    else row.other += 1;
  }
  return counts;
}

export function buildNote(run, root = RUNS_ROOT) {
  const dir = path.join(root, run);
  const campaign = readJson(path.join(dir, 'campaign.json'));
  const selection = readJson(path.join(dir, 'selection.json'));
  const gate = readJson(path.join(dir, 'gate.json'));
  const stop = readJson(path.join(dir, 'stop.json'));
  const repin = readJson(path.join(root, campaign.routesInheritedFrom, 'repin.json'));
  const testDir = path.join(dir, 'comparison', 'test');
  const slots = existsSync(path.join(testDir, 'events.jsonl')) ? [...readSlotJournal(path.join(testDir, 'events.jsonl')).values()] : [];
  // A question file holds the status of the question; only that field is read.
  const questions = existsSync(testDir)
    ? readdirSync(testDir).filter((name) => name.startsWith('test_') && name.endsWith('.json')).filter((name) => readJson(path.join(testDir, name))?.status === 'complete').length
    : 0;
  const budget = createCampaignBudget({ maxUsd: campaign.maxUsd, maxPosts: campaign.maxPosts, prices: {} });
  const events = readJsonl(path.join(dir, 'budget.jsonl'));
  budget.applyJournal(events);
  let testUsd = 0;
  for (const [id, row] of Object.entries(budget.state.reservations)) if (id.startsWith('test:') && row.settled && !row.unresolved) testUsd += row.cost || 0;
  const primary = (campaign.primaryBlocks || []).reduce((sum, block) => sum + (campaign.counts?.blocks?.[block]?.test || 0), 0);
  const perQuestion = 12;
  const chairmanCalls = 8;
  return {
    run,
    blocks: campaign.primaryBlocks,
    primary,
    cap: campaign.stageCaps?.stage1,
    routesFrom: campaign.routesInheritedFrom,
    repin: repin ? { model: repin.model, to: repin.chosen?.tag ?? null } : null,
    selection: { b: selection.b, h: selection.h, council: selection.council, table: (selection.table || []).map((row) => ({ id: row.id, correct: row.correct, expected: row.expected })) },
    gate: gate ? { verdict: gate.verdict, at: gate.at, stressUsd: gate.conditions?.money?.stressUsd, baseUsd: gate.conditions?.key?.baseUsd } : null,
    test: testCounts(slots, selection.h),
    plannedChairmanCalls: primary * chairmanCalls,
    plannedCalls: primary * perQuestion,
    questionsComplete: questions ?? 0,
    money: { settledUsd: budget.state.settledUsd, heldUsd: budget.state.unresolvedUsd, posts: budget.state.posts, testUsd },
    stop: stop ? { at: stop.at, endpoints: (stop.stepfunEndpoints || []).map((row) => ({ tag: row.tag, status: row.status, uptimeLast30m: row.uptime_last_30m, uptimeLast1d: row.uptime_last_1d })) } : null,
  };
}

export function renderNote(note) {
  const lines = [
    `### Остановленная кампания \`${note.run}\` (ArXivMath)`,
    '',
    `Тест остановлен до того, как закончился хотя бы один вопрос, поэтому сравнения рук нет. Числа ниже посчитаны кодом из файлов кампании; текст ответов не читался.`,
    '',
    `- Маршруты: снимок \`${note.routesFrom}\`${note.repin ? `, ${short(note.repin.model)} перенесён на \`${note.repin.to}\`` : ''}; лимит ${note.cap} на всех стадиях; основных вопросов ${note.primary}.`,
    `- Состав по dev: B = H = ${note.selection.b}; совет ${note.selection.council.join(', ')}. Dev: ${note.selection.table.map((row) => `${short(row.id)} ${row.correct}/${row.expected}`).join(', ')}.`,
  ];
  if (note.gate) lines.push(`- Шлюз: \`${note.gate.verdict}\` (${note.gate.at}); прогноз основной части ${usd2(note.gate.baseUsd)}, стресс ${usd2(note.gate.stressUsd)}.`);
  const sf = note.test.byModel[note.selection.h] || { completed: 0 };
  lines.push(`- Тест: закончено вопросов ${note.questionsComplete} из ${note.primary}; вызовов ${short(note.selection.h)} готово ${sf.completed} из ${note.plannedChairmanCalls}; отказов по ёмкости ${note.test.refusals}; окончательно упавших слотов ${note.test.failed}.`);
  if (note.stop) lines.push(`- Причина остановки (${note.stop.at}): хосты ${short(note.selection.h)} — ${note.stop.endpoints.map((row) => `\`${row.tag}\` статус ${row.status}, доступность за 30 мин ${row.uptimeLast30m ?? 'n/a'}%, за сутки ${row.uptimeLast1d == null ? 'n/a' : Number(row.uptimeLast1d).toFixed(1)}%`).join('; ')}.`);
  lines.push(`- Расход кампании: подтверждено ${usd2(note.money.settledUsd)} (из них тест ${usd2(note.money.testUsd)}), удержано ${usd2(note.money.heldUsd)}, ${note.money.posts} POST.`);
  return lines.join('\n');
}

export function placeAfter(readme, start, end, body, after) {
  const replaced = replaceSection(readme, start, end, `\n${body}\n`);
  if (replaced != null) return replaced;
  const at = readme.indexOf(after);
  if (at < 0) throw new Error(`${after} is not in the README`);
  const cut = at + after.length;
  return `${readme.slice(0, cut)}\n\n${start}\n\n${body}\n\n${end}${readme.slice(cut)}`;
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : (argv[index + 1] ?? null);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const run = flagValue(argv, '--run');
  if (!run) throw new Error('--run is required');
  const note = buildNote(run);
  const body = renderNote(note);
  writeFileSync(path.join(RUNS_ROOT, run, 'readme-note.md'), `${body}\n`, 'utf8');
  if (argv.includes('--readme')) {
    const { start, end } = markers(run);
    const text = readFileSync(README, 'utf8');
    const next = placeAfter(text, start, end, body, flagValue(argv, '--after') || AFTER);
    if (next !== text) writeFileSync(README, next, 'utf8');
  }
  console.log(body);
}
