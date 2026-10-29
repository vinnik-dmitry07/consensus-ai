import { ALPHA, BOOTSTRAP_REPS, BOOTSTRAP_SEED, DELTA_MIN } from './protocol.js';
import { mulberry32, seedFromText } from './util.js';

export function mcnemarExact(wins, losses) {
  const discordant = wins + losses;
  if (discordant === 0) return { wins, losses, discordant, p: 1 };
  const smaller = Math.min(wins, losses);
  let coefficient = 1n;
  let sum = 1n;
  for (let index = 1; index <= smaller; index += 1) {
    coefficient = (coefficient * BigInt(discordant - index + 1)) / BigInt(index);
    sum += coefficient;
  }
  const total = 1n << BigInt(discordant);
  const doubled = sum * 2n;
  const p = doubled >= total ? 1 : Number((doubled * 1000000000000n) / total) / 1e12;
  return { wins, losses, discordant, p };
}

export function holm(pValues) {
  const ordered = pValues.map((p, index) => ({ p, index })).sort((left, right) => left.p - right.p);
  const adjusted = new Array(pValues.length);
  let running = 0;
  for (let rank = 0; rank < ordered.length; rank += 1) {
    running = Math.max(running, Math.min(1, ordered[rank].p * (pValues.length - rank)));
    adjusted[ordered[rank].index] = running;
  }
  return adjusted;
}

export function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!total) return { low: null, high: null };
  const proportion = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (proportion + z2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * total)) / total)) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  const weight = position - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function blocksOf(rows) {
  const blocks = new Map();
  for (const row of rows) {
    if (!blocks.has(row.block)) blocks.set(row.block, []);
    blocks.get(row.block).push(row);
  }
  return [...blocks.values()];
}

export function pairedBootstrap(rows, left, right, options = {}) {
  const reps = options.reps ?? BOOTSTRAP_REPS;
  const tails = options.tails || [options.tail ?? ALPHA / 2];
  const rng = mulberry32(seedFromText(`${options.seed || BOOTSTRAP_SEED}\n${left}\n${right}`));
  const blocks = blocksOf(rows);
  const samples = [];
  for (let rep = 0; rep < reps; rep += 1) {
    let correctLeft = 0;
    let correctRight = 0;
    let count = 0;
    for (const block of blocks) {
      for (let index = 0; index < block.length; index += 1) {
        const row = block[Math.floor(rng() * block.length)];
        correctLeft += row.arms[left]?.correct || 0;
        correctRight += row.arms[right]?.correct || 0;
        count += 1;
      }
    }
    samples.push(count ? (correctLeft - correctRight) / count : 0);
  }
  samples.sort((a, b) => a - b);
  const degenerate = !samples.length || samples[0] === samples[samples.length - 1];
  return tails.map((tail) => ({
    low: quantile(samples, tail),
    high: quantile(samples, 1 - tail),
    degenerate,
  }));
}

export function classifyEffect(interval, deltaMin = DELTA_MIN) {
  if (!interval || interval.degenerate || interval.low == null || interval.high == null) return 'insufficient';
  if (interval.low > deltaMin) return 'gain_exceeds_min';
  if (interval.high < deltaMin) return 'useful_gain_excluded';
  return 'insufficient';
}

function pairedCounts(rows, left, right) {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let correctLeft = 0;
  let correctRight = 0;
  for (const row of rows) {
    const a = row.arms[left]?.correct || 0;
    const b = row.arms[right]?.correct || 0;
    correctLeft += a;
    correctRight += b;
    if (a === b) ties += 1;
    else if (a > b) wins += 1;
    else losses += 1;
  }
  const n = rows.length;
  return {
    n,
    wins,
    losses,
    ties,
    correctLeft,
    correctRight,
    delta: n ? (correctLeft - correctRight) / n : null,
  };
}

function rate(rows, arm) {
  if (!rows.length) return null;
  return rows.reduce((sum, row) => sum + (row.arms[arm]?.correct || 0), 0) / rows.length;
}

function comparison(rows, left, right, familySize, seed) {
  const counts = pairedCounts(rows, left, right);
  const exact = mcnemarExact(counts.wins, counts.losses);
  const [unadjusted, adjusted] = pairedBootstrap(rows, left, right, {
    seed,
    tails: [ALPHA / 2, ALPHA / (2 * Math.max(1, familySize))],
  });
  return {
    left,
    right,
    ...counts,
    p: exact.p,
    discordant: exact.discordant,
    unadjusted,
    bonferroni: adjusted,
    unadjustedClaim: classifyEffect(unadjusted),
    familyClaim: classifyEffect(adjusted),
  };
}

function bucketReport(rows, levelOf, correctOf) {
  const levels = ['HIGH', 'MEDIUM', 'LOW', 'CONTESTED'];
  const buckets = {};
  for (const level of levels) {
    const members = rows.filter((row) => levelOf(row) === level);
    const correct = members.filter((row) => correctOf(row) === 1).length;
    buckets[level] = {
      n: members.length,
      correct,
      coverage: rows.length ? members.length / rows.length : null,
      accuracy: members.length ? correct / members.length : null,
      interval: wilsonInterval(correct, members.length),
      validated: members.length >= 5,
    };
  }
  const missing = rows.filter((row) => !levels.includes(levelOf(row))).length;
  return { buckets, missing, denominator: rows.length };
}

function transition(rows, arm) {
  const cells = {
    correct_correct: 0,
    correct_wrong: 0,
    wrong_correct: 0,
    wrong_wrong: 0,
  };
  for (const row of rows) {
    if (row.leaderCorrect == null || row.arms[arm]?.correct == null) continue;
    const from = row.leaderCorrect === 1 ? 'correct' : 'wrong';
    const to = row.arms[arm].correct === 1 ? 'correct' : 'wrong';
    cells[`${from}_${to}`] += 1;
  }
  const novel = rows.filter((row) => row.oracleCouncil === 0 && row.arms[arm]?.correct === 1).length;
  return { cells, novelWhenOracleMissed: novel, denominator: rows.length };
}

export const ARMS = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];

export const ARM_DESCRIPTIONS = {
  A0: 'Chairman model H answers the question directly',
  A1: 'Single dev-selected model B, one sample',
  A2: 'Plurality vote over five samples of B',
  A3: 'One-pass Self-MoA: H aggregates five samples of B',
  A4: 'Plurality vote over the five council Stage 1 answers',
  A5: 'Stage 2 leader: top-ranked council answer, no rewrite',
  A6: 'Full council: Stage 1, Stage 2, red team, chairman H',
  A7: 'Council without red team: Stage 1, Stage 2, chairman H',
};

const DIAGNOSTIC_MEANING = {
  'A5-A4': 'Stage 2 ranking vs plurality over the same five answers',
  'A7-A5': 'Chairman rewrite without red team vs the leader it starts from',
  'A6-A7': 'Red team effect through the whole pipeline',
  'A6-A5': 'Chairman plus red team vs the leader',
};

const COUNTED_STATUSES = ['parse_error', 'refusal', 'no_answer', 'not_run'];

export function armStatuses(rows) {
  const result = {};
  for (const arm of ARMS) {
    const counts = {
      correct: 0,
      wrong: 0,
      parse_error: 0,
      refusal: 0,
      no_answer: 0,
      not_run: 0,
      transport: 0,
      fallback: 0,
      missing: 0,
    };
    for (const row of rows) {
      const grade = row.arms?.[arm];
      if (!grade) {
        counts.missing += 1;
        continue;
      }
      if (grade.fallback) counts.fallback += 1;
      if (grade.status === 'graded') {
        if (grade.correct === 1) counts.correct += 1;
        else counts.wrong += 1;
      } else if (COUNTED_STATUSES.includes(grade.status)) {
        counts[grade.status] += 1;
      } else {
        counts.transport += 1;
      }
    }
    result[arm] = counts;
  }
  return result;
}

export function replaceSection(text, start, end, body) {
  const from = text.indexOf(start);
  if (from < 0) return null;
  const to = text.indexOf(end, from + start.length);
  if (to < 0) return null;
  return `${text.slice(0, from + start.length)}\n${body}\n${text.slice(to)}`;
}

export function analyze(rows, options = {}) {
  const scored = rows.filter((row) => row.status === 'complete' && !row.pending);
  const alternatives = options.alternatives || ['A1', 'A2', 'A3', 'A4'];
  const expected = options.expected ?? null;
  const family = alternatives.map((arm) => comparison(scored, 'A6', arm, alternatives.length, options.seed));
  const adjustedP = holm(family.map((item) => item.p));
  family.forEach((item, index) => {
    item.adjustedP = adjustedP[index];
  });
  const diagnostic = (options.diagnostic || [
    ['A5', 'A4'],
    ['A7', 'A5'],
    ['A6', 'A7'],
    ['A6', 'A5'],
  ]).map(([left, right]) => comparison(scored, left, right, 1, options.seed));
  const byBlock = {};
  for (const block of ['aime', 'gpqa', 'mmlu']) {
    const subset = scored.filter((row) => row.block === block);
    byBlock[block] = {
      n: subset.length,
      arms: Object.fromEntries(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'].map((arm) => [
        arm,
        rate(subset, arm),
      ])),
    };
  }
  const presentBlocks = ['aime', 'gpqa', 'mmlu'].filter((block) => byBlock[block].n);
  const macro = {};
  for (const arm of ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']) {
    const rates = presentBlocks.map((block) => byBlock[block].arms[arm]).filter((value) => value != null);
    macro[arm] = rates.length ? rates.reduce((sum, value) => sum + value, 0) / rates.length : null;
  }
  const oracleHits = scored.filter((row) => row.oracleCouncil === 1);
  const leaderHits = scored.filter((row) => row.leaderCorrect === 0);
  const refuted = scored.filter((row) => row.redTeamVerdict === 'REFUTED');
  const upheld = scored.filter((row) => row.redTeamVerdict === 'UPHELD');
  const contested = scored.filter((row) => row.redTeamVerdict === 'CONTESTED');
  const available = scored.filter((row) => row.availableCouncil > 0);
  const beatsAll = family.length > 0 && family.every((item) => item.familyClaim === 'gain_exceeds_min');
  const pendingCount = rows.filter((row) => row.pending || row.status === 'paused' || row.status === 'stopped').length;
  return {
    scored: scored.length,
    pending: pendingCount,
    expected,
    notStarted: expected == null ? null : Math.max(0, expected - rows.length),
    scoredByBlock: Object.fromEntries(['aime', 'gpqa', 'mmlu'].map((block) => [
      block,
      scored.filter((row) => row.block === block).length,
    ])),
    armStatus: armStatuses(scored),
    rankingFallback: scored.filter((row) => row.rankingFallback).length,
    exclusions: rows.filter((row) => row.status === 'excluded').length,
    pooled: Object.fromEntries(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'].map((arm) => [
      arm,
      rate(scored, arm),
    ])),
    macro,
    byBlock,
    weights: {
      aime: byBlock.aime.n,
      gpqa: byBlock.gpqa.n,
      mmlu: byBlock.mmlu.n,
    },
    family,
    beatsAll,
    diagnostic,
    selection: {
      leaderGivenOracle: oracleHits.length
        ? oracleHits.filter((row) => row.arms.A5?.correct === 1).length / oracleHits.length
        : null,
      oracleDenominator: oracleHits.length,
      pluralityGivenOracle: oracleHits.length
        ? oracleHits.filter((row) => row.arms.A4?.correct === 1).length / oracleHits.length
        : null,
      randomCouncil: available.length
        ? available.reduce((sum, row) => sum + (row.correctCouncil / row.availableCouncil), 0) / available.length
        : null,
      randomDenominator: available.length,
    },
    transitions: {
      A6: transition(scored, 'A6'),
      A7: transition(scored, 'A7'),
    },
    confidenceAboutLeader: bucketReport(scored, (row) => row.confidence, (row) => row.leaderCorrect),
    confidenceAboutFinal: bucketReport(scored, (row) => row.confidence, (row) => row.arms.A6?.correct),
    redTeam: {
      refuted: refuted.length,
      leaderWrongGivenRefuted: refuted.length
        ? refuted.filter((row) => row.leaderCorrect === 0).length / refuted.length
        : null,
      upheld: upheld.length,
      leaderWrongGivenUpheld: upheld.length
        ? upheld.filter((row) => row.leaderCorrect === 0).length / upheld.length
        : null,
      upheldGivenLeaderWrong: leaderHits.length
        ? upheld.filter((row) => row.leaderCorrect === 0).length / leaderHits.length
        : null,
      contested: contested.length,
      missing: scored.filter((row) => row.redTeamMissing || !row.redTeamVerdict).length,
      leaderWrongDenominator: leaderHits.length,
    },
  };
}

function pp(value) {
  if (value == null || Number.isNaN(value)) return 'n/a';
  return `${(value * 100).toFixed(2)} п.п.`;
}

function pct(value) {
  if (value == null || Number.isNaN(value)) return 'n/a';
  return `${(value * 100).toFixed(2)}%`;
}

function claimText(claim) {
  if (claim === 'gain_exceeds_min') {
    return 'Нижняя граница выше 5 п.п.: полезный выигрыш подтверждён на заявленном уровне.';
  }
  if (claim === 'useful_gain_excluded') {
    return 'Верхняя граница ниже 5 п.п.: полезный выигрыш исключён. Это не то же самое, что отсутствие любого отличия от нуля.';
  }
  return 'Недостаточно данных, чтобы подтвердить или исключить полезный выигрыш в 5 п.п. Отсутствие значимого отличия от нуля не доказывает равенство.';
}

export function renderReport(analysis, context = {}) {
  const lines = [];
  lines.push('# Ценность free-совета');
  lines.push('');
  if (!context.complete) {
    const expected = analysis.expected ?? 120;
    lines.push(`Измерение не завершено: в знаменателе ${analysis.scored} завершённых вопросов из ${expected}, pending ${analysis.pending}, не начато ${analysis.notStarted ?? 'n/a'}. Заголовочный вывод по N=${expected} не делается.`);
    lines.push('');
  }
  lines.push(`Исключений из анализа: ${analysis.exclusions}. Отказ модели остаётся в знаменателе со счётом 0 и отдельным статусом; pending в знаменатель точности не входит.`);
  lines.push('');
  lines.push('Смесь test — это веса протокола, а не распределение пользовательских вопросов.');
  lines.push(`Веса по числу вопросов: AIME ${analysis.weights.aime}, GPQA ${analysis.weights.gpqa}, MMLU-Pro ${analysis.weights.mmlu}.`);
  lines.push('');
  lines.push('## Точность');
  lines.push('');
  lines.push('| Вариант | Общая доля | Macro |');
  lines.push('| --- | ---: | ---: |');
  for (const arm of ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']) {
    lines.push(`| ${arm} | ${pct(analysis.pooled[arm])} | ${pct(analysis.macro[arm])} |`);
  }
  lines.push('');
  lines.push('## Основная семья: A6 против альтернатив');
  lines.push('');
  if (analysis.beatsAll) {
    lines.push('По всей основной семье нижняя граница с поправкой Бонферрони выше 5 п.п.');
  } else {
    lines.push('Утверждение «лучше всех альтернатив более чем на 5 п.п.» не подтверждено.');
  }
  lines.push('');
  for (const item of analysis.family) {
    lines.push(`### A6 − ${item.right}`);
    lines.push('');
    lines.push(`N=${item.n}, победы ${item.wins}, поражения ${item.losses}, ничьи ${item.ties}, delta ${pp(item.delta)}.`);
    lines.push(`Exact McNemar p=${item.p}, Holm adjusted p=${item.adjustedP}.`);
    lines.push(`95% парный bootstrap [${pp(item.unadjusted.low)}, ${pp(item.unadjusted.high)}]${item.unadjusted.degenerate ? ', вырожденный' : ''}.`);
    lines.push(`Интервал Бонферрони [${pp(item.bonferroni.low)}, ${pp(item.bonferroni.high)}]${item.bonferroni.degenerate ? ', вырожденный' : ''}.`);
    lines.push(claimText(item.familyClaim));
    lines.push('');
  }
  lines.push('## Диагностика стадий');
  lines.push('');
  lines.push('Эти сравнения исследовательские и не добавляются к заголовку без отдельной оговорки.');
  lines.push('');
  for (const item of analysis.diagnostic) {
    lines.push(`- ${item.left} − ${item.right}: delta ${pp(item.delta)}, победы ${item.wins}, поражения ${item.losses}, ничьи ${item.ties}, p=${item.p}.`);
  }
  lines.push('');
  lines.push('## Отбор и синтез');
  lines.push('');
  lines.push(`P(A5 верен | oracle совета верен) = ${pct(analysis.selection.leaderGivenOracle)} при знаменателе ${analysis.selection.oracleDenominator}.`);
  lines.push(`P(A4 верен | oracle совета верен) = ${pct(analysis.selection.pluralityGivenOracle)}.`);
  lines.push(`Ожидаемая точность случайного выбора среди извлечённых ответов совета = ${pct(analysis.selection.randomCouncil)} при знаменателе ${analysis.selection.randomDenominator}.`);
  lines.push(`A6, новые верные ответы при oracle@5 = 0: ${analysis.transitions.A6.novelWhenOracleMissed}.`);
  lines.push(`A7, новые верные ответы при oracle@5 = 0: ${analysis.transitions.A7.novelWhenOracleMissed}.`);
  lines.push('');
  lines.push('Переходы лидер → итог (верно/неверно):');
  for (const arm of ['A6', 'A7']) {
    const cells = analysis.transitions[arm].cells;
    lines.push(`- ${arm}: верный→верный ${cells.correct_correct}, верный→неверный ${cells.correct_wrong}, неверный→верный ${cells.wrong_correct}, неверный→неверный ${cells.wrong_wrong}.`);
  }
  lines.push('');
  lines.push('## Метки уверенности');
  lines.push('');
  lines.push('Метка вычислена о лидере до синтеза. Это проверка категорий, а не калибровка вероятности. Малые корзины не валидированы; HIGH из-за этого не удаляется.');
  lines.push('');
  for (const [name, report] of [
    ['О лидере', analysis.confidenceAboutLeader],
    ['Рядом с итогом A6', analysis.confidenceAboutFinal],
  ]) {
    lines.push(`### ${name}`);
    lines.push('');
    lines.push(`Знаменатель ${report.denominator}, без метки ${report.missing}.`);
    for (const [level, bucket] of Object.entries(report.buckets)) {
      lines.push(`- ${level}: n=${bucket.n}, покрытие ${pct(bucket.coverage)}, точность ${pct(bucket.accuracy)}, интервал [${pct(bucket.interval.low)}, ${pct(bucket.interval.high)}], ${bucket.validated ? 'корзина не меньше 5' : 'метка пока не валидирована'}.`);
    }
    lines.push('');
  }
  const red = analysis.redTeam;
  lines.push(`REFUTED n=${red.refuted}, P(лидер неверен | REFUTED)=${pct(red.leaderWrongGivenRefuted)}.`);
  lines.push(`UPHELD n=${red.upheld}, P(лидер неверен | UPHELD)=${pct(red.leaderWrongGivenUpheld)}, P(UPHELD | лидер неверен)=${pct(red.upheldGivenLeaderWrong)} при знаменателе неверных лидеров ${red.leaderWrongDenominator}.`);
  lines.push(`CONTESTED n=${red.contested}, missing/parse ${red.missing}. Верный итог не подтверждает рассуждение red team.`);
  lines.push('');
  lines.push('## Затраты');
  lines.push('');
  if (context.costs) {
    lines.push(`Фактические POST эксперимента: ${context.costs.attempted}.`);
    lines.push(`Ответы с usage: ${context.costs.usageKnown}. Ответы без usage: ${context.costs.usageUnknown}. Отсутствие usage не записывается как нулевая стоимость.`);
    lines.push(`Сумма service time по журналу: ${context.costs.serviceMs} мс. Это не задержка одного пользователя.`);
    lines.push('Самостоятельные номинальные вызовы по вариантам записаны в report.json.');
  } else {
    lines.push('Фактические затраты этого прогона не приложены.');
  }
  lines.push('Время на общем кэше ответов не является пользовательской задержкой.');
  lines.push('');
  lines.push('Этот отчёт не меняет Stage 2 и интерфейс. Решение об изменении продукта принимается отдельно.');
  lines.push('');
  return lines.join('\n');
}

function pctEn(value) {
  if (value == null || Number.isNaN(value)) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function ppEn(value) {
  if (value == null || Number.isNaN(value)) return 'n/a';
  const scaled = value * 100;
  const sign = scaled > 0 ? '+' : scaled < 0 ? '−' : '';
  return `${sign}${Math.abs(scaled).toFixed(1)}`;
}

function intervalEn(interval) {
  if (!interval || interval.low == null || interval.high == null) return 'n/a';
  const text = `[${ppEn(interval.low)}, ${ppEn(interval.high)}]`;
  return interval.degenerate ? `${text} (degenerate)` : text;
}

function pEn(value) {
  if (value == null || Number.isNaN(value)) return 'n/a';
  if (value < 0.001) return '<0.001';
  return value.toFixed(3);
}

function readingEn(claim) {
  if (claim === 'gain_exceeds_min') return 'Gain above 5 pp supported: lower bound exceeds 5 pp';
  if (claim === 'useful_gain_excluded') return 'Useful gain excluded: upper bound below 5 pp';
  return 'Insufficient evidence either way';
}

function tableEn(header, rows) {
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines;
}

export function renderSummary(analysis, context = {}) {
  const expected = analysis.expected ?? context.expected ?? 120;
  const totals = context.blockTotals || { aime: 30, gpqa: 50, mmlu: 40 };
  const manifest = context.manifest || {};
  const nominal = context.nominal || {};
  const lines = [];
  const title = context.complete
    ? `Free council vs simpler alternatives: final result on ${analysis.scored} test questions`
    : `Free council vs simpler alternatives: interim snapshot, ${analysis.scored} of ${expected} test questions`;
  lines.push(`### ${title}`);
  lines.push('');
  lines.push(`Generated ${context.generatedAt || 'n/a'} from run \`${context.runId || 'main'}\`, protocol \`${String(context.protocolHash || '').slice(0, 12)}\`.`);
  if (!context.complete) {
    lines.push(`**Interim.** ${analysis.notStarted ?? 'n/a'} questions are not started and ${analysis.pending} are paused mid-question. The pre-registered headline is defined on all ${expected} questions and is not available yet. Sample size, roster, prompts, grader, and the comparison family were frozen before the first test call and are not changed by this snapshot.`);
  } else {
    lines.push('All planned questions are scored. The comparison family and sample size are the ones frozen before the first test call.');
  }
  lines.push('');
  lines.push(`Scored so far: AIME 2026 ${analysis.scoredByBlock?.aime ?? 0}/${totals.aime}, GPQA Diamond ${analysis.scoredByBlock?.gpqa ?? 0}/${totals.gpqa}, MMLU-Pro ${analysis.scoredByBlock?.mmlu ?? 0}/${totals.mmlu}. Every arm is graded on the same questions, so the arms are directly comparable.`);
  if (context.costs) {
    lines.push(`HTTP POSTs so far (smoke, dev, and test, including retries): ${context.costs.attempted}. Responses without a usage block: ${context.costs.usageUnknown} (not counted as zero cost).`);
  }
  lines.push('');
  if (manifest.councilModels) {
    lines.push(`Frozen council (${manifest.label || 'dev-selected'}): ${manifest.councilModels.map((model) => `\`${model}\``).join(', ')}.`);
    lines.push(`Chairman H: \`${manifest.chairmanModel}\`. Single-model baseline B: \`${manifest.bModel}\`.${manifest.a0AliasesA1 ? ' H = B, so A0 reuses the A1 call and is not a separate comparison.' : ''}`);
    lines.push('');
  }
  lines.push('#### Accuracy by arm');
  lines.push('');
  lines.push(...tableEn(
    ['Arm', 'What it is', 'Calls per question', 'Pooled', 'Macro (mean of blocks)', 'AIME', 'GPQA', 'MMLU-Pro'],
    ARMS.map((arm) => [
      arm,
      arm === 'A0' && manifest.a0AliasesA1 ? `${ARM_DESCRIPTIONS[arm]} (same call as A1 here)` : ARM_DESCRIPTIONS[arm],
      nominal[arm] ?? 'n/a',
      pctEn(analysis.pooled[arm]),
      pctEn(analysis.macro[arm]),
      pctEn(analysis.byBlock.aime.arms[arm]),
      pctEn(analysis.byBlock.gpqa.arms[arm]),
      pctEn(analysis.byBlock.mmlu.arms[arm]),
    ]),
  ));
  lines.push('');
  lines.push('Pooled = share of correct final answers over all scored questions. Macro = unweighted mean of the three block accuracies. Calls per question = nominal standalone cost of that arm with no retries.');
  lines.push('');
  lines.push(`#### Primary family: A6 (full council) vs alternatives, paired on the same questions (m = ${analysis.family.length})`);
  lines.push('');
  lines.push(...tableEn(
    ['Comparison', 'Δ pp (A6 − alt)', 'Wins / losses / ties', 'Exact McNemar p', 'Holm p', '95% paired bootstrap CI (pp)', 'Bonferroni CI (pp)', 'Reading at δmin = 5 pp'],
    analysis.family.map((item) => [
      `A6 − ${item.right}`,
      ppEn(item.delta),
      `${item.wins} / ${item.losses} / ${item.ties}`,
      pEn(item.p),
      pEn(item.adjustedP),
      intervalEn(item.unadjusted),
      intervalEn(item.bonferroni),
      readingEn(item.familyClaim),
    ]),
  ));
  lines.push('');
  lines.push(analysis.beatsAll
    ? '"Better than every alternative by more than 5 pp" is supported on the Bonferroni intervals of the whole family.'
    : '"Better than every alternative by more than 5 pp" is not supported.');
  lines.push('Wins = questions where A6 is correct and the alternative is wrong. McNemar tests the null of zero difference; the interval answers whether a 5 pp gain is supported or excluded. "Insufficient evidence" is not evidence of equivalence.');
  lines.push('');
  lines.push('#### Stage diagnostics (exploratory, no family correction)');
  lines.push('');
  lines.push(...tableEn(
    ['Comparison', 'Meaning', 'Δ pp', 'Wins / losses / ties', 'Exact McNemar p', '95% CI (pp)'],
    analysis.diagnostic.map((item) => [
      `${item.left} − ${item.right}`,
      DIAGNOSTIC_MEANING[`${item.left}-${item.right}`] || '',
      ppEn(item.delta),
      `${item.wins} / ${item.losses} / ${item.ties}`,
      pEn(item.p),
      intervalEn(item.unadjusted),
    ]),
  ));
  lines.push('');
  lines.push('#### Failure modes per arm (counts over scored questions)');
  lines.push('');
  lines.push(...tableEn(
    ['Arm', 'Correct', 'Wrong answer', 'Parse error', 'Refusal', 'No answer', 'Not run', 'Transport failure', 'Chairman fallback'],
    ARMS.map((arm) => {
      const counts = analysis.armStatus?.[arm] || {};
      return [
        arm,
        counts.correct ?? 0,
        counts.wrong ?? 0,
        counts.parse_error ?? 0,
        counts.refusal ?? 0,
        counts.no_answer ?? 0,
        counts.not_run ?? 0,
        counts.transport ?? 0,
        arm === 'A6' || arm === 'A7' ? counts.fallback ?? 0 : '',
      ];
    }),
  ));
  lines.push('');
  lines.push(`Every failure scores 0 and stays in the denominator. Transport failure = timeout, truncated stream, provider error, or a skipped call. Ranking fallback (no parseable Stage 2 ranking, Stage 1 order used): ${analysis.rankingFallback ?? 0} of ${analysis.scored}.`);
  lines.push('');
  lines.push('#### Council confidence label (computed about the Stage 2 leader before synthesis)');
  lines.push('');
  const leaderBuckets = analysis.confidenceAboutLeader?.buckets || {};
  const finalBuckets = analysis.confidenceAboutFinal?.buckets || {};
  lines.push(...tableEn(
    ['Label', 'n', 'Coverage', 'Leader (A5) accuracy', '95% Wilson', 'A6 accuracy under this label', 'Validated (n ≥ 5)'],
    Object.keys(leaderBuckets).map((level) => {
      const bucket = leaderBuckets[level];
      return [
        level,
        bucket.n,
        pctEn(bucket.coverage),
        pctEn(bucket.accuracy),
        bucket.n ? `[${pctEn(bucket.interval.low)}, ${pctEn(bucket.interval.high)}]` : 'n/a',
        pctEn(finalBuckets[level]?.accuracy),
        bucket.validated ? 'yes' : 'no',
      ];
    }),
  ));
  lines.push('');
  const red = analysis.redTeam || {};
  lines.push(`Questions without a label: ${analysis.confidenceAboutLeader?.missing ?? 0}. This checks whether the labels carry information; it is not probability calibration.`);
  lines.push(`Red team: REFUTED n=${red.refuted ?? 0}, P(leader wrong | REFUTED) = ${pctEn(red.leaderWrongGivenRefuted)}; UPHELD n=${red.upheld ?? 0}, P(leader wrong | UPHELD) = ${pctEn(red.leaderWrongGivenUpheld)}, P(UPHELD | leader wrong) = ${pctEn(red.upheldGivenLeaderWrong)} over ${red.leaderWrongDenominator ?? 0} wrong leaders; CONTESTED n=${red.contested ?? 0}; missing or unparsed ${red.missing ?? 0}. A correct final answer does not verify the red-team argument.`);
  lines.push('');
  lines.push(`Selection: P(A5 correct | some council answer correct) = ${pctEn(analysis.selection?.leaderGivenOracle)} over ${analysis.selection?.oracleDenominator ?? 0}; P(A4 correct | same) = ${pctEn(analysis.selection?.pluralityGivenOracle)}. A6 produced a correct answer that no council member had ${analysis.transitions?.A6?.novelWhenOracleMissed ?? 0} times, A7 ${analysis.transitions?.A7?.novelWhenOracleMissed ?? 0} times.`);
  lines.push('');
  lines.push('This table is a measurement, not a product decision. It does not change Stage 2 or the UI. Numbers refresh with `npm --prefix frontend run eval -- report`.');
  return lines.join('\n');
}
