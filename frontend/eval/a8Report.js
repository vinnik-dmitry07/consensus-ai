import { holm, mcnemarExact, pairedBootstrap } from './report.js';
import { ALPHA, BOOTSTRAP_REPS, DELTA_MIN, TEST_COUNTS } from './protocol.js';

const TEST_QUESTIONS = TEST_COUNTS.aime + TEST_COUNTS.gpqa + TEST_COUNTS.mmlu;
const PRIMARY = ['A8', 'S8'];

function present(row, arm) {
  const grade = row?.arms?.[arm];
  return Boolean(grade) && row.status === 'complete' && grade.status;
}

function correctOf(grade) {
  return grade?.correct === 1 ? 1 : 0;
}

export function completedPairs(rows, arms = PRIMARY) {
  return (rows || []).filter((row) => arms.every((arm) => present(row, arm)));
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

export function comparePair(rows, leftArm, rightArm) {
  const paired = completedPairs(rows, [leftArm, rightArm]);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const row of paired) {
    const left = correctOf(row.arms[leftArm]);
    const right = correctOf(row.arms[rightArm]);
    if (left === right) ties += 1;
    else if (left > right) wins += 1;
    else losses += 1;
  }
  const exact = mcnemarExact(wins, losses);
  const [interval] = paired.length
    ? pairedBootstrap(paired, leftArm, rightArm, { reps: BOOTSTRAP_REPS, tail: ALPHA / 2 })
    : [{ low: null, high: null, degenerate: true }];
  const delta = paired.length ? (wins - losses) / paired.length : null;
  return {
    left: leftArm,
    right: rightArm,
    n: paired.length,
    wins,
    losses,
    ties,
    delta,
    p: exact.p,
    interval,
  };
}

export function comparePrimary(rows) {
  return comparePair(rows, PRIMARY[0], PRIMARY[1]);
}

// Secondary pairs share one Holm correction. They are reported next to the
// primary pair and never replace it.
export function compareSecondary(rows, pairs) {
  const comparisons = (pairs || []).map(([left, right]) => comparePair(rows, left, right));
  const adjusted = holm(comparisons.map((item) => item.p));
  return comparisons.map((item, index) => ({ ...item, holmP: adjusted[index] }));
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

function pp(value) {
  if (value == null) return 'n/a';
  return `${(value * 100).toFixed(1)} pp`;
}

function intervalText(interval) {
  const low = interval?.low;
  const high = interval?.high;
  return `[${low == null ? 'n/a' : (low * 100).toFixed(1)}, ${high == null ? 'n/a' : (high * 100).toFixed(1)}] pp`;
}

export function renderA8Report(input) {
  const rows = input.rows || [];
  const planned = input.planned ?? TEST_QUESTIONS;
  const paired = completedPairs(rows);
  const pending = rows.filter((row) => row.status === 'pending').length;
  const comparison = comparePrimary(rows);
  const complete = input.complete === true && comparison.n === planned && pending === 0;
  const claim = interpret(comparison, planned, complete);
  const hasP8 = rows.some((row) => row.arms?.P8);
  const armsShown = hasP8 ? ['A8', 'S8', 'P8', 'B8'] : ['A8', 'S8', 'B8'];
  const lines = [
    '# Paid council vs Self-MoA',
    '',
    'Exploratory comparison on the existing question bank. This is not a fresh holdout.',
    `Primary pair: A8 against S8. Strict grader. Planned questions: ${planned}. Completed pairs: ${comparison.n}. Pending: ${pending}.`,
    '',
    `| Arm | Pooled | Macro | AIME | GPQA | MMLU-Pro |`,
    `| --- | --- | --- | --- | --- | --- |`,
  ];
  for (const arm of armsShown) {
    const blocks = blockRates(paired, arm);
    lines.push(`| ${arm} | ${pct(rate(paired, arm))} | ${pct(blocks.macro)} | ${pct(blocks.aime)} | ${pct(blocks.gpqa)} | ${pct(blocks.mmlu)} |`);
  }
  if (hasP8) lines.push('', 'P8 is a plurality vote over the three council Stage 1 answers; it makes no call.');
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
  if (hasP8 && input.secondaryPairs?.length) {
    lines.push('', 'Secondary pairs (exploratory; one Holm correction over this family; the primary claim above is unchanged):');
    for (const item of compareSecondary(rows, input.secondaryPairs)) {
      lines.push(
        `${item.left} − ${item.right}: ${pp(item.delta)} on ${item.n} pairs. `
        + `Wins / losses / ties: ${item.wins} / ${item.losses} / ${item.ties}. `
        + `McNemar p: ${item.p}. Holm p: ${item.holmP}. 95% CI: ${intervalText(item.interval)}.`,
      );
    }
  }
  if (input.stageCaps) {
    const caps = input.stageCaps;
    lines.push(
      '',
      `Output caps: Stage 1 and B samples ${caps.stage1} tokens, Stage 2 judges ${caps.stage2}, final synthesis ${caps.stage3}. `
      + 'A call cut at its cap keeps its text and is graded as written.'
      + (input.streamTimeoutSeconds ? ` Stream deadline ${input.streamTimeoutSeconds} s per attempt.` : ''),
    );
  }
  if (input.history) {
    lines.push(
      '',
      `Historical A7 reference (${input.history.label}): pooled ${pct(input.history.pooled)} on ${input.history.n} as-run questions. Not a paired test against A8.`,
    );
  }
  if (input.note) lines.push('', input.note);
  if (input.armRules) {
    const rules = input.armRules;
    lines.push(
      '',
      `Arm rules: A8 ${rules.a8RequiresFullCouncil ? 'needs all three Stage 1 answers' : 'synthesizes from any Stage 1 answers'}; `
      + `S8 ${rules.s8RequiresAllSamples ? 'needs all five samples with text' : 'synthesizes from any samples with text'}`
      + (rules.p8RequiresFullCouncil == null
        ? '. '
        : `; P8 ${rules.p8RequiresFullCouncil ? 'needs all three Stage 1 answers and lets an unparseable one abstain' : 'votes over whatever answers parse'}. `)
      + 'A missing input after the allowed attempts is a method failure, scored incorrect.',
    );
  }
  if (input.spend) {
    lines.push(
      '',
      `This run settled $${Number(input.spend.settledUsd || 0).toFixed(4)}. Unresolved reserve $${Number(input.spend.unresolvedUsd || 0).toFixed(4)}. POSTs ${input.spend.posts ?? 0}.`,
    );
  }
  for (const prior of input.priorSpend || []) {
    lines.push(
      `Reused run ${prior.run}: settled $${Number(prior.settledUsd || 0).toFixed(4)}, unresolved $${Number(prior.unresolvedUsd || 0).toFixed(4)}, POSTs ${prior.posts ?? 0}. Counted once, against the same cap.`,
    );
  }
  if (input.reuse) {
    lines.push(
      `Calls taken from earlier runs by exact request: ${input.reuse.reusedSlots}. Fresh POSTs in this run: ${input.reuse.freshPosts}.`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
