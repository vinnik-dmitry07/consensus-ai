// The report of finish-probe-v2, under finish-probe-v2-addendum.md. It reads
// stored journals and sends no model call. Every number, group, and verdict
// in report.json, report.md, and the README block is computed here.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCampaignBudget } from './budget.js';
import {
  CONDITIONS, FINISH_LIMITS, SENSITIVITY_DROP,
  analyse, cellKey, loadSource, orderCells, outcomesOf, renderReport, sourceHashes,
} from './finishProbe.js';
import { evaluateExact, leaveOneOutExact, verdictDifferences } from './finishProbeCriteria.js';
import {
  SOURCE_RUN, V2_FILES, budgetTotals, labelSpend, mergedSlots, origins, stageIndex, v2Paths,
} from './finishProbeV2.js';
import { replaceSection } from './report.js';
import { readSlotJournal } from './runtime.js';
import { sha256 } from './util.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const LABELS_V2 = 'finish-probe-v2-labels.json';
const README = path.join(EVAL_ROOT, 'README.md');
const README_START = '<!-- finish-probe-v2:start -->';
const README_END = '<!-- finish-probe-v2:end -->';
const KEY_URL = 'https://openrouter.ai/api/v1/key';

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

function journalIndex(file) {
  return existsSync(file) ? stageIndex([...readSlotJournal(file).values()]) : new Map();
}

// Addendum A1: the router found no endpoint for the pinned route, so no model
// was reached. Any other failed call did reach the provider.
export function routeUnavailable(slot) {
  const error = slot?.result?.error;
  return slot?.state === 'failed'
    && error?.status === 404
    && String(error.detail || '').startsWith('No endpoints found')
    && !slot.usage;
}

// 'addendum': a cell whose route was unavailable is not measured, and any
// other failed call is no answer. 'written': point 6 of v2 as first written,
// where every failed call is no answer.
export function readOutcomes(cells, raw, slotOf, reading) {
  const out = new Map();
  for (const cell of cells) {
    const row = raw.get(cell.id);
    if (row?.state !== 'failed') out.set(cell.id, row);
    else if (reading === 'addendum' && routeUnavailable(slotOf(cell))) {
      out.set(cell.id, { ...row, state: 'pending', accepted: false, extracted: null, correct: 0, reason: 'route_unavailable' });
    } else {
      out.set(cell.id, { ...row, state: 'done', accepted: false, extracted: null, correct: 0, reason: 'failed' });
    }
  }
  return out;
}

export const FORMS = Object.freeze([
  'accepted', 'cut at the cap', 'answer only in the reasoning', 'not read by the parser', 'call failed', 'not measured', 'not finished',
]);

export function formOf(outcome) {
  if (!outcome) return 'not finished';
  if (outcome.reason === 'route_unavailable') return 'not measured';
  if (outcome.state !== 'done') return 'not finished';
  if (outcome.accepted) return 'accepted';
  if (outcome.reason === 'cut') return 'cut at the cap';
  if (outcome.reason === 'from_reasoning') return 'answer only in the reasoning';
  if (outcome.reason === 'failed') return 'call failed';
  return 'not read by the parser';
}

function countForms(items, outcome, condition) {
  const row = { n: items.length, ...Object.fromEntries(FORMS.map((name) => [name, 0])) };
  for (const item of items) row[formOf(outcome(`${item.id}|${condition}`))] += 1;
  return row;
}

export function formTable(sources, outcome, models) {
  const inputs = sources.filter((item) => item.kind === 'input');
  const rows = [];
  for (const model of models) {
    const list = inputs.filter((item) => item.model === model);
    for (const condition of CONDITIONS) rows.push({ route: model, condition, ...countForms(list, outcome, condition) });
  }
  const syntheses = sources.filter((item) => item.kind === 'synthesis');
  return { rows, syntheses: countForms(syntheses, outcome, 'F') };
}

// Criterion 4 inside each route. Shown only.
export function c4ByRoute(sources, outcome, models) {
  const inputs = sources.filter((item) => item.kind === 'input');
  const correct = (list, condition) => list.filter((item) => outcome(`${item.id}|${condition}`)?.correct === 1).length;
  const measured = (list) => list.filter((item) => ['F', 'C'].every((condition) => outcome(`${item.id}|${condition}`)?.state === 'done')).length;
  return models.map((model) => {
    const list = inputs.filter((item) => item.model === model);
    return { route: model, n: list.length, measured: measured(list), fCorrect: correct(list, 'F'), cCorrect: correct(list, 'C') };
  });
}

export function keyOfAttempt(attemptId) {
  const [questionId, branch, , sample, model] = String(attemptId).split('#')[0].split('|');
  return `${questionId}|${branch}|${sample}|${model}`;
}

// Money the v2 ledger still holds: for calls that reached no model, and for
// calls that may have run.
export function heldSplit(events, limits, unavailableKeys) {
  const budget = createCampaignBudget({ ...limits, prices: {} });
  budget.applyJournal(events);
  const out = { routeUnavailableUsd: 0, routeUnavailableCalls: 0, otherUsd: 0, otherCalls: 0 };
  for (const [attemptId, row] of Object.entries(budget.state.reservations)) {
    if (!row || !(row.open || (row.settled && row.unresolved))) continue;
    if (unavailableKeys.has(keyOfAttempt(attemptId))) {
      out.routeUnavailableUsd += row.usd;
      out.routeUnavailableCalls += 1;
    } else {
      out.otherUsd += row.usd;
      out.otherCalls += 1;
    }
  }
  return out;
}

// Whether the provider the campaign pinned still lists an endpoint.
export function pinnedListed(route, endpoints) {
  const tag = String(route.tag || '').toLowerCase();
  const name = String(route.providerName || '').toLowerCase();
  return endpoints.some((endpoint) => {
    const endpointTag = String(endpoint.tag || '').toLowerCase();
    return endpointTag === tag || endpointTag.startsWith(`${tag}/`) || String(endpoint.provider_name || '').toLowerCase() === name;
  });
}

// Rendering.

const pct = (value) => (value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const usd4 = (value) => `$${Number(value || 0).toFixed(4)}`;
const usd2 = (value) => `$${Number(value || 0).toFixed(2)}`;
const short = (model) => String(model).split('/')[0];

function criteriaLines(c) {
  const lines = [];
  for (const [model, row] of Object.entries(c.c1.models)) lines.push(`- 1, ${model}: ${row.accepted} of ${row.n} accepted, ${row.incomplete} incomplete: ${row.verdict}.`);
  lines.push(`- 2, firm: ${c.c2.correct} of ${c.c2.n} correct, need ${c.c2.need}, question mean ${pct(c.c2.questionMean)}, ${c.c2.incomplete} incomplete: ${c.c2.verdict}.`);
  lines.push(`- 3, firm and candidate: ${c.c3.correct} of ${c.c3.n} correct, need ${c.c3.need}, question mean ${pct(c.c3.questionMean)}, ${c.c3.incomplete} incomplete: ${c.c3.verdict}.`);
  lines.push(`- 4, F over C on all inputs: ${pct(c.c4.fRate)} vs ${pct(c.c4.cRate)}, difference ${pct(c.c4.difference)}, question-mean difference ${pct(c.c4.questionMeanDifference)}, margin ${pct(c.c4.margin)}, ${c.c4.incomplete} incomplete: ${c.c4.verdict}.`);
  lines.push(`- Decision: ${c.decision}.`);
  return lines;
}

export function renderV2Report(result, written, meta, extra) {
  const o = meta.origin;
  const lines = [
    '# Finishing cut answers: finish-probe-v2',
    '',
    `v1 stopped at ${o.v1Done} of ${o.cells} main cells. v2 sent the rest under finish-probe-v2-protocol.md and finish-probe-v2-addendum.md. Cells: ${o.v1Done} from v1, ${extra.v2Done} finished in v2, ${extra.unavailable} not measured because the pinned route was unavailable, ${extra.failedCalls} calls that failed after reaching a provider (no answer), ${extra.open} not finished.`,
    `v1 cells cut by the crash and sent once in v2: ${o.resent.length ? o.resent.map((row) => `${row.cell} (${row.v2})`).join('; ') : 'none'}.`,
    `Labels: pass A ${meta.labelModels.A}, pass B ${meta.labelModels.B}, through OpenRouter; groups ${JSON.stringify(meta.groups)}; the passes differ on ${meta.groupsDiffer}. The 51 labelled texts come from ${extra.labelQuestions} questions, the firm ones from ${extra.firmQuestions}.`,
    extra.routeCheck
      ? `Route check at ${extra.routeCheck.at}: the pinned provider of ${extra.routeCheck.model} ${extra.routeCheck.pinnedListed ? 'is listed again' : 'is not listed'}; listed: ${extra.routeCheck.listed.join(', ') || 'none'}.`
      : 'Route check: not recorded.',
    `Thresholds are compared in whole texts (addendum B.1). The floating comparison of the v1 code ${result.floatingDifferences?.length ? `differs: ${result.floatingDifferences.map((row) => `${row.criterion} ${row.floating} instead of ${row.exact}`).join('; ')}` : 'gives the same verdicts and decision'}.`,
    extra.v3PlanDraft
      ? `Before this report was first built (${extra.v3PlanDraft.recordedAt}), the fork's draft plan for finish-probe-v3 was recorded: sha256 ${extra.v3PlanDraft.sha256}, ${extra.v3PlanDraft.bytes} bytes, modified ${extra.v3PlanDraft.mtime}.`
      : null,
    '',
  ].filter((line) => line != null);
  lines.push(renderReport(result, meta).split('\n').slice(2).join('\n'));
  lines.push('', '## Form of the calls on the cut inputs', '', `| Route | Condition | n | ${FORMS.join(' | ')} |`, `| --- | --- | --- | ${FORMS.map(() => '---').join(' | ')} |`);
  for (const row of extra.forms.rows) lines.push(`| ${row.route} | ${row.condition} | ${row.n} | ${FORMS.map((name) => row[name]).join(' | ')} |`);
  const s = extra.forms.syntheses;
  lines.push('', `Cut syntheses, condition F: n ${s.n}; ${FORMS.map((name) => `${name} ${s[name]}`).join(', ')}.`);
  lines.push('', '## Criterion 4 inside each route (shown only)', '', '| Route | n | F and C both measured | F correct | C correct |', '| --- | --- | --- | --- | --- |');
  for (const row of extra.c4Routes) lines.push(`| ${row.route} | ${row.n} | ${row.measured} | ${row.fCorrect} | ${row.cCorrect} |`);
  lines.push('', '## Point 6 of v2 as first written', '', 'With every failed call counted as no answer, including the calls whose route was unavailable:', '', ...criteriaLines(written.criteria));
  lines.push('', '## Money', '');
  lines.push(`- v1: ${usd4(meta.v1.settledUsd)} settled, ${usd4(meta.v1.heldUsd)} held, ${meta.v1.posts} POSTs.`);
  lines.push(`- v2: ${usd4(meta.v2.settledUsd)} settled, ${meta.v2.posts} POSTs. Held ${usd4(extra.held.otherUsd)} for ${extra.held.otherCalls} calls that may have run, and ${usd4(extra.held.routeUnavailableUsd)} for ${extra.held.routeUnavailableCalls} calls that reached no model.`);
  lines.push(`- Labelling, outside the experiment limit: ${usd4(meta.labels.knownUsd)} in ${meta.labels.calls} calls, ${meta.labels.unknown} without a cost.`);
  lines.push(`- Key usage: ${extra.key.first == null ? 'n/a' : `$${extra.key.first.toFixed(4)}`} at the first v1 audit, ${extra.key.last == null ? 'n/a' : `$${extra.key.last.toFixed(4)}`} at the last audit (${extra.key.lastAt || 'n/a'}); moved by ${meta.keyDelta == null ? 'n/a' : usd4(meta.keyDelta)}. The ledgers settle ${usd4(extra.key.settledAll)} in that span and hold ${usd4(extra.key.heldReal)} for calls that may have run.`);
  return lines.join('\n');
}

const VERDICT_RU = { pass: 'выполнен', fail: 'не выполнен', undetermined: 'не определён' };
const DECISION_RU = {
  'no change: at least one of criteria 1-3 failed': 'не выполнен хотя бы один из критериев 1–3, поэтому результат записан, а код кампаний не меняется',
  'undetermined: the set is incomplete': 'не определено, набор неполный',
  'the contribution of the reasoning is not shown; plain re-asking would be a separate decision': 'вклад рассуждения не показан; переспрашивание без текста — отдельное решение',
  'recommend a confirming measurement with the fill policy': 'рекомендуется подтверждающее измерение с основной политикой',
};

export function renderReadme(result, written, meta, extra) {
  const c = result.criteria;
  const o = meta.origin;
  const lines = [
    '### Диагностика: дописывание оборванных ответов (`finish-probe-v2`)',
    '',
    `Продолжение остановленного \`finish-probe-v1\`. Правила — в [finish-probe-v2-protocol.md](finish-probe-v2-protocol.md) и [finish-probe-v2-addendum.md](finish-probe-v2-addendum.md). Готовые ячейки v1 взяты как есть (${o.v1Done} из ${o.cells}), остальные отправлены в v2 теми же запросами. Разметку 51 текста сделали модели OpenRouter: проход A — ${meta.labelModels.A}, проход B — ${meta.labelModels.B}; метки v1 не используются. Все числа, группы и решение посчитаны кодом. Основные таблицы v5e этот опыт не меняет.`,
    '',
    `**Решение по заранее заданному правилу:** ${DECISION_RU[c.decision] || c.decision}.`,
    '',
    '| Критерий (условие F) | Значение | Порог | Итог |',
    '| --- | --- | --- | --- |',
  ];
  for (const [model, row] of Object.entries(c.c1.models)) {
    lines.push(`| 1. Принятые ответы, ${short(model)} | ${row.accepted} из ${row.n}${row.incomplete ? `, не измерено ${row.incomplete}` : ''} | 90% | ${VERDICT_RU[row.verdict]} |`);
  }
  const open = (row) => (row.incomplete ? `, не измерено ${row.incomplete}` : '');
  lines.push(`| 2. Твёрдые | ${c.c2.correct} из ${c.c2.n}${open(c.c2)}, по вопросам ${pct(c.c2.questionMean)} | ${c.c2.need} и 80% | ${VERDICT_RU[c.c2.verdict]} |`);
  lines.push(`| 3. Твёрдые и кандидаты | ${c.c3.correct} из ${c.c3.n}${open(c.c3)}, по вопросам ${pct(c.c3.questionMean)} | ${c.c3.need} и 50% | ${VERDICT_RU[c.c3.verdict]} |`);
  lines.push(`| 4. F выше C на всех входах | ${pct(c.c4.fRate)} против ${pct(c.c4.cRate)}${open(c.c4)}, по вопросам ${pct(c.c4.questionMeanDifference)} | +${pct(c.c4.margin)} | ${VERDICT_RU[c.c4.verdict]} |`);
  lines.push('', '| Условие | n | верно | неверно | нет ответа | не измерено |', '| --- | --- | --- | --- | --- | --- |');
  for (const condition of CONDITIONS) {
    const row = result.conditions[condition].all;
    lines.push(`| ${condition} | ${row.n} | ${row.correct} | ${row.wrong} | ${row.empty} | ${row.incomplete} |`);
  }
  lines.push('', 'Чем закончились вызовы F по маршрутам:', '', '| Маршрут | n | принят | оборван на лимите 2048 | другой отказ | не измерено |', '| --- | --- | --- | --- | --- | --- |');
  for (const row of extra.forms.rows.filter((item) => item.condition === 'F')) {
    const other = row['answer only in the reasoning'] + row['not read by the parser'] + row['call failed'];
    lines.push(`| ${short(row.route)} | ${row.n} | ${row.accepted} | ${row['cut at the cap']} | ${other} | ${row['not measured'] + row['not finished']} |`);
  }
  // The route whose reasoning is mandatory: its calls can spend the cap on it.
  const forced = Object.entries(meta.reasoning || {}).filter(([, value]) => value?.effort && value.effort !== 'none').map(([model]) => model);
  const formRow = (model, condition) => extra.forms.rows.find((item) => item.route === model && item.condition === condition);
  const capNotes = forced.flatMap((model) => {
    const f = formRow(model, 'F');
    const control = formRow(model, 'C');
    if (!f || !control) return [];
    const refused = f.n - f.accepted - f['not measured'] - f['not finished'];
    // Counts only; what they mean is left to the analysis written by OpenRouter models.
    return [
      `Маршрут ${short(model)} обязан рассуждать (наименьшее усилие ${meta.reasoning[model].effort}). Из ${f.n} вызовов F не принято ${refused}, из них ${f['cut at the cap']} оборваны на лимите ${meta.caps?.[model]}.`,
      `Контроль C у ${short(model)} оборван на том же лимите в ${control['cut at the cap']} случаях из ${control.n}.`,
    ];
  });
  const notes = [
    extra.unavailable
      ? `Закреплённый маршрут hy4 исчез из списка OpenRouter во время v2: ${extra.unavailable} ячеек получили 404 до генерации и не измерены${extra.routeCheck ? `; при проверке ${extra.routeCheck.at.slice(0, 16).replace('T', ' ')} UTC маршрут ${extra.routeCheck.pinnedListed ? 'снова был в списке' : 'в списке не появился'}` : ''}. Другой провайдер не подставлялся.`
      : null,
    ...capNotes,
    `51 размеченный текст взят из ${extra.labelQuestions} вопросов, твёрдые — из ${extra.firmQuestions}.`,
    'Test просмотрен, эталоны и грейдер менялись после прогона, правила v2 и дополнение написаны после промежуточных чисел v1. По одной генерации на условие.',
  ].filter(Boolean);
  lines.push('', 'Ограничения:', '', ...notes.map((note) => `- ${note}`));
  lines.push('', 'Этот блок собран кодом из чисел отчёта. Толкование результата — в разделе «Анализ» ниже: его написала одна модель OpenRouter, а числа в нём сверила с отчётом другая. Пояснения в тексте дополнения 7624a5e писала сессия Claude во время аудита, до сборки отчёта.');
  const s = result.sensitivity;
  lines.push('', `Без HMMT 17 и q752d: критерий 2 — ${s.c2.correct} из ${s.c2.n}, ${VERDICT_RU[s.c2.verdict]}; критерий 3 — ${s.c3.correct} из ${s.c3.n}, ${VERDICT_RU[s.c3.verdict]}; критерий 4 — ${VERDICT_RU[s.c4.verdict]}. Если считать ячейки с 404 как «нет ответа» (первая редакция правил v2), решение: ${DECISION_RU[written.criteria.decision] || written.criteria.decision}.`);
  lines.push('', `Расход опыта (v1 и v2): подтверждено ${usd2(meta.budget.settledUsd)}, удержано ${usd2(meta.v1.heldUsd + extra.held.otherUsd)} за вызовы без итога, ${meta.budget.posts} POST из 500. Ещё ${usd2(extra.held.routeUnavailableUsd)} числится в резерве за вызовы с 404, которые до модели не дошли. Разметка — ${usd2(meta.labels.knownUsd)} сверх лимита опыта. Счётчик ключа за всё время вырос на ${meta.keyDelta == null ? 'n/a' : usd2(meta.keyDelta)}.`);
  lines.push('', `Пороги сравниваются в целых текстах (дополнение, B.1). Сравнение долей, как в коде v1, ${result.floatingDifferences?.length ? `даёт другое: ${result.floatingDifferences.map((row) => `${row.criterion} — ${VERDICT_RU[row.floating] || row.floating}`).join('; ')}` : 'даёт те же итоги и то же решение'}.`);
  lines.push('', 'Полный разбор — `.runs/finish-probe-v2/report.md`. Воспроизвести без сети (фаза `report` в `run.js` написана до дополнения и для этого не годится):', '', '```bash', 'node frontend/eval/finishProbeCli.js finish-probe-v2 --phase report', '```');
  return lines.join('\n');
}

// Assembling.

export function buildReport(paths, source, { retryIndex = new Map() } = {}) {
  const manifest = readJson(paths.manifest);
  if (!manifest?.frozen) throw new Error('No v2 manifest yet.');
  const hashes = sourceHashes(source.paths);
  const changed = Object.keys(hashes).filter((name) => hashes[name] !== manifest.frozen.sourceHashes[name]);
  if (changed.length) throw new Error(`Source files changed since the freeze: ${changed.join(', ')}`);
  const v1Files = { main: paths.v1.main, budget: paths.v1.budget, settings: paths.v1.settings, manifest: paths.v1.manifest };
  const moved = Object.keys(v1Files).filter((name) => fileSha(v1Files[name]) !== manifest.frozen.v1Hashes[name]);
  if (moved.length) throw new Error(`v1 files changed since the v2 freeze: ${moved.join(', ')}`);
  const labelsPath = path.join(EVAL_ROOT, LABELS_V2);
  if (fileSha(labelsPath) !== manifest.labels.sha) throw new Error('The v2 labels changed since the freeze.');
  // The frozen v1 and v2 code, protocols, and labels are the ones v2 ran with.
  const codeHash = sha256(V2_FILES.map((name) => `${name}\n${fileSha(path.join(EVAL_ROOT, name))}`).join('\n'));
  if (codeHash !== manifest.frozen.codeHash) throw new Error('The frozen v2 files changed since the v2 freeze.');
  const labelsFile = readJson(labelsPath);
  const labels = new Map(labelsFile.items.map((item) => [item.cell, item.group]));
  const agreed = new Map(labelsFile.items.filter((item) => item.agreedAccepted != null).map((item) => [item.cell, item.agreedAccepted]));

  const cells = orderCells(source.sources);
  const v1Index = journalIndex(paths.v1.main);
  const v2Index = journalIndex(path.join(paths.main, 'events.jsonl'));
  // A cell repeated under addendum A2 is read from the repeat.
  const used = new Map(v2Index);
  for (const [key, slot] of retryIndex) if (routeUnavailable(v2Index.get(key))) used.set(key, slot);
  const slots = mergedSlots(cells, v1Index, used);
  const slotByKey = stageIndex(slots);
  const slotOf = (cell) => slotByKey.get(cellKey(cell));
  const raw = outcomesOf(cells, source.tasks, slots);
  const inputs = source.sources.filter((item) => item.kind === 'input');
  const kept = inputs.filter((item) => !SENSITIVITY_DROP.includes(item.questionId));
  const analysed = (reading) => {
    const outcomes = readOutcomes(cells, raw, slotOf, reading);
    const base = analyse({
      rows: source.rows, ctx: source.ctx, sources: source.sources, outcomes, labels, agreed,
      models: source.councilModels, primaryBlocks: source.campaign.primaryBlocks,
    });
    // Addendum B.1: verdicts in whole texts. The floating ones stay beside them.
    const args = { inputs, outcome: (id) => outcomes.get(id), labels, models: source.councilModels };
    const criteria = evaluateExact(args);
    return {
      outcomes,
      result: {
        ...base,
        criteria,
        sensitivity: evaluateExact({ ...args, inputs: kept }),
        leaveOneOut: leaveOneOutExact(args),
        floating: { criteria: base.criteria, sensitivity: base.sensitivity, leaveOneOut: base.leaveOneOut },
        floatingDifferences: verdictDifferences(criteria, base.criteria),
      },
    };
  };
  const main = analysed('addendum');
  const written = analysed('written');
  const outcome = (id) => main.outcomes.get(id);

  const unavailableCells = cells.filter((cell) => routeUnavailable(slotOf(cell)));
  const unavailableKeys = new Set(unavailableCells.map((cell) => cellKey(cell)));
  const v1Events = readJsonl(paths.v1.budget);
  const v2Events = readJsonl(paths.budget);
  const labelEvents = readJsonl(path.join(paths.labels, 'calls.jsonl'));
  const v1 = budgetTotals(v1Events);
  const v2 = budgetTotals(v2Events, manifest.limits);
  const held = heldSplit(v2Events, manifest.limits, unavailableKeys);
  const audits = [...v1Events, ...labelEvents, ...v2Events].filter((event) => event.kind === 'audit' && Number.isFinite(event.usage));
  const first = audits[0] || null;
  const last = audits[audits.length - 1] || null;
  const labelsSpend = labelSpend(labelEvents);
  const groups = {};
  for (const item of labelsFile.items) groups[item.group] = (groups[item.group] || 0) + 1;
  const questionOf = (cell) => cell.split('|')[0];
  const states = { done: 0, open: 0, failed: 0 };
  for (const cell of cells) {
    const row = main.outcomes.get(cell.id);
    if (row?.reason === 'route_unavailable') continue;
    if (row?.reason === 'failed') states.failed += 1;
    else if (row?.state === 'done') states.done += 1;
    else states.open += 1;
  }
  const origin = origins(cells, v1Index, used);
  const meta = {
    sourceRun: SOURCE_RUN,
    budget: { settledUsd: v1.settledUsd + v2.settledUsd, unresolvedUsd: v1.heldUsd + v2.heldUsd, posts: v1.posts + v2.posts },
    v1,
    v2,
    keyDelta: first && last && last !== first ? last.usage - first.usage : null,
    caps: manifest.caps,
    reasoning: manifest.reasoning,
    origin,
    labels: labelsSpend,
    labelModels: labelsFile.labelModels,
    groups,
    groupsDiffer: labelsFile.items.filter((item) => item.groupA !== item.groupB).length,
    freeze: { gitHead: manifest.frozen.gitHead, frozenAt: manifest.frozen.frozenAt },
  };
  const extra = {
    v2Done: states.done - origin.v1Done,
    unavailable: unavailableCells.length,
    failedCalls: states.failed,
    open: states.open,
    forms: formTable(source.sources, outcome, source.councilModels),
    c4Routes: c4ByRoute(source.sources, outcome, source.councilModels),
    held,
    labelQuestions: new Set(labelsFile.items.map((item) => questionOf(item.cell))).size,
    firmQuestions: new Set(labelsFile.items.filter((item) => item.group === 'firm').map((item) => questionOf(item.cell))).size,
    routeCheck: readJson(path.join(paths.dir, 'route-check.json')),
    v3PlanDraft: readJson(path.join(paths.dir, 'v3-plan-draft.json')),
    key: {
      first: first?.usage ?? null,
      last: last?.usage ?? null,
      lastAt: last?.at ?? null,
      settledAll: v1.settledUsd + v2.settledUsd + labelsSpend.knownUsd,
      heldReal: v1.heldUsd + held.otherUsd,
    },
    sensitivityDrop: SENSITIVITY_DROP,
  };
  return { meta, extra, result: main.result, written: written.result };
}

function writeReadme(block) {
  const text = readFileSync(README, 'utf8');
  const body = `\n${block}\n`;
  const replaced = replaceSection(text, README_START, README_END, body);
  const next = replaced ?? `${text.replace(/\s*$/, '')}\n\n${README_START}\n${body}\n${README_END}\n`;
  if (next !== text) writeFileSync(README, next, 'utf8');
}

function runReport(paths, source, argv) {
  const retryFile = path.join(paths.dir, 'retry', 'events.jsonl');
  const built = buildReport(paths, source, { retryIndex: journalIndex(retryFile) });
  writeJson(paths.report, built);
  writeFileSync(paths.reportMd, `${renderV2Report(built.result, built.written, built.meta, built.extra)}\n`, 'utf8');
  const block = renderReadme(built.result, built.written, built.meta, built.extra);
  writeFileSync(paths.readme, `${block}\n`, 'utf8');
  if (argv.includes('--readme')) writeReadme(block);
  console.log(`report written: ${paths.reportMd}`);
  console.log(`decision: ${built.result.criteria.decision}`);
  console.log(`decision with point 6 as first written: ${built.written.criteria.decision}`);
  return 0;
}

// Addendum A2: one look at the endpoint list when the main pass has ended.
async function runRouteCheck(paths, source) {
  const file = path.join(paths.dir, 'route-check.json');
  if (existsSync(file)) {
    console.log(`route check already recorded: ${readFileSync(file, 'utf8')}`);
    return 0;
  }
  const cells = orderCells(source.sources);
  const v2Index = journalIndex(path.join(paths.main, 'events.jsonl'));
  const models = [...new Set(cells.filter((cell) => routeUnavailable(v2Index.get(cellKey(cell)))).map((cell) => cell.model))];
  if (models.length !== 1) throw new Error(`Expected one model with an unavailable route, found ${models.length}.`);
  const [model] = models;
  const route = source.selection.routes.find((item) => item.id === model);
  const response = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`);
  const body = await response.json();
  const endpoints = body?.data?.endpoints || [];
  const record = {
    at: new Date().toISOString(),
    model,
    pinned: { tag: route.tag, providerName: route.providerName },
    status: response.status,
    listed: endpoints.map((endpoint) => endpoint.tag || endpoint.provider_name),
    pinnedListed: response.status === 200 && pinnedListed(route, endpoints),
  };
  writeJson(file, record);
  console.log(JSON.stringify(record, null, 2));
  return 0;
}

// One more reading of the key's usage, for the last line of the ledger.
async function runKeyAudit(paths) {
  const key = String(process.env.or_key || process.env.OR_KEY || '').trim();
  if (!key) throw new Error('or_key is missing');
  const response = await fetch(KEY_URL, { headers: { Authorization: `Bearer ${key}` } });
  const body = await response.json().catch(() => null);
  const event = { kind: 'audit', at: new Date().toISOString(), phase: 'v2-after', moment: 'after', status: response.status, usage: body?.data?.usage ?? null, limitRemaining: body?.data?.limit_remaining ?? null };
  appendFileSync(paths.budget, `${JSON.stringify(event)}\n`, 'utf8');
  console.log(`key usage ${event.usage} at ${event.at}`);
  return 0;
}

export async function runV2ReportPhase(phase, argv) {
  const paths = v2Paths();
  if (phase === 'key-audit') return runKeyAudit(paths);
  const source = loadSource(SOURCE_RUN);
  if (phase === 'route-check') return runRouteCheck(paths, source);
  return runReport(paths, source, argv);
}

export { FINISH_LIMITS };
