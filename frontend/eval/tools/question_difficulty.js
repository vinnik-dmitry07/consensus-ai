// Sorts benchmark questions into easy / borderline / unsolved from answers the
// campaigns already stored. Offline: no network, no model call, no write
// outside the output directory. Not part of the hashed method.
//
//   node eval/tools/question_difficulty.js [--slack N] [--out <dir>]
//
// The rule, fixed before any count was read:
//   attempt    one answer of one model to the question (a B sample or a Stage 1
//              answer of another council model). A8, S8 and P8 are built from
//              those answers, so they are not attempts.
//   right      the stored canonical answer equals the gold in force. An attempt
//              with no readable final answer (cut at the cap, no ANSWER line)
//              is wrong. A call that never returned an answer is not an attempt.
//   easy       right attempts >= n - slack
//   unsolved   right attempts <= slack
//   borderline everything else
// slack is 0 unless --slack says otherwise.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonAnswer, gradeResponse } from '../grade.js';
import { BLOCK_LABELS, BLOCK_ORDER } from '../a8Blocks.js';

const EVAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(EVAL_ROOT, '.runs');

// Where each set of answers comes from.
const MAIN_RUN = 'a8-open-v5e';
const GOLD_FILE = 'gold-corrections-a8-open-v5e.json';
const GOLD_SENSITIVITY_FILE = 'gold-corrections-a8-open-v5e-all.json';
const ARXIV_RUN = 'a8-open-v6';
const DEV_RUNS = [{ run: 'a8-open-v5e', blocks: null }, { run: 'a8-open-v6', blocks: ['arxiv'] }];
const OTHER_POOLS = [
  { run: 'a8-open-v4', label: 'тот же B, другой состав совета, меньший лимит токенов' },
  { run: 'a8-strong-v1', label: 'сильные закрытые модели, тест остановлен на 40 вопросах из 120' },
];

const CATEGORIES = ['easy', 'borderline', 'unsolved'];
const CATEGORY_RU = { easy: 'легко-решаемые', borderline: 'пограничные', unsolved: 'не-решаемые' };
const SUBTYPE_RU = {
  b_right: 'все выборки B верны, ошиблась другая модель совета',
  b_split: 'выборки B расходятся между собой',
  b_wrong: 'все выборки B неверны, права другая модель совета',
};

function flag(argv, name, fallback = null) {
  const at = argv.indexOf(name);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function loadTasks() {
  const byId = new Map();
  for (const name of ['bank.json', 'bank-a8x.json']) {
    for (const item of readJson(path.join(EVAL_ROOT, '.cache', name)).items) {
      byId.set(`${item.split}:${item.dataset}:${item.sourceId}`, item);
    }
  }
  return byId;
}

// Same reading of the corrections file as the campaign report: an entry either
// replaces the gold or removes the question from the scored set.
function loadGold(tasks, file) {
  const gold = new Map();
  const excluded = new Map();
  for (const [id, entry] of Object.entries(readJson(path.join(EVAL_ROOT, file)))) {
    if (id.startsWith('$')) continue;
    const task = tasks.get(id);
    if (!task) throw new Error(`Gold override for unknown question ${id}`);
    if (entry?.exclude === true) {
      excluded.set(id, entry.reason || '');
      continue;
    }
    const canon = canonAnswer(String(entry?.gold ?? entry), task);
    if (canon == null) throw new Error(`Gold override for ${id} does not read as a ${task.kind} answer`);
    gold.set(id, canon);
  }
  return { gold, excluded };
}

function recordsIn(dir, prefix) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)))
    .filter((row) => row?.id);
}

function selectionOf(run) {
  const selection = readJson(path.join(RUNS, run, 'selection.json'));
  if (!selection.council.includes(selection.b)) throw new Error(`${run}: B is not on the council`);
  return selection;
}

function capsOf(run) {
  return readJson(path.join(RUNS, run, 'campaign.json')).stageCaps || null;
}

function categoryOf(right, total, slack) {
  if (!total) return null;
  if (right >= total - slack && right > slack) return 'easy';
  if (right <= slack) return 'unsolved';
  return 'borderline';
}

// One question of one pool: counts, category, and the split between B's own
// samples and the other council models.
function summarize(base, attempts, bModel, slack) {
  const right = attempts.filter((item) => item.right).length;
  const ofB = attempts.filter((item) => item.model === bModel);
  const others = attempts.filter((item) => item.model !== bModel);
  const rightB = ofB.filter((item) => item.right).length;
  const category = categoryOf(right, attempts.length, slack);
  let subtype = null;
  if (category === 'borderline' && ofB.length) {
    if (rightB === ofB.length) subtype = 'b_right';
    else if (rightB === 0) subtype = 'b_wrong';
    else subtype = 'b_split';
  }
  const tally = new Map();
  for (const item of attempts) {
    const key = item.answer == null ? '∅' : String(item.answer);
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  return {
    ...base,
    n: attempts.length,
    right,
    noAnswer: attempts.filter((item) => item.answer == null).length,
    nB: ofB.length,
    rightB,
    others: others.map((item) => ({ model: item.model, right: item.right, answer: item.answer })),
    category,
    subtype,
    tally: [...tally.entries()].sort((left, right_) => right_[1] - left[1]),
  };
}

function regradeArm(grade, gold) {
  if (!grade) return null;
  if (grade.status !== 'graded' || grade.extracted == null) return grade.correct === 1 ? 1 : 0;
  return grade.extracted === gold ? 1 : 0;
}

// Campaigns from v5 on store the canonical answer of every sample and of every
// Stage 1 answer, so nothing is graded again here.
function fromStoredAnswers(run, tasks, goldInForce, slack, checks) {
  const selection = selectionOf(run);
  const bIndex = selection.council.indexOf(selection.b);
  const rows = recordsIn(path.join(RUNS, run, 'comparison', 'test'), 'test_').filter((row) => row.status === 'complete');
  const out = [];
  for (const row of rows) {
    const task = tasks.get(row.id);
    if (!task) throw new Error(`${run}: ${row.id} is not in the bank`);
    const gold = goldInForce.gold.get(row.id) ?? task.goldCanon;
    const diagnostics = row.diagnostics || {};
    const samples = diagnostics.replicateAnswers;
    const council = diagnostics.councilAnswers;
    if (!Array.isArray(samples) || !Array.isArray(council)) throw new Error(`${run}: ${row.id} has no stored answers`);
    if (council[bIndex] !== samples[0]) checks.bSampleIsStage1Mismatch += 1;
    // The path used for the older campaigns, checked where both are stored.
    (diagnostics.replicateTexts || []).forEach((text, index) => {
      const grade = gradeResponse(task, text || '');
      const again = grade.status === 'graded' ? grade.extracted : null;
      checks.regradedSamples += 1;
      if (again !== samples[index]) checks.regradeMismatch += 1;
    });
    const attempts = samples.map((answer) => ({ model: selection.b, answer, right: answer != null && answer === gold }));
    selection.council.forEach((model, index) => {
      if (index === bIndex) return;
      const answer = council[index];
      attempts.push({ model, answer, right: answer != null && answer === gold });
    });
    const arms = {};
    for (const arm of ['A8', 'S8', 'P8', 'B8']) arms[arm] = regradeArm(row.arms?.[arm], gold);
    out.push(summarize({
      id: row.id,
      split: 'test',
      block: row.block,
      gold,
      // B's five answers in sample order, and the stored vote over them, for
      // tools/sample_count.js.
      bAnswers: samples,
      storedVote5: regradeArm(diagnostics.replicateVote, gold),
      goldCorrected: goldInForce.gold.has(row.id),
      excluded: goldInForce.excluded.has(row.id),
      arms,
    }, attempts, selection.b, slack));
  }
  return { selection, rows: out };
}

// Older campaigns store the five sample texts and the tally of the council
// vote. The samples are graded again from their text; the other council
// models' answers are the tally minus B's own Stage 1 answer (sample 1).
function fromTexts(run, tasks, goldInForce, slack, checks) {
  const selection = selectionOf(run);
  const rows = recordsIn(path.join(RUNS, run, 'comparison', 'test'), 'test_').filter((row) => row.status === 'complete');
  const out = [];
  for (const row of rows) {
    const task = tasks.get(row.id);
    if (!task) throw new Error(`${run}: ${row.id} is not in the bank`);
    const gold = goldInForce.gold.get(row.id) ?? task.goldCanon;
    const diagnostics = row.diagnostics || {};
    const attempts = [];
    let first = null;
    (diagnostics.replicateTexts || []).forEach((text, index) => {
      if (!String(text || '').trim()) return;
      const grade = gradeResponse(task, text);
      const answer = grade.status === 'graded' ? grade.extracted : null;
      if (index === 0) {
        first = { answer };
        const stored = row.arms?.B8;
        const storedAnswer = stored?.status === 'graded' ? stored.extracted : null;
        if (storedAnswer !== answer) checks.oldSample1Mismatch += 1;
      }
      attempts.push({ model: selection.b, answer, right: answer != null && answer === gold });
    });
    const incompleteCouncil = row.arms?.A8?.reason === 'incomplete_council';
    const vote = diagnostics.councilVote;
    if (vote && !incompleteCouncil && first) {
      const left = new Map(Object.entries(vote.votes || {}));
      if (first.answer != null) {
        if (!left.has(first.answer)) checks.oldTallyMismatch += 1;
        else if (left.get(first.answer) === 1) left.delete(first.answer);
        else left.set(first.answer, left.get(first.answer) - 1);
      }
      let counted = 0;
      for (const [answer, count] of left) {
        for (let index = 0; index < count; index += 1) {
          attempts.push({ model: 'другая модель совета', answer, right: answer === gold });
          counted += 1;
        }
      }
      for (let index = counted; index < selection.council.length - 1; index += 1) {
        attempts.push({ model: 'другая модель совета', answer: null, right: false });
      }
    }
    out.push(summarize({ id: row.id, split: 'test', block: row.block, gold, excluded: goldInForce.excluded.has(row.id) }, attempts, selection.b, slack));
  }
  return { selection, rows: out };
}

// Every Stage 1 answer and B sample that came back in the test phase of a
// campaign, graded from its text, with the reason the stream ended.
function slotAttempts(run, tasks, goldOf) {
  const file = path.join(RUNS, run, 'comparison', 'test', 'events.jsonl');
  const slots = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.kind === 'slot' && event.key) slots.set(event.key, event.slot);
  }
  const perQuestion = new Map();
  const seen = new Set();
  const finish = {};
  for (const slot of slots.values()) {
    const meta = slot?.meta;
    if (!meta || !['stage1', 'sample'].includes(meta.stage)) continue;
    if (slot.state !== 'completed' || !slot.result?.ok) continue;
    const key = [meta.questionId, meta.stage, meta.sample, meta.model].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const task = tasks.get(meta.questionId);
    if (!task) throw new Error(`${run}: ${meta.questionId} is not in the bank`);
    const grade = gradeResponse(task, slot.result.content || '');
    const answer = grade.status === 'graded' ? grade.extracted : null;
    const reason = slot.result.finishReason || slot.finishReason || 'unknown';
    finish[reason] = (finish[reason] || 0) + 1;
    if (!perQuestion.has(meta.questionId)) perQuestion.set(meta.questionId, []);
    perQuestion.get(meta.questionId).push({
      model: meta.model, answer, right: answer != null && answer === goldOf(meta.questionId, task), finishReason: reason,
    });
  }
  return { perQuestion, finish };
}

// Adds to each question how its attempts ended, and checks that the journal
// holds the same answers as the question record.
function withFinishReasons(run, rows, tasks, goldInForce, checks) {
  const { perQuestion } = slotAttempts(run, tasks, (id, task) => goldInForce.gold.get(id) ?? task.goldCanon);
  const key = (list) => list.map((item) => String(item)).sort().join('\u0001');
  return rows.map((row) => {
    const attempts = perQuestion.get(row.id) || [];
    const stored = row.tally.flatMap(([answer, count]) => Array(count).fill(answer));
    const journal = attempts.map((item) => (item.answer == null ? '∅' : item.answer));
    checks.journalQuestions += 1;
    if (key(stored) !== key(journal)) checks.journalMismatch += 1;
    const cut = attempts.filter((item) => item.finishReason === 'length');
    return {
      ...row,
      cutAtCap: cut.length,
      cutNoAnswer: cut.filter((item) => item.answer == null).length,
      wrongAnswer: attempts.filter((item) => item.answer != null && !item.right).length,
    };
  });
}

// A campaign whose questions never completed still holds the answers that did
// come back.
function fromSlots(run, tasks, slack) {
  const selection = selectionOf(run);
  const { perQuestion, finish } = slotAttempts(run, tasks, (id, task) => task.goldCanon);
  const rows = [];
  for (const [id, task] of tasks) {
    if (task.split !== 'test' || task.block !== 'arxiv') continue;
    const attempts = perQuestion.get(id) || [];
    rows.push({
      ...summarize({ id, split: 'test', block: task.block, gold: task.goldCanon }, attempts, selection.b, slack),
      cutAtCap: attempts.filter((item) => item.finishReason === 'length').length,
    });
  }
  return { selection, rows, finish };
}

// Dev: every candidate model answered once.
function fromDev(run, blocks, slack) {
  const out = [];
  for (const row of recordsIn(path.join(RUNS, run, 'dev'), 'dev_')) {
    if (blocks && !blocks.includes(row.block)) continue;
    const attempts = (row.answers || [])
      .filter((item) => item.success)
      .map((item) => ({ model: item.id, answer: item.status === 'graded' ? '' : null, right: item.correct === 1 }));
    out.push(summarize({ id: row.id, split: 'dev', block: row.block, run }, attempts, null, slack));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report

const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '—');
const short = (value, max = 18) => (String(value).length > max ? `${String(value).slice(0, max)}…` : String(value));
const mark = (value) => (value === 1 || value === true ? '✓' : value === 0 || value === false ? '✗' : '—');
const blockRank = (block) => (BLOCK_ORDER.indexOf(block) + 1) || 99;

function attemptRange(rows) {
  const low = Math.min(...rows.map((row) => row.n));
  const high = Math.max(...rows.map((row) => row.n));
  return low === high ? `по ${low} попыток` : `от ${low} до ${high} попыток`;
}

function countBy(rows, keyOf) {
  const counts = {};
  for (const row of rows) counts[keyOf(row)] = (counts[keyOf(row)] || 0) + 1;
  return counts;
}

function table(header, body) {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...body.map((cells) => `| ${cells.join(' | ')} |`)];
}

function categoryCells(rows) {
  const counts = countBy(rows, (row) => row.category);
  return CATEGORIES.map((name) => `${counts[name] || 0} (${pct(counts[name] || 0, rows.length)})`);
}

function byBlockTable(rows, sets) {
  const body = [];
  const blocks = [...new Set(rows.map((row) => row.block))].sort((left, right) => blockRank(left) - blockRank(right));
  for (const block of blocks) {
    const mine = rows.filter((row) => row.block === block);
    body.push([BLOCK_LABELS[block] || block, mine.length, ...categoryCells(mine)]);
  }
  for (const [label, test] of sets) {
    const mine = rows.filter(test);
    if (mine.length) body.push([`**${label}**`, `**${mine.length}**`, ...categoryCells(mine).map((cell) => `**${cell}**`)]);
  }
  return table(['Блок', 'Вопросов', ...CATEGORIES.map((name) => CATEGORY_RU[name])], body);
}

function crossTab(left, right) {
  const other = new Map(right.map((row) => [row.id, row]));
  const pairs = left.filter((row) => other.has(row.id) && other.get(row.id).category);
  const body = CATEGORIES.map((mine) => [
    CATEGORY_RU[mine],
    ...CATEGORIES.map((theirs) => pairs.filter((row) => row.category === mine && other.get(row.id).category === theirs).length),
  ]);
  const same = pairs.filter((row) => row.category === other.get(row.id).category).length;
  return { pairs: pairs.length, same, body };
}

function buildReport(data) {
  const { main, arxiv, dev, pools, slack, checks, sensitivity } = data;
  const scored = main.rows.filter((row) => !row.excluded);
  const primary = (row) => !['aime', 'gpqa', 'mmlu'].includes(row.block);
  const legacy = (row) => !primary(row);
  const others = main.selection.council.filter((model) => model !== main.selection.b);
  const lines = [];
  const push = (...items) => lines.push(...items);

  push(
    '# Категории вопросов: легко-решаемые, пограничные, не-решаемые',
    '',
    'Файл построен кодом `eval/tools/question_difficulty.js` из сохранённых ответов кампаний. Новых вызовов моделей нет. Тексты вопросов в отчёт не попадают.',
    '',
    '## Правило',
    '',
    '- Попытка — один ответ одной модели на вопрос: выборка B или ответ Stage 1 другой модели совета. A8, S8 и P8 собраны из этих же ответов и попытками не считаются.',
    '- Попытка верна, если её канонический ответ равен действующему эталону. Ответ без читаемой последней строки (в том числе обрезанный на лимите токенов) считается неверным. Вызов, на который ответ не пришёл, попыткой не считается.',
    slack === 0
      ? '- Легко-решаемый: верны все попытки. Не-решаемый: не верна ни одна. Пограничный: часть верна, часть нет.'
      : `- Легко-решаемый: верных попыток не меньше n − ${slack}. Не-решаемый: верных попыток не больше ${slack}. Пограничный: всё остальное.`,
    '- Категория относится к этим моделям при этих лимитах, а не к вопросу вообще.',
    '',
    `## Тест ${MAIN_RUN}: ${scored.length} вопросов, ${attemptRange(scored)} на вопрос`,
    '',
    `Попытки: 5 выборок B = \`${main.selection.b}\` и по одному ответу Stage 1 от ${others.map((model) => `\`${model}\``).join(' и ')}. Лимит 32768 токенов на каждый вызов. Эталоны из \`${GOLD_FILE}\`: исправлено ${main.rows.filter((row) => row.goldCorrected).length}, исключено вопросов ${main.rows.length - scored.length}.`,
    '',
    ...byBlockTable(scored, [['Новые блоки', primary], ['Прежние блоки', legacy], ['Всего', () => true]]),
    '',
    '### Сколько попыток из 7 верны',
    '',
  );
  const blocks = [...new Set(scored.map((row) => row.block))].sort((left, right) => blockRank(left) - blockRank(right));
  const size = scored[0]?.n || 0;
  const range = Array.from({ length: size + 1 }, (_, index) => index);
  push(...table(
    ['Блок', ...range.map((value) => `${value}/${size}`)],
    [...blocks.map((block) => {
      const mine = scored.filter((row) => row.block === block);
      return [BLOCK_LABELS[block] || block, ...range.map((value) => mine.filter((row) => row.right === value).length)];
    }), ['**Всего**', ...range.map((value) => `**${scored.filter((row) => row.right === value).length}**`)]],
  ));

  push(
    '',
    '### Чем закончились попытки',
    '',
    '«Нет читаемого ответа» — в тексте нет разбираемой последней строки с ответом. «Из них обрезано» — поток при этом остановлен на лимите 32768 токенов.',
    '',
    ...table(
      ['Категория', 'Вопросов', 'Попыток', 'Верно', 'Неверный ответ', 'Нет читаемого ответа', 'Из них обрезано на лимите'],
      CATEGORIES.map((name) => {
        const mine = scored.filter((row) => row.category === name);
        const sum = (field) => mine.reduce((total, row) => total + row[field], 0);
        return [CATEGORY_RU[name], mine.length, sum('n'), sum('right'), sum('wrongAnswer'), sum('noAnswer'), sum('cutNoAnswer')];
      }),
    ),
  );

  const borderline = scored.filter((row) => row.category === 'borderline');
  push('', '### Пограничные вопросы: где расходятся ответы', '');
  push(...table(
    ['Вид', 'Новые блоки', 'Прежние блоки', 'Всего'],
    Object.keys(SUBTYPE_RU).map((name) => {
      const mine = borderline.filter((row) => row.subtype === name);
      return [SUBTYPE_RU[name], mine.filter(primary).length, mine.filter(legacy).length, mine.length];
    }),
  ));

  push('', '### Руки по категориям', '', 'Верных ответов руки внутри категории. «A8 > S8» — вопросы, где A8 верна, а S8 нет; «S8 > A8» — наоборот.', '');
  const armRows = [];
  for (const [label, test] of [['Новые блоки', primary], ['Прежние блоки', legacy]]) {
    for (const name of CATEGORIES) {
      const mine = scored.filter((row) => test(row) && row.category === name);
      const hits = (arm) => `${mine.filter((row) => row.arms[arm] === 1).length} (${pct(mine.filter((row) => row.arms[arm] === 1).length, mine.length)})`;
      armRows.push([
        label, CATEGORY_RU[name], mine.length, hits('A8'), hits('S8'), hits('P8'), hits('B8'),
        mine.filter((row) => row.arms.A8 === 1 && row.arms.S8 === 0).length,
        mine.filter((row) => row.arms.A8 === 0 && row.arms.S8 === 1).length,
      ]);
    }
  }
  push(...table(['Набор', 'Категория', 'Вопросов', 'A8', 'S8', 'P8', 'B8', 'A8 > S8', 'S8 > A8'], armRows));

  // ArXivMath
  const answered = arxiv.rows.filter((row) => row.n > 0);
  const attemptsTotal = arxiv.rows.reduce((sum, row) => sum + row.n, 0);
  push(
    '',
    `## ArXivMath: тест ${ARXIV_RUN} остановлен, данные неполные`,
    '',
    `Ни один из ${arxiv.rows.length} вопросов не дошёл до конца. Посчитаны ответы, которые успели прийти: ${attemptsTotal} попыток, от ${Math.min(...arxiv.rows.map((row) => row.n))} до ${Math.max(...arxiv.rows.map((row) => row.n))} на вопрос. Из них обрезано на лимите 32768 токенов: ${arxiv.finish.length || 0}; без читаемого ответа: ${arxiv.rows.reduce((sum, row) => sum + row.noAnswer, 0)}. Эталоны ArXivMath не перепроверялись. Категории здесь предварительные.`,
    '',
    ...table(
      ['Попыток на вопрос', 'Вопросов', ...CATEGORIES.map((name) => CATEGORY_RU[name])],
      [...new Set(answered.map((row) => row.n))].sort((left, right) => left - right).map((count) => {
        const mine = answered.filter((row) => row.n === count);
        const counts = countBy(mine, (row) => row.category);
        return [count, mine.length, ...CATEGORIES.map((name) => counts[name] || 0)];
      }).concat([[
        '**Всего**', `**${answered.length}**`,
        ...CATEGORIES.map((name) => `**${answered.filter((row) => row.category === name).length}**`),
      ]]),
    ),
    '',
    ...table(
      ['Вопрос', 'Верно / попыток', 'Без ответа', 'Обрезано на лимите', 'Ответы (эталон)', 'Категория'],
      arxiv.rows.map((row) => [
        `\`${row.id}\``, `${row.right}/${row.n}`, row.noAnswer, row.cutAtCap,
        `${row.tally.map(([answer, count]) => `${short(answer)}×${count}`).join(', ')} (${short(row.gold)})`,
        CATEGORY_RU[row.category] || '—',
      ]),
    ),
  );

  // Dev
  push(
    '',
    '## Dev: пять моделей-кандидатов, по одной попытке',
    '',
    `Источник: dev ${DEV_RUNS.map((item) => `${item.run}${item.blocks ? ` (${item.blocks.join(', ')})` : ''}`).join(' и ')}. Здесь другой состав попыток, чем в тесте: пять разных моделей по одному разу.`,
    '',
    ...byBlockTable(dev, [['Всего', () => true]]),
  );

  // Other pools
  push('', '## Те же прежние вопросы при другом составе попыток', '');
  const legacyRows = scored.filter(legacy);
  for (const pool of pools) {
    const tab = crossTab(legacyRows, pool.rows);
    push(
      `### ${pool.run}: ${pool.label}`,
      '',
      `B = \`${pool.selection.b}\`, совет: ${pool.selection.council.map((model) => `\`${model}\``).join(', ')}. Лимит токенов на ответ Stage 1 и на выборку: ${pool.caps?.stage1 ?? '?'} и ${pool.caps?.sample ?? '?'} (в ${MAIN_RUN} — ${main.caps?.stage1 ?? '?'} и ${main.caps?.sample ?? '?'}). Общих вопросов ${tab.pairs}, категория совпала в ${tab.same} (${pct(tab.same, tab.pairs)}). Строки — категория в ${MAIN_RUN}, столбцы — в ${pool.run}.`,
      '',
      ...table([`${MAIN_RUN} \\ ${pool.run}`, ...CATEGORIES.map((name) => CATEGORY_RU[name])], tab.body),
      '',
    );
  }

  // Lists
  const noteOf = (row) => [
    row.goldCorrected ? 'эталон исправлен' : null,
    sensitivity.gold.has(row.id) && !row.goldCorrected ? 'эталон оспорен в расширенном списке' : null,
    sensitivity.excluded.has(row.id) ? 'исключён в расширенном списке' : null,
  ].filter(Boolean).join('; ');
  const sorted = (rows) => [...rows].sort((left, right) => blockRank(left.block) - blockRank(right.block) || left.id.localeCompare(right.id));
  const unsolved = sorted(scored.filter((row) => row.category === 'unsolved'));
  push(
    `## Списки, тест ${MAIN_RUN}`,
    '',
    `### Не-решаемые (${unsolved.length})`,
    '',
    ...table(
      ['Вопрос', 'Блок', 'Ответы (число попыток)', 'Эталон', 'Без ответа', 'Обрезано на лимите', 'A8', 'S8', 'P8', 'Пометка'],
      unsolved.map((row) => [
        `\`${row.id}\``, BLOCK_LABELS[row.block] || row.block,
        row.tally.map(([answer, count]) => `${short(answer)}×${count}`).join(', '), short(row.gold),
        row.noAnswer, row.cutAtCap, mark(row.arms.A8), mark(row.arms.S8), mark(row.arms.P8), noteOf(row),
      ]),
    ),
    '',
    `### Пограничные (${borderline.length})`,
    '',
    ...table(
      ['Вопрос', 'Блок', 'Верно', 'B', ...others.map((model) => model.split('/')[1]), 'Без ответа', 'Обрезано на лимите', 'A8', 'S8', 'P8', 'Пометка'],
      sorted(borderline).map((row) => [
        `\`${row.id}\``, BLOCK_LABELS[row.block] || row.block, `${row.right}/${row.n}`, `${row.rightB}/${row.nB}`,
        ...others.map((model) => mark(row.others.find((item) => item.model === model)?.right)),
        row.noAnswer, row.cutAtCap, mark(row.arms.A8), mark(row.arms.S8), mark(row.arms.P8), noteOf(row),
      ]),
    ),
    '',
    `### Легко-решаемые (${scored.filter((row) => row.category === 'easy').length})`,
    '',
  );
  for (const block of blocks) {
    const mine = sorted(scored.filter((row) => row.block === block && row.category === 'easy'));
    const wrongArms = mine.filter((row) => row.arms.A8 === 0 || row.arms.S8 === 0);
    push(`- **${BLOCK_LABELS[block] || block}** (${mine.length}): ${mine.map((row) => row.id.replace(/^test:/, '')).join(', ')}`);
    if (wrongArms.length) {
      push(`  - из них рука ошиблась: ${wrongArms.map((row) => `${row.id.replace(/^test:/, '')} (A8 ${mark(row.arms.A8)}, S8 ${mark(row.arms.S8)})`).join(', ')}`);
    }
    const noted = mine.filter((row) => noteOf(row));
    if (noted.length) push(`  - пометки: ${noted.map((row) => `${row.id.replace(/^test:/, '')} (${noteOf(row)})`).join(', ')}`);
  }
  const excludedRows = main.rows.filter((row) => row.excluded);
  push(
    '',
    `### Исключены из счёта (${excludedRows.length})`,
    '',
    ...excludedRows.map((row) => `- \`${row.id}\`: ${data.goldInForce.excluded.get(row.id)}`),
    '',
    '## Проверки и ограничения',
    '',
    `- Первая выборка B и ответ B в Stage 1 — один и тот же вызов; расхождений в ${MAIN_RUN}: ${checks.bSampleIsStage1Mismatch}.`,
    `- Повторная оценка текстов выборок тем же грейдером дала тот же ответ, что сохранён: ${checks.regradedSamples - checks.regradeMismatch} из ${checks.regradedSamples}.`,
    `- Ответы из журнала вызовов (оценены заново по тексту) совпали с ответами в записи вопроса: ${checks.journalQuestions - checks.journalMismatch} из ${checks.journalQuestions} вопросов.`,
    `- Точность рук на новых блоках по этим же строкам: ${['A8', 'S8', 'P8', 'B8'].map((arm) => `${arm} ${pct(scored.filter((row) => primary(row) && row.arms[arm] === 1).length, scored.filter(primary).length)}`).join(', ')} (${scored.filter(primary).length} вопросов).`,
    `- В прежних кампаниях ответ первой выборки, оценённый заново, расходится с сохранённым B8 в ${checks.oldSample1Mismatch} вопросах; его нет в подсчёте голосов совета в ${checks.oldTallyMismatch}.`,
    '- В тесте пять попыток из семи принадлежат одной модели, поэтому «все попытки верны» в основном означает «B устойчиво верен».',
    '- В прежних кампаниях (v4, strong) ответы других моделей совета восстановлены из подсчёта голосов без имён моделей; вопрос с неполным советом учитывается только по выборкам B.',
    '- Прогон `main` (бесплатные модели) в расчёт не входит.',
    '',
  );
  return lines.join('\n');
}

// The part of the README block about categories. tools/sample_count.js adds
// its own part and places the whole block.
function buildReadme(data) {
  const { main, arxiv, dev, pools, slack, sensitivity } = data;
  const scored = main.rows.filter((row) => !row.excluded);
  const primary = (row) => !['aime', 'gpqa', 'mmlu'].includes(row.block);
  const legacy = (row) => !primary(row);
  const others = main.selection.council.filter((model) => model !== main.selection.b);
  const size = scored[0]?.n || 0;
  const bare = (id) => id.replace(/^test:/, '');
  const sorted = (rows) => [...rows].sort((left, right) => blockRank(left.block) - blockRank(right.block) || left.id.localeCompare(right.id));
  const noteOf = (row) => [
    row.goldCorrected ? 'эталон исправлен' : null,
    sensitivity.gold.has(row.id) && !row.goldCorrected ? 'эталон оспорен в расширенном списке' : null,
    sensitivity.excluded.has(row.id) ? 'исключён в расширенном списке' : null,
  ].filter(Boolean).join('; ');
  const borderline = scored.filter((row) => row.category === 'borderline');
  const unsolved = sorted(scored.filter((row) => row.category === 'unsolved'));
  const answered = arxiv.rows.filter((row) => row.n > 0);
  const count = (rows, name) => rows.filter((row) => row.category === name).length;
  const lines = [
    '#### Категории вопросов',
    '',
    `Попытка — один ответ одной модели на вопрос. В тесте ${MAIN_RUN} это 5 выборок B = \`${main.selection.b}\` и по одному ответу Stage 1 от ${others.map((model) => `\`${model}\``).join(' и ')}, лимит ${main.caps?.sample ?? '?'} токенов на вызов. A8, S8 и P8 собраны из этих же ответов и попытками не считаются. Попытка верна, если её канонический ответ равен эталону с исправлениями из \`${GOLD_FILE}\`; ответ без читаемой последней строки неверен. ${slack === 0
      ? 'Легко-решаемый вопрос: верны все попытки. Не-решаемый: не верна ни одна. Пограничный: часть верна, часть нет.'
      : `Легко-решаемый вопрос: верных попыток не меньше n − ${slack}. Не-решаемый: не больше ${slack}. Пограничный: всё остальное.`} Категория относится к этим моделям при этом лимите, а не к вопросу вообще. В тесте пять попыток из ${size} принадлежат одной модели.`,
    '',
    ...byBlockTable(scored, [['Новые блоки', primary], ['Прежние блоки', legacy], ['Всего', () => true]]),
    '',
    `Верных попыток из ${size}: ${Array.from({ length: size + 1 }, (_, value) => `${value} — ${scored.filter((row) => row.right === value).length}`).join(', ')} вопросов.`,
    '',
    ...table(
      ['Категория', 'Вопросов', 'Попыток', 'Верно', 'Неверный ответ', 'Нет читаемого ответа', 'Из них обрезано на лимите'],
      CATEGORIES.map((name) => {
        const mine = scored.filter((row) => row.category === name);
        const sum = (field) => mine.reduce((total, row) => total + row[field], 0);
        return [CATEGORY_RU[name], mine.length, sum('n'), sum('right'), sum('wrongAnswer'), sum('noAnswer'), sum('cutNoAnswer')];
      }),
    ),
    '',
    `Пограничные вопросы (${borderline.length}): ${Object.keys(SUBTYPE_RU).map((name) => `${SUBTYPE_RU[name]} — ${borderline.filter((row) => row.subtype === name).length}`).join('; ')}.`,
    '',
    'Верных ответов руки внутри категории. «A8 > S8» — вопросы, где A8 верна, а S8 нет; «S8 > A8» — наоборот.',
    '',
  ];
  const armRows = [];
  for (const [label, test] of [['Новые блоки', primary], ['Прежние блоки', legacy]]) {
    for (const name of CATEGORIES) {
      const mine = scored.filter((row) => test(row) && row.category === name);
      const hits = (arm) => mine.filter((row) => row.arms[arm] === 1).length;
      armRows.push([
        label, CATEGORY_RU[name], mine.length, hits('A8'), hits('S8'), hits('P8'), hits('B8'),
        mine.filter((row) => row.arms.A8 === 1 && row.arms.S8 === 0).length,
        mine.filter((row) => row.arms.A8 === 0 && row.arms.S8 === 1).length,
      ]);
    }
  }
  lines.push(
    ...table(['Набор', 'Категория', 'Вопросов', 'A8', 'S8', 'P8', 'B8', 'A8 > S8', 'S8 > A8'], armRows),
    '',
    `Не-решаемые (${unsolved.length}):`,
    '',
    ...table(
      ['Вопрос', 'Ответы попыток', 'Эталон', 'Обрезано на лимите', 'A8', 'S8', 'Пометка'],
      unsolved.map((row) => [
        `\`${bare(row.id)}\``, row.tally.map(([answer, total]) => `${short(answer)}×${total}`).join(', '), short(row.gold),
        row.cutAtCap, mark(row.arms.A8), mark(row.arms.S8), noteOf(row),
      ]),
    ),
    '',
    `Пограничные (${borderline.length}), в скобках верных попыток из ${size}: ${sorted(borderline).map((row) => `\`${bare(row.id)}\` (${row.right})`).join(', ')}.`,
    '',
    `Остальные ${count(scored, 'easy')} из ${scored.length} вопросов легко-решаемые. Вопросов, исключённых тем же файлом исправлений и не вошедших в счёт: ${main.rows.length - scored.length}.`,
    '',
    `ArXivMath, тест ${ARXIV_RUN}: ни один из ${arxiv.rows.length} вопросов не закончен, поэтому категории предварительные. Пришло ${arxiv.rows.reduce((sum, row) => sum + row.n, 0)} попыток, от ${Math.min(...arxiv.rows.map((row) => row.n))} до ${Math.max(...arxiv.rows.map((row) => row.n))} на вопрос, из них обрезано на лимите ${arxiv.finish.length || 0}. Не-решаемых ${count(answered, 'unsolved')}, пограничных ${count(answered, 'borderline')}, легко-решаемых ${count(answered, 'easy')}. Эталоны ArXivMath не перепроверялись.`,
    '',
    `Dev (пять моделей-кандидатов по одной попытке, ${dev.length} вопросов): легко-решаемых ${count(dev, 'easy')}, пограничных ${count(dev, 'borderline')}, не-решаемых ${count(dev, 'unsolved')}.`,
    '',
    'Те же прежние вопросы при другом составе попыток (строки — категория в этом разборе, столбцы — в другой кампании):',
    '',
  );
  for (const pool of pools) {
    const tab = crossTab(scored.filter(legacy), pool.rows);
    lines.push(
      `\`${pool.run}\` — ${pool.label}: B = \`${pool.selection.b}\`, совет ${pool.selection.council.map((model) => `\`${model}\``).join(', ')}, лимит ${pool.caps?.sample ?? '?'}. Общих вопросов ${tab.pairs}, категория совпала в ${tab.same}.`,
      '',
      ...table([`${MAIN_RUN} \\ ${pool.run}`, ...CATEGORIES.map((name) => CATEGORY_RU[name])], tab.body),
      '',
    );
  }
  return lines.join('\n').replace(/\n+$/, '');
}

function csv(rows) {
  const header = ['id', 'split', 'block', 'source', 'n', 'right', 'no_answer', 'cut_at_cap', 'n_b', 'right_b', 'category', 'subtype', 'A8', 'S8', 'P8', 'B8', 'gold_corrected', 'excluded'];
  const cell = (value) => (value == null ? '' : /[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
  return [header.join(','), ...rows.map((row) => [
    row.id, row.split, row.block, row.source, row.n, row.right, row.noAnswer, row.cutAtCap, row.nB, row.rightB, row.category, row.subtype,
    row.arms?.A8, row.arms?.S8, row.arms?.P8, row.arms?.B8, row.goldCorrected ? 1 : 0, row.excluded ? 1 : 0,
  ].map(cell).join(','))].join('\n');
}

function main(argv) {
  const slack = Number(flag(argv, '--slack', '0'));
  if (!Number.isInteger(slack) || slack < 0) throw new Error('--slack takes a whole number, 0 or more');
  const outDir = path.resolve(flag(argv, '--out', path.join(RUNS, 'question-difficulty')));
  const tasks = loadTasks();
  const goldInForce = loadGold(tasks, GOLD_FILE);
  const sensitivity = loadGold(tasks, GOLD_SENSITIVITY_FILE);
  const checks = {
    bSampleIsStage1Mismatch: 0, regradedSamples: 0, regradeMismatch: 0,
    journalQuestions: 0, journalMismatch: 0, oldSample1Mismatch: 0, oldTallyMismatch: 0,
  };

  const main_ = fromStoredAnswers(MAIN_RUN, tasks, goldInForce, slack, checks);
  main_.rows = withFinishReasons(MAIN_RUN, main_.rows, tasks, goldInForce, checks);
  main_.caps = capsOf(MAIN_RUN);
  const arxiv = fromSlots(ARXIV_RUN, tasks, slack);
  const dev = DEV_RUNS.flatMap((item) => fromDev(item.run, item.blocks, slack));
  const pools = OTHER_POOLS.map((pool) => ({ ...pool, caps: capsOf(pool.run), ...fromTexts(pool.run, tasks, goldInForce, slack, checks) }));

  const data = { main: main_, arxiv, dev, pools, slack, checks, goldInForce, sensitivity };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'report.md'), buildReport(data));
  writeFileSync(path.join(outDir, 'readme-categories.md'), `${buildReadme(data)}\n`);
  writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify({
    rule: { slack, easy: `right >= n - ${slack}`, unsolved: `right <= ${slack}` },
    sources: { test: MAIN_RUN, gold: GOLD_FILE, arxiv: ARXIV_RUN, dev: DEV_RUNS, otherPools: OTHER_POOLS.map((pool) => pool.run) },
    checks,
    test: main_.rows,
    arxiv: arxiv.rows,
    arxivFinish: arxiv.finish,
    dev,
    otherPools: Object.fromEntries(pools.map((pool) => [pool.run, pool.rows])),
  }, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'questions.csv'), `${csv([
    ...main_.rows.map((row) => ({ ...row, source: `${MAIN_RUN} test` })),
    ...arxiv.rows.map((row) => ({ ...row, source: `${ARXIV_RUN} test (partial)` })),
    ...dev.map((row) => ({ ...row, source: `${row.run} dev` })),
  ])}\n`);

  const scored = main_.rows.filter((row) => !row.excluded);
  console.log(JSON.stringify({
    out: outDir,
    slack,
    test: { questions: scored.length, ...countBy(scored, (row) => row.category) },
    arxiv: { questions: arxiv.rows.length, ...countBy(arxiv.rows, (row) => row.category) },
    dev: { questions: dev.length, ...countBy(dev, (row) => row.category) },
    checks,
  }, null, 2));
}

main(process.argv.slice(2));
