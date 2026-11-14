// README text of redteam-probe-v1, kept outside the frozen probe files. It
// renders the block from report.json (and the summary of
// tools/redteam_main_audit.js), places it after the question-difficulty block,
// and runs the analysis, which OpenRouter models write and check. Every number
// comes from those files; nothing here reads a result.
//
//   node frontend/eval/redTeamProbeReadme.js            (print the block)
//   node frontend/eval/redTeamProbeReadme.js --readme   (place it in README.md)
//   node frontend/eval/redTeamProbeReadme.js --analysis --live

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANALYSIS_LIMITS, attributedSection, placeAfter, placeAnalysis, readJson, readJsonl, rewriteFile, ruleFiles, sectionMarkers,
} from './noteTools.js';
import { readSlotJournal } from './runtime.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUN = 'redteam-probe-v1';
const RUN_DIR = path.join(EVAL_ROOT, '.runs', RUN);
const AUDIT = path.join(EVAL_ROOT, '.runs', 'redteam-main-audit', 'audit.json');
const README = path.join(EVAL_ROOT, 'README.md');
const PROTOCOL = 'redteam-probe-v1-protocol.md';
export const AFTER = sectionMarkers('question-difficulty').end;
export const { start: README_START, end: README_END } = sectionMarkers(RUN);
export const { start: NOTE_START, end: NOTE_END } = sectionMarkers(`${RUN}-note`);
export const { start: ANALYSIS_START, end: ANALYSIS_END } = sectionMarkers(`${RUN}-analysis`);

// The red-team calls that were refused before generation because no pinned
// endpoint was left (the cause the protocol counts as not measured).
export function refusedRoutes(slots) {
  return [...slots].filter((slot) => slot.meta?.branch === 'RT' && slot.state === 'failed' && slot.result?.error?.status === 404
    && String(slot.result.error.detail || '').startsWith('No endpoints found'))
    .map((slot) => ({ questionId: slot.meta.questionId, model: slot.meta.model, maxPrice: /Filter by Max Price removed[^;]*/.test(slot.result.error.detail) }));
}

// Pure: why the primary set stopped, from the report, the launches and the
// refused calls. `checked` is the last launch's route check (route.json).
export function buildNote(report, stops, refused, checked) {
  const { meta } = report;
  const lines = [];
  const states = Object.entries(meta.states).map(([key, value]) => `${key} ${value}`).join(', ');
  lines.push(`- Состояния вопросов: ${states}. В главный счёт по правилу начального отрезка входят первые ${meta.measured}: вопрос ${meta.measured + 1} в порядке не измерен.`);
  const launches = stops.filter((row) => row.end);
  if (launches.length) lines.push(`- Запуски: ${launches.map((row) => `${row.kind} — \`${row.end}\`${row.blocked?.length ? `, закрыт до конца запуска: ${row.blocked.join(', ')}` : ''}`).join('; ')}.`);
  for (const item of refused) {
    lines.push(`- Вызов red team \`${item.questionId}\` (${item.model}) отклонён до генерации обеими попытками: 404 «No endpoints found»${item.maxPrice ? ', закреплённый хост убран фильтром максимальной цены, то есть стоил дороже закреплённой цены' : ''}. По протоколу такой вопрос не измерен, хост внутри замера не заменяется; остальные вопросы с этой моделью в роли red team не отправлялись.`);
  }
  const unflagged = refused.filter((item) => checked?.checks?.[item.model] && !checked.checks[item.model].problems.length);
  for (const model of new Set(unflagged.map((item) => item.model))) {
    lines.push(`- Проверка маршрута при запуске эту модель не закрыла (\`route.json\`: проблем нет). Замороженный \`routeProblems\` сравнивает цену первого хоста в списке, чьё имя совпадает с закреплённым \`${checked.checks[model].tag}\` или начинается с него; в списке хостов ${model}, прочитанном после прогона, первым таким был другой, более дешёвый вариант хоста. На исход это не влияет: закрытая при запуске модель тоже оставила бы свои вопросы неизмеренными.`);
  }
  return lines.join('\n');
}

function noteFromRun() {
  const report = readJson(path.join(RUN_DIR, 'report.json'));
  const slots = readSlotJournal(path.join(RUN_DIR, 'test', 'events.jsonl')).values();
  return buildNote(report, readJsonl(path.join(RUN_DIR, 'stops.jsonl')), refusedRoutes(slots), readJson(path.join(RUN_DIR, 'route.json')));
}

const pp = (value) => (value == null ? 'н/д' : `${(value * 100).toFixed(1)} п. п.`);
const pct = (value) => (value == null ? 'н/д' : `${(value * 100).toFixed(1)}%`);
const ci = (interval) => (interval?.low == null ? 'н/д' : `[${(interval.low * 100).toFixed(1)}, ${(interval.high * 100).toFixed(1)}]`);
const usd = (value) => `$${Number(value || 0).toFixed(2)}`;
const pFixed = (item) => (item.n ? item.p.toFixed(3) : 'н/д');

const SUPPORT = { supported: 'подтверждено 95% интервалом', 'not supported': 'не подтверждено 95% интервалом' };

// The reading lines of interpretPair (redTeamProbe.js) in Russian. A line
// that matches no pattern is kept as it is.
export function readingRu(line) {
  const rules = [
    [/^interim: /, () => 'промежуточно: главный набор не завершён, окончательного вывода нет'],
    [/^direction: statistical evidence that (\S+) is ahead of (\S+) on this set$/, (m) => `направление: ${m[1]} впереди ${m[2]} на этом наборе (точный тест Макнемара, p < 0.05)`],
    [/^direction: not established/, () => 'направление не установлено; это не доказательство равенства'],
    [/^size: the 95% interval is degenerate/, () => '95% интервал вырожден и ничего не говорит о размере или равенстве'],
    [/^(\S+) ahead by more than 5 percentage points: (supported|not supported) by the 95% interval$/, (m) => `${m[1]} впереди больше чем на 5 п. п.: ${SUPPORT[m[2]]}`],
    [/^(\S+) ahead by more than 5 percentage points: undecided/, (m) => `${m[1]} впереди больше чем на 5 п. п.: не решено, 95% интервал пересекает порог`],
    [/^practical equivalence: the 90% interval is degenerate/, () => 'практическое равенство: 90% интервал вырожден, вывода нет'],
    [/^practical equivalence within ±5 percentage points: supported/, () => 'практическое равенство в пределах ±5 п. п.: подтверждено 90% интервалом (приближённый bootstrap-критерий, не точный TOST)'],
    [/^practical equivalence within ±5 percentage points: not shown/, () => 'практическое равенство в пределах ±5 п. п.: не показано, 90% интервал доходит до границы'],
    [/^only (\d+) discordant pairs/, (m) => `расходящихся пар только ${m[1]}, поэтому bootstrap-интервалы грубые`],
  ];
  for (const [pattern, render] of rules) {
    const match = String(line).match(pattern);
    if (match) return render(match);
  }
  return line;
}

const NAME_RU = Object.freeze({
  'Rp - C': 'Rp − C', 'Rp - Rc': 'Rp − Rc', 'C - stored A8': 'C − сохранённая A8', 'Rc - C, new blocks': 'Rc − C, новые блоки',
  'Rc - C, legacy blocks': 'Rc − C, прежние блоки', 'Rc - C, changed requests': 'Rc − C, где запрос изменился', 'G - C': 'G − C',
});

// Pure: the block from report.json and the audit summary of campaign main.
export function renderReadme(report, audit) {
  const { meta, primary, secondary, policyG, diagnostics } = report;
  const lines = [
    `### Влияние red team после сохранённого Stage 2 (\`${RUN}\`)`,
    '',
    `Источник — сохранённые Stage 1 и Stage 2 теста \`${meta.source}\`; хосты из \`${meta.routes}\`. Правила — в [${PROTOCOL}](${PROTOCOL}), заморожены до первого платного вызова (коммит \`${meta.frozen ? meta.frozen.slice(0, 7) : 'н/д'}\`). Новые вызовы — только red team (RT) и председатель: C без red team, Rc с «чистым» red team, Rp с red team как в продукте. Числа и чтение посчитаны кодом; блок собран из отчёта без толкования.`,
    '',
    `В главный счёт входят ${meta.measured} из ${meta.planned} вопросов — самый длинный полностью измеренный начальный отрезок порядка с фиксированным зерном (${meta.complete ? 'набор завершён' : 'набор не завершён'}). Всего измерено ${meta.states.measured ?? 0}.`,
    '',
    `**Главная пара Rc − C:** ${pp(primary.delta)}; точность C ${pct(primary.accuracy.C)}, Rc ${pct(primary.accuracy.Rc)}. Выигрыши / проигрыши ${primary.wins} / ${primary.losses}; ничьи по построению ${primary.constructionTies}, наблюдаемые ${primary.observedTies}. Точный тест Макнемара p = ${pFixed(primary)}; 95% интервал ${ci(primary.interval)} п. п., 90% интервал ${ci(primary.interval90)} п. п.`,
    '',
    ...primary.reading.map((line) => `- ${readingRu(line)}.`),
    '',
    '| Вторичное сравнение (одна поправка Холма) | n | Δ | В / П | p | p Холма |',
    '| --- | --- | --- | --- | --- | --- |',
    ...secondary.map((item) => `| ${NAME_RU[item.name] || item.name} | ${item.n} | ${item.n ? pp(item.delta) : 'н/д'} | ${item.n ? `${item.wins} / ${item.losses}` : ''} | ${pFixed(item)} | ${item.holm.toFixed(3)} |`),
    '',
    `**Политика G** (red team только если три ответа Stage 1 не прочитаны или не совпали; правило записано до первого платного вызова): g = 1 на ${policyG.call} вопросах, g = 0 на ${policyG.skip}; точность G ${pct(policyG.accuracy)}. Rc − C там, где g = 1: ${policyG.calledLayer.wins} / ${policyG.calledLayer.losses}; там, где g = 0: ${policyG.skippedLayer.wins} / ${policyG.skippedLayer.losses}. Расчётная стоимость на измеренных вопросах: только C ${usd(policyG.cost.cOnly)}, G ${usd(policyG.cost.g)}, red team всегда ${usd(policyG.cost.always)}. Единодушные ошибки совета G пропускает.`,
    '',
    '| Чистый red team | Вопросов | Лидер верен | Лидер неверен | Лидер неверен, C верен | Исправлено | Испорчено |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...Object.entries(diagnostics.byVerdict).sort().map(([key, entry]) => `| ${key} | ${entry.n} | ${entry.leaderRight} | ${entry.leaderWrong} | ${entry.leaderWrongCRight} | ${entry.fixed} | ${entry.broke} |`),
    '',
    'Исправления и потери считаются относительно свежего C. Неверный лидер не равен неверному итоговому ответу: председатель без red team уже может его исправить. Таблица не измеряет достоверность критики: верный ответ может стоять на ошибочном доводе, неверный — получить ложное опровержение.',
    '',
    `Чем кончились вызовы RT: ${Object.entries(diagnostics.rtEndings).map(([model, counts]) => `${model} — ${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(', ')}`).join('; ') || 'н/д'}.`,
    '',
    `Расход замера: подтверждено ${usd(meta.spend.settledUsd)}, удержано ${usd(meta.spend.heldUsd)}, ${meta.spend.posts} POST (лимит $40 и 1800). Стоимость самой политики (RT и один председатель на вопрос) — ${usd(diagnostics.policyUsd)}.`,
  ];
  if (audit) {
    lines.push(
      '',
      'Прежний замер в кампании `main` (A6 с red team против A7 без него), пересчитанный по сохранённым журналам кодом `tools/redteam_main_audit.js`:',
      '',
      '| Слой `main` | Вопросов | A6 верен, A7 нет | A7 верен, A6 нет | Из них RT на лимите |',
      '| --- | --- | --- | --- | --- |',
      ...audit.map(({ name, summary }) => `| ${name} | ${summary.questions} | ${summary.wins} | ${summary.losses} | ${summary.capLosses} |`),
    );
  }
  lines.push(
    '',
    `Вопросы, где C и Rc разошлись по верности, с текстами для ручного разбора — \`.runs/${RUN}/discordant.md\`. Полный отчёт — \`.runs/${RUN}/report.md\`. Воспроизвести без сети:`,
    '',
    '```bash',
    'node frontend/eval/redTeamProbeCli.js --phase report',
    'node frontend/eval/tools/redteam_main_audit.js',
    '```',
  );
  return lines.join('\n');
}

export const INSTRUCTION = [
  'You analyse the result of a measurement for the README of the project. The protocol and the report are given below as data.',
  'Write the body of a section titled "Анализ", in Russian, 150 to 300 words, as short paragraphs or a short list. No heading: the heading is added separately.',
  'Use only numbers that appear in the report or in the audit of campaign main. Do not introduce any other number.',
  'Cover: what the primary pair Rc − C shows under the pre-set reading rules; what policy G and the verdict table show; what the old campaign main audit adds; what the result can and cannot support; the main limits.',
  'Do not judge the arguments of individual answers. Do not present any follow-up experiment as decided. You may say what stays open.',
  'Return only the text of the section.',
].join('\n');

export function analysisSection(record) {
  return attributedSection('Анализ (red team)', `\`.runs/${RUN}/report.md\`, аудиту \`main\` и протоколу`, 'с отчётом', record);
}

export function runAnalysisLive() {
  const audit = path.join(EVAL_ROOT, '.runs', 'redteam-main-audit', 'audit.md');
  const note = readFileSync(path.join(RUN_DIR, 'readme-note.md'), 'utf8');
  return placeAnalysis({
    dir: path.join(RUN_DIR, 'analysis'),
    instruction: INSTRUCTION,
    rules: `${ruleFiles(EVAL_ROOT, [PROTOCOL])}\n\n# Note computed from the run (README, beside the block)\n\n${note}`,
    report: `${readFileSync(path.join(RUN_DIR, 'report.md'), 'utf8')}\n\n# Audit of campaign main\n\n${readFileSync(audit, 'utf8')}`,
    limits: ANALYSIS_LIMITS,
    readme: README,
    start: ANALYSIS_START,
    end: ANALYSIS_END,
    after: NOTE_END,
    section: analysisSection,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--analysis')) {
    if (!argv.includes('--live')) throw new Error('--analysis posts only with --live');
    process.exitCode = await runAnalysisLive();
  } else {
    const report = readJson(path.join(RUN_DIR, 'report.json'));
    if (!report) throw new Error('Build the probe report first: node frontend/eval/redTeamProbeCli.js --phase report');
    const block = renderReadme(report, readJson(AUDIT));
    const note = noteFromRun();
    writeFileSync(path.join(RUN_DIR, 'readme-note.md'), `${note}\n`, 'utf8');
    if (argv.includes('--readme')) {
      rewriteFile(README, (text) => placeAfter(placeAfter(text, README_START, README_END, block, AFTER), NOTE_START, NOTE_END, note, README_END));
    }
    console.log(block);
    console.log('----');
    console.log(note);
  }
}
