// How the number of B samples changes the answer on the stored test questions.
// Offline: reads report.json written by tools/question_difficulty.js, makes no
// call. Not part of the hashed method. Exploratory: nothing here was
// pre-registered, and the p values are not corrected across sets.
//
//   node eval/tools/question_difficulty.js
//   node eval/tools/sample_count.js
//
// What is measured:
//   vote of k   plurality over k of B's five stored answers, by the P8 rule: an
//               answer with no readable final line abstains, no vote at all is
//               wrong. For a fixed set of samples a tie breaks by the campaign's
//               seeded hash. For the average over all sets of k samples a tie
//               earns the share 1/t when the gold is among the t tied answers.
//   S8          the stored synthesis of all five samples. S8 on fewer samples
//               was never run, so the vote stands in for it there.
//   p           exact two-sided McNemar on one answer per question, on sets
//               that were not chosen by the answers being compared.
//   held out    borderline questions picked by attempts that are not scored:
//               two B samples and the two other council models pick, the other
//               three B samples are scored.
// Nothing here says what more than five samples would give: the stored data
// holds five per question.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_BLOCKS } from '../a8Blocks.js';
import { plurality } from '../grade.js';
import { mdTable as table, placeAfter, rewriteFile } from '../noteTools.js';
import { PLURALITY_SEED } from '../protocol.js';
import { holm, mcnemarExact } from '../report.js';
import { compareHash } from '../util.js';

const EVAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(EVAL_ROOT, '.runs', 'question-difficulty');
const README = path.join(EVAL_ROOT, 'README.md');
const README_START = '<!-- question-difficulty:start -->';
const README_END = '<!-- question-difficulty:end -->';
// The block goes after the last block of the README at the time it was added.
const README_AFTER = '<!-- a8-open-v6:end -->';
const THEORY_P = [0.55, 0.6, 0.7, 0.8, 0.9];
const THEORY_K = [1, 3, 5, 7, 9, 15, 25, 51, 101];
const TARGET = 0.95;
const POWER = 0.8;

const pct = (value) => `${(100 * value).toFixed(1)}%`;

function subsets(size, pick) {
  const out = [];
  const walk = (start, chosen) => {
    if (chosen.length === pick) {
      out.push(chosen);
      return;
    }
    for (let index = start; index < size; index += 1) walk(index + 1, [...chosen, index]);
  };
  walk(0, []);
  return out;
}

// Expected credit of a vote when a tie is broken at random.
function credit(answers, gold) {
  const votes = new Map();
  for (const answer of answers) {
    if (answer != null) votes.set(answer, (votes.get(answer) || 0) + 1);
  }
  if (!votes.size) return 0;
  const max = Math.max(...votes.values());
  const tied = [...votes.keys()].filter((key) => votes.get(key) === max);
  return tied.includes(gold) ? 1 / tied.length : 0;
}

// The campaign's own vote over a fixed list of answers, and whether a tie
// decided it.
function fixedVote(row, answers) {
  const grades = answers.map((answer) => ({ status: answer == null ? 'parse_error' : 'graded', extracted: answer }));
  const pick = (tied) => [...tied].sort((left, right) => compareHash(`${PLURALITY_SEED}\n${row.id}`, left, right))[0];
  const vote = plurality(grades, pick);
  return { right: vote.status === 'graded' && vote.extracted === row.gold ? 1 : 0, tie: Boolean(vote.tie) };
}

// A question where one sample is right with probability p and every wrong
// sample gives the same wrong answer: the chance that most of k are right.
function majority(p, k) {
  let sum = 0;
  let coefficient = 1;
  for (let right = 0; right <= k; right += 1) {
    if (right > 0) coefficient = (coefficient * (k - right + 1)) / right;
    if (right * 2 > k) sum += coefficient * (p ** right) * ((1 - p) ** (k - right));
  }
  return sum;
}

// The most wins the weaker arm can have among `pairs` discordant questions
// while the exact two-sided McNemar test still gives p < 0.05 (-1: never).
// p only grows with those wins, so a binary search finds the cut a scan from
// zero would; it does not depend on the share, so it is kept per count.
const cuts = new Map();
function mcnemarCut(pairs) {
  if (!cuts.has(pairs)) {
    let low = -1;
    let high = Math.floor(pairs / 2);
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (mcnemarExact(mid, pairs - mid).p < 0.05) low = mid;
      else high = mid - 1;
    }
    cuts.set(pairs, low);
  }
  return cuts.get(pairs);
}

// Exact power of the two-sided McNemar test at 0.05 when `pairs` questions
// disagree and the weaker arm takes the share `share` of them.
function mcnemarPower(pairs, share) {
  const cut = mcnemarCut(pairs);
  if (cut < 0) return 0;
  let power = 0;
  let mass = (1 - share) ** pairs;
  for (let wins = 0; wins <= pairs; wins += 1) {
    if (wins > 0) mass *= ((pairs - wins + 1) / wins) * (share / (1 - share));
    if (wins <= cut || wins >= pairs - cut) power += mass;
  }
  return power;
}

// The power of an exact test moves up and down with the number of pairs, so
// the answer is the count from which it no longer falls below the target.
function pairsNeeded(share, limit = 1200) {
  for (let pairs = limit; pairs >= 1; pairs -= 1) {
    if (mcnemarPower(pairs, share) < POWER) return pairs === limit ? null : pairs + 1;
  }
  return 1;
}

// Clopper-Pearson 95% interval for a share.
function exactInterval(hits, total) {
  const cdf = (p, upTo) => {
    let sum = 0;
    let coefficient = 1;
    for (let index = 0; index <= upTo; index += 1) {
      if (index > 0) coefficient = (coefficient * (total - index + 1)) / index;
      sum += coefficient * (p ** index) * ((1 - p) ** (total - index));
    }
    return sum;
  };
  const solve = (test) => {
    let low = 0;
    let high = 1;
    for (let step = 0; step < 60; step += 1) {
      const mid = (low + high) / 2;
      if (test(mid)) low = mid;
      else high = mid;
    }
    return low;
  };
  return {
    low: hits === 0 ? 0 : solve((p) => 1 - cdf(p, hits - 1) < 0.025),
    high: hits === total ? 1 : solve((p) => cdf(p, hits) > 0.025),
  };
}

// Paired comparison of two arms. `left` and `right` return { right, tie }.
function compare(rows, left, right) {
  let wins = 0;
  let losses = 0;
  let winsNoTie = 0;
  let lossesNoTie = 0;
  let ties = 0;
  for (const row of rows) {
    const a = left(row);
    const b = right(row);
    if (a.tie || b.tie) ties += 1;
    if (a.right === 1 && b.right === 0) {
      wins += 1;
      if (!a.tie && !b.tie) winsNoTie += 1;
    }
    if (a.right === 0 && b.right === 1) {
      losses += 1;
      if (!a.tie && !b.tie) lossesNoTie += 1;
    }
  }
  return {
    n: rows.length, wins, losses, ties, delta: (wins - losses) / rows.length,
    p: mcnemarExact(wins, losses).p,
    winsNoTie, lossesNoTie, pNoTie: mcnemarExact(winsNoTie, lossesNoTie).p,
  };
}

function main() {
  const report = JSON.parse(readFileSync(path.join(DIR, 'report.json'), 'utf8'));
  const arm = (value) => ({ right: value, tie: false });
  const rows = report.test.filter((row) => !row.excluded).map((row) => {
    const answers = row.bAnswers;
    const byK = {};
    const first = {};
    for (let k = 1; k <= answers.length; k += 1) {
      const sets = subsets(answers.length, k);
      byK[k] = sets.reduce((sum, set) => sum + credit(set.map((index) => answers[index]), row.gold), 0) / sets.length;
      first[k] = fixedVote(row, answers.slice(0, k));
    }
    return { ...row, byK, first, otherAnswers: row.others.map((item) => item.answer) };
  });

  const checks = {
    vote5EqualsStored: rows.filter((row) => row.first[5].right === row.storedVote5).length,
    sample1EqualsB8: rows.filter((row) => row.first[1].right === row.arms.B8).length,
    questions: rows.length,
  };

  const whole = [
    ['Новые блоки', rows.filter((row) => !LEGACY_BLOCKS.includes(row.block))],
    ['Прежние блоки', rows.filter((row) => LEGACY_BLOCKS.includes(row.block))],
    ['Все вопросы', rows],
  ];
  const borderline = rows.filter((row) => row.category === 'borderline');
  const mean = (list, valueOf) => list.reduce((sum, row) => sum + valueOf(row), 0) / list.length;
  const ks = [1, 2, 3, 4, 5];
  const accuracyHeader = ['Набор', 'Вопросов', ...ks.map((k) => (k === 1 ? 'одна выборка' : `голос ${k}`)), 'S8 (синтез 5)', 'A8'];
  const accuracyRow = ([label, list]) => [
    label, list.length, ...ks.map((k) => pct(mean(list, (row) => row.byK[k]))),
    pct(mean(list, (row) => row.arms.S8)), pct(mean(list, (row) => row.arms.A8)),
  ];

  // Borderline by attempts that are not scored.
  const size = rows[0].bAnswers.length;
  const everything = Array.from({ length: size }, (_, index) => index);
  const triples = subsets(size, 3);
  const heldOut = (scored) => {
    const pickers = everything.filter((index) => !scored.includes(index));
    const group = { borderline: [], easy: [], unsolved: [] };
    for (const row of rows) {
      const picking = pickers.map((index) => row.bAnswers[index]).concat(row.otherAnswers);
      const right = picking.filter((answer) => answer != null && answer === row.gold).length;
      group[right === picking.length ? 'easy' : right === 0 ? 'unsolved' : 'borderline'].push(row);
    }
    const single = (list) => (list.length
      ? list.reduce((sum, row) => sum + scored.filter((index) => row.bAnswers[index] === row.gold).length, 0) / (list.length * scored.length)
      : null);
    return {
      pickers,
      n: group.borderline.length,
      single: single(group.borderline),
      vote: mean(group.borderline, (row) => credit(scored.map((index) => row.bAnswers[index]), row.gold)),
      test: compare(
        group.borderline,
        (row) => fixedVote(row, scored.map((index) => row.bAnswers[index])),
        (row) => fixedVote(row, [row.bAnswers[scored[0]]]),
      ),
      easyN: group.easy.length, easySingle: single(group.easy),
      unsolvedN: group.unsolved.length, unsolvedSingle: single(group.unsolved),
    };
  };
  // The first of the splits scores samples 1, 2, 3: the fixed split.
  const allSplits = triples.map((scored) => heldOut(scored));
  const fixedSplit = allSplits[0];
  const average = (valueOf) => allSplits.reduce((sum, item) => sum + valueOf(item), 0) / allSplits.length;

  const lines = [
    '# Сколько выборок B нужно для S8',
    '',
    'Построено кодом `eval/tools/sample_count.js` из `report.json` (тест a8-open-v5e, эталоны исправленные). Новых вызовов нет. Разбор поисковый: он не был записан заранее, p не поправлены на число наборов.',
    '',
    '## Что считается',
    '',
    '- «Голос k» — большинство по k из пяти сохранённых ответов B по правилу P8: ответ без читаемой последней строки воздерживается, без единого голоса ответ неверен.',
    '- S8 измерен только на пяти выборках. Для 1–4 выборок вместо синтеза стоит голос; синтез на меньшем числе выборок не запускался, и по этим данным о нём сказать нельзя.',
    '- Про число выборок больше пяти эти данные не говорят ничего: на вопрос сохранено пять.',
    '- p — точный двусторонний тест Макнемара, один ответ на вопрос. Он считается только на наборах, которые не отобраны по сравниваемым ответам.',
    '',
    '## Точность по числу выборок',
    '',
    'Голос k — среднее по всем наборам из k выборок (ничья даёт долю 1/t). S8 и A8 — сохранённые руки.',
    '',
    ...table(accuracyHeader, whole.map(accuracyRow)),
    '',
    'Те же числа на пограничных вопросах. Эти вопросы отобраны по тем же выборкам, поэтому строка только описывает данные: вопросы, где голос пяти неверен, почти все ушли в не-решаемые, а где верны все выборки — в легко-решаемые.',
    '',
    ...table(
      accuracyHeader,
      [accuracyRow(['Пограничные', borderline]), accuracyRow(['Пограничные, где выборки B расходятся', rows.filter((row) => row.subtype === 'b_split')])],
    ),
    '',
    '## Пограничные вопросы, отобранные по другим попыткам',
    '',
    'Чтобы отбор не зависел от оцениваемых ответов, вопрос назван пограничным по двум выборкам B и ответам двух других моделей совета (верны не все четыре и не ноль), а оцениваются три оставшиеся выборки B.',
    '',
    ...table(
      ['Отбор', 'Пограничных вопросов', 'Одна выборка', 'Голос трёх', 'Голос трёх против одной: выигрыши / проигрыши', 'p', 'p без вопросов с ничьей'],
      [
        [
          `по выборкам ${fixedSplit.pickers.map((index) => index + 1).join(', ')}; оцениваются 1, 2, 3`,
          fixedSplit.n, pct(fixedSplit.single), pct(fixedSplit.vote),
          `${fixedSplit.test.wins} / ${fixedSplit.test.losses}`, fixedSplit.test.p.toFixed(4), fixedSplit.test.pNoTie.toFixed(4),
        ],
        [
          `среднее по ${allSplits.length} способам отложить три выборки`,
          average((item) => item.n).toFixed(1), pct(average((item) => item.single)), pct(average((item) => item.vote)), '—', '—', '—',
        ],
      ],
    ),
    '',
    `Для сравнения, в среднем по тем же ${allSplits.length} разбиениям: на вопросах, где все четыре отбирающие попытки верны (${average((item) => item.easyN).toFixed(1)} вопросов), новая выборка B верна в ${pct(average((item) => item.easySingle))}; где не верна ни одна (${average((item) => item.unsolvedN).toFixed(1)} вопросов) — в ${pct(average((item) => item.unsolvedSingle))}.`,
    '',
    '## p по Макнемару',
    '',
    'Фиксированные выборки в порядке кампании: «голос 1–3» — выборки 1, 2, 3; «выборка 1» — это рука B8. В столбце p ничья решена seeded hash кампании; в соседнем столбце вопросы с ничьей выброшены. Поправка Холма — по семи сравнениям внутри набора.',
    '',
  ];
  const pairs = [
    ['голос 1–3 против выборки 1', (row) => row.first[3], (row) => row.first[1]],
    ['голос 1–5 против выборки 1', (row) => row.first[5], (row) => row.first[1]],
    ['голос 1–5 против голоса 1–3', (row) => row.first[5], (row) => row.first[3]],
    ['S8 против выборки 1', (row) => arm(row.arms.S8), (row) => row.first[1]],
    ['S8 против голоса 1–3', (row) => arm(row.arms.S8), (row) => row.first[3]],
    ['S8 против голоса 1–5', (row) => arm(row.arms.S8), (row) => row.first[5]],
    ['A8 против S8', (row) => arm(row.arms.A8), (row) => arm(row.arms.S8)],
  ];
  const tests = [];
  for (const [label, list] of whole) {
    const family = pairs.map(([name, left, right]) => ({ set: label, pair: name, ...compare(list, left, right) }));
    const adjusted = holm(family.map((item) => item.p));
    family.forEach((item, index) => tests.push({ ...item, holm: adjusted[index] }));
  }
  const mcnemarTable = table(
    ['Набор', 'Сравнение', 'Вопросов', 'Δ', 'Выигрыши / проигрыши', 'p', 'p по Холму', 'Без ничьих: выигрыши / проигрыши', 'p без ничьих'],
    tests.map((item) => [
      item.set, item.pair, item.n, `${(100 * item.delta).toFixed(1)} п.п.`, `${item.wins} / ${item.losses}`, item.p.toFixed(4), item.holm.toFixed(4),
      `${item.winsNoTie} / ${item.lossesNoTie}`, item.pNoTie.toFixed(4),
    ]),
  );
  lines.push(...mcnemarTable);

  // The fixed samples above are one choice among several. Every other choice.
  const voteOf = (indexes) => (row) => fixedVote(row, indexes.map((index) => row.bAnswers[index]));
  const tripleVsMember = triples.flatMap((triple) => triple.map((member) => compare(rows, voteOf(triple), voteOf([member]))));
  const fiveVsSingle = everything.map((member) => compare(rows, voteOf(everything), voteOf([member])));
  const fiveVsTriple = triples.map((triple) => compare(rows, voteOf(everything), voteOf(triple)));
  const span = (list, valueOf, digits = 0) => `${Math.min(...list.map(valueOf)).toFixed(digits)}–${Math.max(...list.map(valueOf)).toFixed(digits)}`;
  const spread = (label, list) => [
    label, list.length, span(list, (item) => item.winsNoTie), span(list, (item) => item.lossesNoTie),
    span(list, (item) => item.pNoTie, 4), list.filter((item) => item.pNoTie < 0.05).length,
  ];
  const robustTable = table(
    ['Сравнение', 'Вариантов', 'Выигрыши', 'Проигрыши', 'p', 'Вариантов с p < 0,05'],
    [
      spread('голос любых трёх против одной из них', tripleVsMember),
      spread('голос пяти против любой одной', fiveVsSingle),
      spread('голос пяти против голоса любых трёх', fiveVsTriple),
    ],
  );
  lines.push(
    '',
    'Те же сравнения при любом выборе выборок, все вопросы, вопросы с ничьей выброшены:',
    '',
    ...robustTable,
    '',
    'Сколько из пяти выборок B верны на пограничных вопросах (описание данных, не проверка):',
    '',
    ...table(
      ['Верных выборок B', 'Вопросов', 'Голос 1–5 верен', 'S8 верна', 'A8 верна'],
      [5, 4, 3, 2, 1, 0].map((count) => {
        const list = borderline.filter((row) => row.rightB === count);
        return [`${count}/5`, list.length, list.filter((row) => row.first[5].right === 1).length, list.filter((row) => row.arms.S8 === 1).length, list.filter((row) => row.arms.A8 === 1).length];
      }).filter((cells) => cells[1] > 0),
    ),
    '',
    '## Один вопрос: сколько выборок нужно большинству',
    '',
    `Расчёт по формуле, без данных и без p: одна выборка верна с вероятностью p, выборки независимы, все неверные дают один и тот же неверный ответ (худший случай для голоса). В ячейке — вероятность, что большинство из k верно. Последний столбец — наименьшее нечётное k с вероятностью не ниже ${pct(TARGET)}. В данных неверная выборка чаще воздерживается, чем даёт неверный ответ, поэтому там голосу нужно меньше.`,
    '',
    ...table(
      ['p одной выборки', ...THEORY_K.map((k) => `k = ${k}`), `k для ${pct(TARGET)}`],
      THEORY_P.map((p) => {
        let need = null;
        for (let k = 1; k <= 2001; k += 2) {
          if (majority(p, k) >= TARGET) {
            need = k;
            break;
          }
        }
        return [p, ...THEORY_K.map((k) => pct(majority(p, k))), need ?? '> 2001'];
      }),
    ),
    '',
  );

  const armPair = compare(rows, (row) => arm(row.arms.A8), (row) => arm(row.arms.S8));
  const discordant = armPair.wins + armPair.losses;
  const rate = exactInterval(discordant, rows.length);
  const powerText = `p в паре зависит от числа вопросов, где руки разошлись. В этом тесте A8 и S8 разошлись на ${discordant} из ${rows.length} вопросов (${armPair.wins} в пользу A8, ${armPair.losses} в пользу S8, p = ${armPair.p.toFixed(4)}); 95% интервал для доли расхождений ${pct(rate.low)}–${pct(rate.high)}. Ниже — число расхождений, начиная с которого точный тест Макнемара даёт p < 0,05 с вероятностью не ниже ${pct(POWER)}, если слабая рука берёт указанную долю расхождений. Доли — сценарии, а не оценки: наблюдённое разбиение ${armPair.wins} к ${armPair.losses} совместимо и с равенством рук. Число вопросов пересчитано по наблюдённой доле расхождений и по краям её интервала.`;
  const powerTable = table(
    ['Доля расхождений у слабой руки', 'Нужно расхождений', 'Вопросов такого же состава', 'Диапазон по интервалу'],
    [0.4, 1 / 3, 0.25, 0.2, 0.1].map((share) => {
      const need = pairsNeeded(share);
      if (need == null) return [share.toFixed(2), '> 1200', '—', '—'];
      return [
        share.toFixed(2), need, Math.ceil(need / (discordant / rows.length)),
        `${Math.ceil(need / rate.high)}–${Math.ceil(need / rate.low)}`,
      ];
    }),
  );
  lines.push(
    '## Сколько вопросов нужно паре A8 против S8',
    '',
    powerText,
    '',
    ...powerTable,
    '',
    '## Проверки',
    '',
    `- Голос по выборкам 1–5, посчитанный здесь, совпал с сохранённым в кампании: ${checks.vote5EqualsStored} из ${checks.questions}.`,
    `- Выборка 1 совпала с рукой B8: ${checks.sample1EqualsB8} из ${checks.questions}.`,
    '',
  );

  // The README block: the categories part written by question_difficulty.js,
  // then the part about the number of samples.
  const readmeSamples = [
    '#### Число выборок B',
    '',
    '«Голос k» — большинство по k из пяти сохранённых ответов B по правилу P8 (ответ без читаемой последней строки воздерживается), среднее по всем наборам из k выборок. S8 измерен только на пяти выборках: синтез на меньшем числе выборок не запускался, вместо него стоит голос. Про число выборок больше пяти эти данные ничего не говорят.',
    '',
    ...table(accuracyHeader, whole.map(accuracyRow)),
    '',
    `Пограничные вопросы отобраны по тем же ответам, поэтому точность и p на них не считаются проверкой. Для проверки вопрос назван пограничным по попыткам, которые не оцениваются: по двум выборкам B и ответам двух других моделей совета (верны не все четыре и не ноль), а оцениваются три оставшиеся выборки B. При отборе по выборкам ${fixedSplit.pickers.map((index) => index + 1).join(' и ')} таких вопросов ${fixedSplit.n}: одна выборка верна в ${pct(fixedSplit.single)}, голос трёх — в ${pct(fixedSplit.vote)}; голос выборок 1–3 против выборки 1 — ${fixedSplit.test.wins} / ${fixedSplit.test.losses}, p = ${fixedSplit.test.p.toFixed(4)} (без вопросов с ничьей ${fixedSplit.test.winsNoTie} / ${fixedSplit.test.lossesNoTie}, p = ${fixedSplit.test.pNoTie.toFixed(4)}). В среднем по ${allSplits.length} способам отложить три выборки: ${average((item) => item.n).toFixed(1)} вопросов, одна выборка ${pct(average((item) => item.single))}, голос трёх ${pct(average((item) => item.vote))}. Там, где все четыре отбирающие попытки верны, новая выборка B верна в ${pct(average((item) => item.easySingle))}; где не верна ни одна — в ${pct(average((item) => item.unsolvedSingle))}.`,
    '',
    'Точный двусторонний тест Макнемара, один ответ на вопрос. «Голос 1–3» — выборки 1, 2, 3 в порядке кампании; «выборка 1» — это рука B8. В столбце p ничья решена seeded hash кампании, в последних столбцах вопросы с ничьей выброшены. Поправка Холма — по семи сравнениям внутри набора.',
    '',
    ...mcnemarTable,
    '',
    'Те же сравнения при любом выборе выборок, все вопросы, вопросы с ничьей выброшены:',
    '',
    ...robustTable,
    '',
    powerText,
    '',
    ...powerTable,
    '',
    'Ограничения: разбор сделан после результатов кампании и не был записан заранее; сравнения по числу выборок, отбор по отложенным попыткам и объединение новых и прежних блоков выбраны после первых подсчётов; p не поправлены на число наборов; тест Макнемара считает вопросы независимыми, а вопросы одного шаблона reasoning-gym могут быть зависимы; в `a8-open-v4` и `a8-strong-v1` ответы других моделей совета восстановлены из подсчёта голосов без имён моделей; прогон `main` на бесплатных моделях не входит. Это диагностика.',
  ].join('\n');
  const block = [
    '### Категории вопросов и число выборок B (`question-difficulty`)',
    '',
    'Разбор сохранённых ответов теста `a8-open-v5e` и остановленного `a8-open-v6`. Новых вызовов нет: категории и числа посчитаны кодом `tools/question_difficulty.js` и `tools/sample_count.js` по ответам, которые уже разобрал грейдер кампании. Скрипты не входят в хешируемый метод.',
    '',
    readFileSync(path.join(DIR, 'readme-categories.md'), 'utf8').replace(/\s+$/, ''),
    '',
    readmeSamples,
    '',
    'Полные отчёты со списками вопросов — `.runs/question-difficulty/report.md` и `samples.md`. Воспроизвести без сети:',
    '',
    '```bash',
    'node frontend/eval/tools/question_difficulty.js',
    'node frontend/eval/tools/sample_count.js --readme',
    '```',
  ].join('\n');

  mkdirSync(DIR, { recursive: true });
  writeFileSync(path.join(DIR, 'readme-block.md'), `${block}\n`);
  if (process.argv.includes('--readme')) {
    const placed = rewriteFile(README, (text) => placeAfter(text, README_START, README_END, block, README_AFTER));
    console.log(placed ? 'README block placed' : 'README block unchanged');
  }
  writeFileSync(path.join(DIR, 'samples.md'), lines.join('\n'));
  writeFileSync(path.join(DIR, 'samples.json'), `${JSON.stringify({
    checks,
    accuracy: [...whole, ['borderline (selected on the same samples)', borderline]].map(([label, list]) => ({
      set: label, n: list.length,
      vote: Object.fromEntries(ks.map((k) => [k, mean(list, (row) => row.byK[k])])),
      S8: mean(list, (row) => row.arms.S8), A8: mean(list, (row) => row.arms.A8),
    })),
    heldOut: { fixedSplit, meanOverSplits: { n: average((item) => item.n), single: average((item) => item.single), vote: average((item) => item.vote) } },
    tests,
    armPair: { ...armPair, discordanceInterval: rate },
  }, null, 2)}\n`);
  console.log(`wrote samples.md, samples.json and readme-block.md to ${DIR}`);
}

main();
