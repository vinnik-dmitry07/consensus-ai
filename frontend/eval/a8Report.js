import { mcnemarExact, pairedBootstrap } from './report.js';
import { ALPHA, BOOTSTRAP_REPS, DELTA_MIN, TEST_COUNTS } from './protocol.js';

const TEST_QUESTIONS = TEST_COUNTS.aime + TEST_COUNTS.gpqa + TEST_COUNTS.mmlu;

function present(row, arm) {
  const grade = row?.arms?.[arm];
  return Boolean(grade) && row.status === 'complete' && grade.status;
}

function correctOf(grade) {
  return grade?.correct === 1 ? 1 : 0;
}

export function completedPairs(rows) {
  return (rows || []).filter((row) => present(row, 'A8') && present(row, 'S8'));
}

export function rate(rows, arm) {
  if (!rows.length) return null;
  return rows.reduce((sum, row) => sum + correctOf(row.arms[arm]), 0) / rows.length;
}

export function blockRates(rows, arm) {
  const blocks = ['aime', 'gpqa', 'mmlu'];
  const out = {};
  for (const block of blocks) {
    const subset = rows.filter((row) => row.block === block);
    out[block] = rate(subset, arm);
  }
  const values = blocks.map((block) => out[block]).filter((value) => value != null);
  out.macro = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return out;
}

export function comparePrimary(rows) {
  const paired = completedPairs(rows);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const row of paired) {
    const left = correctOf(row.arms.A8);
    const right = correctOf(row.arms.S8);
    if (left === right) ties += 1;
    else if (left > right) wins += 1;
    else losses += 1;
  }
  const exact = mcnemarExact(wins, losses);
  const [interval] = paired.length
    ? pairedBootstrap(paired, 'A8', 'S8', { reps: BOOTSTRAP_REPS, tail: ALPHA / 2 })
    : [{ low: null, high: null, degenerate: true }];
  const delta = paired.length ? (wins - losses) / paired.length : null;
  return {
    n: paired.length,
    wins,
    losses,
    ties,
    delta,
    p: exact.p,
    interval,
  };
}

export function interpret(comparison, planned, complete) {
  if (!complete || comparison.n !== planned) {
    return 'interim: the test is incomplete, so this is not a final claim';
  }
  const interval = comparison.interval;
  if (!interval || interval.degenerate || interval.low == null || interval.high == null) {
    return 'the bootstrap interval is degenerate and is not evidence of no effect';
  }
  if (interval.low > DELTA_MIN) return 'the interval supports a gain above 5 percentage points';
  if (interval.high < DELTA_MIN) return 'the interval does not support a gain above 5 percentage points';
  return 'the interval crosses 5 percentage points, so the sample does not decide that threshold';
}

function pct(value) {
  if (value == null) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

export function renderA8Report(input) {
  const rows = input.rows || [];
  const planned = input.planned ?? TEST_QUESTIONS;
  const paired = completedPairs(rows);
  const pending = rows.filter((row) => row.status === 'pending').length;
  const comparison = comparePrimary(rows);
  const complete = input.complete === true && comparison.n === planned && pending === 0;
  const claim = interpret(comparison, planned, complete);
  const lines = [
    '# Paid council vs Self-MoA',
    '',
    'Exploratory comparison on the existing question bank. This is not a fresh holdout.',
    `Primary pair: A8 against S8. Strict grader. Planned questions: ${planned}. Completed pairs: ${comparison.n}. Pending: ${pending}.`,
    '',
    `| Arm | Pooled | Macro | AIME | GPQA | MMLU-Pro |`,
    `| --- | --- | --- | --- | --- | --- |`,
  ];
  for (const arm of ['A8', 'S8', 'B8']) {
    const blocks = blockRates(paired, arm);
    lines.push(`| ${arm} | ${pct(rate(paired, arm))} | ${pct(blocks.macro)} | ${pct(blocks.aime)} | ${pct(blocks.gpqa)} | ${pct(blocks.mmlu)} |`);
  }
  const low = comparison.interval?.low;
  const high = comparison.interval?.high;
  const macroA = blockRates(paired, 'A8').macro;
  const macroS = blockRates(paired, 'S8').macro;
  const macroDelta = macroA == null || macroS == null ? null : macroA - macroS;
  lines.push(
    '',
    `A8 − S8 pooled: ${comparison.delta == null ? 'n/a' : `${(comparison.delta * 100).toFixed(1)} pp`}. `
    + `Macro: ${macroDelta == null ? 'n/a' : `${(macroDelta * 100).toFixed(1)} pp`}. `
    + `Wins / losses / ties: ${comparison.wins} / ${comparison.losses} / ${comparison.ties}. `
    + `McNemar p: ${comparison.p}. `
    + `95% CI of the pooled difference: [${low == null ? 'n/a' : (low * 100).toFixed(1)}, ${high == null ? 'n/a' : (high * 100).toFixed(1)}] pp.`,
    `The claim compares that pooled interval with ${DELTA_MIN * 100} percentage points. McNemar p is printed separately and is not the claim rule. Macro is the unweighted mean of the three blocks.`,
    `Claim: ${claim}`,
    '',
    'Terminal method failures stay in the completed-pair denominator. Pending questions are not scored incorrect.',
  );
  if (input.history) {
    lines.push(
      '',
      `Historical A7 reference (${input.history.label}): pooled ${pct(input.history.pooled)} on ${input.history.n} as-run questions. Not a paired test against A8.`,
    );
  }
  if (input.note) lines.push('', input.note);
  if (input.spend) {
    lines.push(
      '',
      `Campaign settled $${Number(input.spend.settledUsd || 0).toFixed(4)}. Unresolved reserve $${Number(input.spend.unresolvedUsd || 0).toFixed(4)}. POSTs ${input.spend.posts ?? 0}.`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
