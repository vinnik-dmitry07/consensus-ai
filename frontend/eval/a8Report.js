import { holm, mcnemarExact, pairedBootstrap } from './report.js';
import { ALPHA, BOOTSTRAP_REPS, DELTA_MIN, TEST_COUNTS } from './protocol.js';
import { BLOCK_LABELS, orderBlocks } from './a8Blocks.js';
import { gradeResponseLenient } from './grade.js';

const TEST_QUESTIONS = Object.values(TEST_COUNTS).reduce((sum, count) => sum + count, 0);
const PRIMARY = ['A8', 'S8'];
const ARMS = ['A8', 'S8', 'P8', 'B8'];
const LENIENT_ARMS = ['A8', 'S8', 'B8'];
// A 90% interval: inside ±DELTA_MIN it is an approximate TOST at alpha 0.05.
const EQUIVALENCE_TAIL = 0.05;
// Below this many discordant pairs the bootstrap interval is called rough.
const FEW_DISCORDANT = 20;

export function blocksOf(rows) {
  return orderBlocks((rows || []).map((row) => row.block).filter(Boolean));
}

function label(block) {
  return BLOCK_LABELS[block] || block;
}

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

export function blockRates(rows, arm, blocks = blocksOf(rows)) {
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
  // One bootstrap gives both intervals: the 95% one for the reading of size,
  // the 90% one for the approximate equivalence criterion. The 95% interval
  // is the same as when it was drawn alone.
  const empty = { low: null, high: null, degenerate: true };
  const [interval, interval90] = paired.length
    ? pairedBootstrap(paired, leftArm, rightArm, { reps: BOOTSTRAP_REPS, tails: [ALPHA / 2, EQUIVALENCE_TAIL] })
    : [empty, empty];
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
    interval90,
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
  const blockList = blocksOf(paired.length ? paired : rows);
  const lines = [
    '# Paid council vs Self-MoA',
    '',
    'Exploratory comparison on the existing question bank. This is not a fresh holdout.',
    `Primary pair: A8 against S8. Strict grader. Planned questions: ${planned}. Completed pairs: ${comparison.n}. Pending: ${pending}.`,
    '',
    `| Arm | Pooled | Macro | ${blockList.map(label).join(' | ')} |`,
    `| --- | --- | --- | ${blockList.map(() => '---').join(' | ')} |`,
  ];
  for (const arm of armsShown) {
    const blocks = blockRates(paired, arm, blockList);
    lines.push(`| ${arm} | ${pct(rate(paired, arm))} | ${pct(blocks.macro)} | ${blockList.map((block) => pct(blocks[block])).join(' | ')} |`);
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
    `The claim compares that pooled interval with ${DELTA_MIN * 100} percentage points. McNemar p is printed separately and is not the claim rule. Macro is the unweighted mean of the ${blockList.length} blocks.`,
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

// ---------------------------------------------------------------------------
// Extended campaigns (v5): primary set, secondary family, chronology, cost.

// Rescores stored answers against corrected golds. Every stored grade keeps
// the canonical answer it extracted, which does not depend on the gold, so
// this needs no new call. `overrides` maps a question id to a canonical gold.
export function applyGoldOverrides(rows, overrides) {
  const applied = [];
  const regrade = (grade, gold) => {
    if (!grade || grade.status !== 'graded' || grade.extracted == null) return grade;
    return { ...grade, correct: grade.extracted === gold ? 1 : 0 };
  };
  const out = (rows || []).map((row) => {
    const gold = overrides?.[row.id];
    if (gold == null || !row.arms) return row;
    applied.push(row.id);
    const arms = {};
    for (const [arm, grade] of Object.entries(row.arms)) arms[arm] = regrade(grade, gold);
    const diagnostics = { ...(row.diagnostics || {}) };
    for (const field of ['councilVote', 'replicateVote', 'leader']) {
      if (diagnostics[field]) diagnostics[field] = regrade(diagnostics[field], gold);
    }
    if (Array.isArray(diagnostics.councilAnswers)) {
      diagnostics.oracle = diagnostics.councilAnswers.some((answer) => answer === gold) ? 1 : 0;
    }
    const leaderRight = diagnostics.leader?.correct === 1;
    diagnostics.rescue = !leaderRight && arms.A8?.correct === 1 ? 1 : 0;
    diagnostics.harm = leaderRight && arms.A8?.correct === 0 ? 1 : 0;
    return { ...row, arms, diagnostics, goldOverride: gold };
  });
  return { rows: out, applied };
}

function usableInterval(interval) {
  return Boolean(interval) && !interval.degenerate && interval.low != null && interval.high != null;
}

// The pre-registered reading of the primary pair, one answer per question:
// direction from the exact McNemar test, size against ±DELTA_MIN from the 95%
// interval, practical equivalence from the 90% interval. A bound equal to a
// threshold does not pass it. p >= 0.05 is never read as equality, and an
// incomplete primary set gives no final claim.
export function interpretV5(comparison, planned, complete) {
  if (!complete || comparison.n !== planned) return ['interim: the primary set is incomplete, so this is not a final claim'];
  const lines = [];
  const { delta, p, interval, interval90, wins, losses } = comparison;
  const threshold = `${DELTA_MIN * 100} percentage points`;
  if (delta > 0 && p < ALPHA) lines.push('direction: statistical evidence that A8 is ahead of S8 on this set');
  else if (delta < 0 && p < ALPHA) lines.push('direction: statistical evidence that S8 is ahead of A8 on this set');
  else lines.push('direction: not established; this is not evidence that the two methods are equal');
  if (!usableInterval(interval)) {
    lines.push('size: the 95% interval is degenerate and says nothing about size or equivalence');
    return lines;
  }
  if (interval.low > DELTA_MIN) lines.push(`A8 ahead by more than ${threshold}: supported by the 95% interval`);
  else if (interval.high < DELTA_MIN) lines.push(`A8 ahead by more than ${threshold}: not supported by the 95% interval`);
  else lines.push(`A8 ahead by more than ${threshold}: undecided, the 95% interval crosses the threshold`);
  if (interval.high < -DELTA_MIN) lines.push(`S8 ahead by more than ${threshold}: supported by the 95% interval`);
  else if (interval.low > -DELTA_MIN) lines.push(`S8 ahead by more than ${threshold}: not supported by the 95% interval`);
  else lines.push(`S8 ahead by more than ${threshold}: undecided, the 95% interval crosses the threshold`);
  if (!usableInterval(interval90)) {
    lines.push('practical equivalence: the 90% interval is degenerate, so no claim');
  } else if (interval90.low > -DELTA_MIN && interval90.high < DELTA_MIN) {
    lines.push(`practical equivalence within ±${threshold}: supported by the 90% interval (an approximate bootstrap criterion, not an exact TOST)`);
  } else {
    lines.push(`practical equivalence within ±${threshold}: not shown, the 90% interval reaches a bound`);
  }
  if (wins + losses < FEW_DISCORDANT) {
    lines.push(`only ${wins + losses} discordant pairs, so the bootstrap intervals are rough`);
  }
  return lines;
}

// Diagnostic only. A8, S8, and B8 are read again with the lenient reader from
// the final text each arm stored; P8 is not, because its ballots keep only the
// strict extractions. `tasks` maps a question id to its task with the gold in
// force, so a gold override reaches this reading too.
export function lenientRows(rows, tasks) {
  return (rows || []).map((row) => {
    const task = tasks?.get(row.id);
    if (!task || !row.arms) return row;
    const arms = { ...row.arms };
    for (const arm of LENIENT_ARMS) {
      const grade = arms[arm];
      if (!grade?.status || typeof grade.text !== 'string' || !grade.text) continue;
      arms[arm] = { ...gradeResponseLenient(task, grade.text), text: grade.text };
    }
    return { ...row, arms };
  });
}

// The pre-registered family, always at full size: an empty subset stays in it
// at p = 1, so the Holm correction is not weakened by a missing group.
export function secondaryFamily(rows, family) {
  const results = (family || []).map((entry) => {
    const groups = entry.groups || (entry.group ? [entry.group] : null);
    const subset = rows.filter((row) => row.set === entry.set && (!groups || groups.includes(row.group)));
    const result = { ...entry, ...comparePair(subset, entry.left, entry.right) };
    return result.n ? result : { ...result, p: 1, empty: true };
  });
  const adjusted = holm(results.map((item) => item.p));
  results.forEach((item, index) => {
    item.holmP = adjusted[index];
  });
  return results;
}

function money(value) {
  return value == null ? 'n/a' : `$${Number(value).toFixed(4)}`;
}

// Moves from one stage's answer to the next on the same questions: fixes are
// wrong-to-right, breaks right-to-wrong. By construction the accuracy change
// equals (fixes - breaks) / n.
export function transitions(rows, baseOf, finalOf) {
  let n = 0;
  let fixes = 0;
  let breaks = 0;
  let baseRight = 0;
  let finalRight = 0;
  for (const row of rows || []) {
    const base = baseOf(row);
    const final = finalOf(row);
    if (!base?.status || !final?.status) continue;
    const before = base.correct === 1 ? 1 : 0;
    const after = final.correct === 1 ? 1 : 0;
    n += 1;
    baseRight += before;
    finalRight += after;
    if (!before && after) fixes += 1;
    if (before && !after) breaks += 1;
  }
  return { n, fixes, breaks, base: n ? baseRight / n : null, final: n ? finalRight / n : null };
}

const share = (rows, pick) => (rows.length ? rows.filter(pick).length / rows.length : null);

// Diagnostics from stored outcomes, with the gold in force; no new call.
function mechanismSection(rows) {
  const vote = (field) => (row) => row.diagnostics?.[field];
  const lines = [
    '',
    '## Mechanisms on the new blocks (diagnostic, no new calls)',
    '',
    'P8 is a plurality over the three canonical Stage 1 answers of the council. A tie goes to the answer first in a hash order seeded by the question; '
    + 'an unparsed answer abstains, and no usable answer is a failure. The vote of B\'s five samples uses the same rule.',
    '',
    '| Answer | Accuracy |',
    '| --- | --- |',
    `| B8, B's first answer | ${pct(rate(rows, 'B8'))} |`,
    `| P8, council plurality | ${pct(rate(rows, 'P8'))} |`,
    `| Vote of B's five samples | ${pct(share(rows, (row) => vote('replicateVote')(row)?.correct === 1))} |`,
    `| Stage 2 leader | ${pct(share(rows, (row) => vote('leader')(row)?.correct === 1))} |`,
    `| A8, chairman | ${pct(rate(rows, 'A8'))} |`,
    `| S8, Self-MoA synthesis | ${pct(rate(rows, 'S8'))} |`,
    `| Oracle@3, council: one of three Stage 1 answers right | ${pct(share(rows, (row) => row.oracleCouncil === 1))} |`,
    `| Oracle@3, B samples 1 to 3 | ${pct(share(rows, (row) => row.oracleB3 === 1))} |`,
    '',
    'B\'s first sample is in both oracle sets, because B sits on the council. Oracle@3 of the council is never compared with oracle@5 of B.',
    '',
    '| Step | n | Before | After | Fixed | Broke |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const steps = [
    ['Chairman over the Stage 2 leader', transitions(rows, vote('leader'), (row) => row.arms?.A8)],
    ['Self-MoA synthesis over the vote of five samples', transitions(rows, vote('replicateVote'), (row) => row.arms?.S8)],
  ];
  for (const [name, step] of steps) {
    lines.push(`| ${name} | ${step.n} | ${pct(step.base)} | ${pct(step.final)} | ${step.fixes} | ${step.breaks} |`);
  }
  lines.push('', 'These are moves between stages, not a causal ablation.');
  return lines;
}

// A8 - S8 with each new block left out in turn: how much the pooled result
// leans on one block of the mix.
function leaveOneOutSection(rows, blocks) {
  const present = (blocks || []).filter((block) => rows.some((row) => row.block === block));
  if (present.length < 2) return [];
  const lines = ['', '## Without one block at a time (diagnostic)', '', '| Left out | n | A8 − S8 | 95% CI |', '| --- | --- | --- | --- |'];
  for (const block of present) {
    const pair = comparePair(rows.filter((row) => row.block !== block), 'A8', 'S8');
    lines.push(`| ${label(block)} | ${pair.n} | ${pp(pair.delta)} | ${intervalText(pair.interval)} |`);
  }
  return lines;
}

// The dev table behind the choice of B and the council.
function devSection(dev) {
  const table = dev.table || [];
  if (!table.length) return [];
  const lines = [
    '',
    '## Dev selection',
    '',
    `B is the best of the checked candidates on this dev set under the fixed rule (accuracy, then completion, then latency). It is not shown to be the best model for the test mix. Dev questions by block: ${Object.entries(dev.blocks || {}).map(([block, count]) => `${label(block)} ${count}`).join(', ')}.`,
    '',
    '| Candidate | Correct | Completed | Accuracy |',
    '| --- | --- | --- | --- |',
  ];
  for (const row of table) {
    lines.push(`| ${row.id} | ${row.correct} / ${row.expected ?? row.attempts} | ${row.successes} / ${row.expected ?? row.attempts} | ${pct(row.accuracy)} |`);
  }
  if (table.length > 1) lines.push('', `Gap between the first and the second: ${pp(table[0].accuracy - table[1].accuracy)}.`);
  return lines;
}

function statusCounts(rows, arm) {
  const counts = {};
  for (const row of rows) {
    const grade = row.arms?.[arm];
    if (!grade) continue;
    let key = grade.reason || grade.status;
    if (grade.status === 'graded') key = grade.correct === 1 ? 'correct' : 'wrong';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function renderV5Report(input) {
  const rows = input.rows || [];
  const completed = rows.filter((row) => row.status === 'complete');
  const pending = rows.filter((row) => row.status === 'pending').length;
  const primaryRows = completedPairs(rows.filter((row) => row.set === 'primary'));
  const legacyRows = completedPairs(rows.filter((row) => row.set === 'legacy'));
  const primary = comparePair(primaryRows, 'A8', 'S8');
  const plannedPrimary = input.plannedPrimary;
  // The primary reading is final once every primary question has both arms;
  // the legacy blocks and the money have their own status.
  const primaryComplete = input.primaryComplete === true && primary.n === plannedPrimary;
  const reading = interpretV5(primary, plannedPrimary, primaryComplete);
  const primaryBlocks = input.primaryBlocks || [];
  const plannedLegacy = input.plannedLegacy ?? null;
  const lines = [
    '# Paid council vs Self-MoA, extended set',
    '',
    'Question: how the accuracy of two frozen pipelines, A8 v5 and S8 v5, differs on this mix of new tasks under these caps, routes, '
    + 'and retry and parsing rules. It does not isolate the council, model diversity, the caps, or the loop guard, '
    + 'and one token cap does not make the two budgets equal.',
    '',
    `Primary pair: A8 against S8 on the new blocks (${primaryBlocks.map(label).join(', ')}). Strict grader.`,
    `Primary set: ${primary.n} of ${plannedPrimary} pairs, ${primaryComplete ? 'complete' : 'incomplete'}. `
    + `Legacy blocks: ${legacyRows.length} of ${plannedLegacy ?? 'n/a'}, ${input.legacyComplete ? 'complete' : 'incomplete'}. `
    + `Pending questions: ${pending}. Cost: ${input.moneyFinal ? 'final' : 'preliminary, some reserves are still unresolved'}.`,
    'New to this campaign series does not mean unseen in training. See the chronology table.',
    '',
  ];
  const blockList = blocksOf(completed);
  lines.push(
    `| Arm | New blocks pooled | New blocks macro | Legacy pooled | ${blockList.map(label).join(' | ')} |`,
    `| --- | --- | --- | --- | ${blockList.map(() => '---').join(' | ')} |`,
  );
  const paired = completedPairs(completed);
  for (const arm of ARMS) {
    if (!paired.some((row) => row.arms?.[arm])) continue;
    const perBlock = blockRates(paired, arm, blockList);
    const newMacro = blockRates(primaryRows, arm, primaryBlocks).macro;
    lines.push(
      `| ${arm} | ${pct(rate(primaryRows, arm))} | ${pct(newMacro)} | ${pct(rate(legacyRows, arm))} | `
      + `${blockList.map((block) => pct(perBlock[block])).join(' | ')} |`,
    );
  }
  lines.push(
    '',
    `A8 − S8 on the new blocks: ${pp(primary.delta)}. Wins / losses / ties: ${primary.wins} / ${primary.losses} / ${primary.ties}; `
    + `discordant pairs ${primary.wins + primary.losses}. Exact McNemar p: ${primary.p}. `
    + `Paired bootstrap resampled within blocks: 95% CI ${intervalText(primary.interval)}, 90% CI ${intervalText(primary.interval90)}.`,
    ...reading.map((line) => `Reading: ${line}.`),
    primary.n ? `One corrected gold moves this difference by at most ${pp(2 / primary.n)}.` : '',
  );
  const adapted = primaryRows.filter((row) => row.adapted).length;
  if (adapted) {
    const without = comparePair(primaryRows.filter((row) => !row.adapted), 'A8', 'S8');
    lines.push(
      '',
      `Sensitivity: without the ${adapted} AMC questions whose figure was dropped or written out as text, A8 − S8 is ${pp(without.delta)} on ${without.n}. `
      + `Wins / losses / ties: ${without.wins} / ${without.losses} / ${without.ties}. Exact McNemar p: ${without.p}. 95% CI: ${intervalText(without.interval)}.`,
    );
  }
  lines.push(
    '',
    'Terminal method failures stay in the denominator as wrong. Pending questions are not scored and keep the primary set from being complete.',
    '',
    '## Secondary family (one Holm correction)',
    '',
    '| Comparison | n | Δ | W / L / T | McNemar p | Holm p | 95% CI |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const item of secondaryFamily(completed, input.family)) {
    lines.push(
      item.n
        ? `| ${item.name} | ${item.n} | ${pp(item.delta)} | ${item.wins} / ${item.losses} / ${item.ties} | ${item.p} | ${item.holmP} | ${intervalText(item.interval)} |`
        : `| ${item.name} | 0 | N/A, no questions | | kept at 1 | ${item.holmP} | |`,
    );
  }
  lines.push('', 'Macro accuracy, single blocks, single chronology groups, the legacy blocks, and the mechanism counts below are diagnostics.');

  const legacy = comparePair(legacyRows, 'A8', 'S8');
  lines.push(
    '',
    '## Regression check on the legacy blocks (diagnostic)',
    '',
    'Caps were chosen four times on these questions, so this is not a confirmatory test and has no place in the Holm family.',
    legacy.n
      ? `A8 − S8: ${pp(legacy.delta)} on ${legacy.n}. Wins / losses / ties: ${legacy.wins} / ${legacy.losses} / ${legacy.ties}. 95% CI ${intervalText(legacy.interval)}.`
      : 'No completed legacy pairs yet.',
  );

  lines.push(...mechanismSection(primaryRows));
  lines.push(...leaveOneOutSection(primaryRows, primaryBlocks));
  if (input.dev) lines.push(...devSection(input.dev));

  if (input.lenientRows) {
    const lenientPrimary = completedPairs(input.lenientRows.filter((row) => row.status === 'complete' && row.set === 'primary'));
    const lenientPair = comparePair(lenientPrimary, 'A8', 'S8');
    lines.push(
      '',
      '## Lenient reading (diagnostic)',
      '',
      `Rules: ${input.lenientRules || 'not recorded'}. A8, S8, and B8 are read again from their stored final text; P8 is not. The strict result above stays the result.`,
      '',
      '| Arm | New blocks, strict | New blocks, lenient | Answers read only by the lenient rules |',
      '| --- | --- | --- | --- |',
    );
    for (const arm of LENIENT_ARMS) {
      const lenientOnly = lenientPrimary.filter((row) => row.arms[arm]?.lenient).length;
      lines.push(`| ${arm} | ${pct(rate(primaryRows, arm))} | ${pct(rate(lenientPrimary, arm))} | ${lenientOnly} |`);
    }
    lines.push(
      '',
      `A8 − S8 on the new blocks, lenient: ${pp(lenientPair.delta)}. Wins / losses / ties: ${lenientPair.wins} / ${lenientPair.losses} / ${lenientPair.ties}. `
      + `Exact McNemar p: ${lenientPair.p}. 95% CI: ${intervalText(lenientPair.interval)}.`,
    );
  }

  lines.push(
    '',
    '## Chronology against model listings',
    '',
    `Listing dates of the chosen models: ${Object.entries(input.listings || {}).map(([id, date]) => `${id} ${date || 'unknown'}`).join('; ')}.`,
    'A listing date is when OpenRouter added a model, not its training cutoff. A: the material appeared after every listing or was generated for this run; B: after some; C: before all; Unknown: not enough dates. No group is claimed free of leakage.',
    '',
    'Group A holds only generated puzzles and AMC, so a gap between groups mixes freshness with the kind of task.',
    '',
    `| Group | Questions | Blocks | ${ARMS.join(' | ')} | A8 − S8 | W / L / T |`,
    `| --- | --- | --- | ${ARMS.map(() => '---').join(' | ')} | --- | --- |`,
  );
  for (const group of ['A', 'B', 'C', 'Unknown']) {
    const subset = completedPairs(completed.filter((row) => row.set === 'primary' && row.group === group));
    if (!subset.length) continue;
    const pair = comparePair(subset, 'A8', 'S8');
    lines.push(
      `| ${group} | ${subset.length} | ${blocksOf(subset).map(label).join(', ')} | ${ARMS.map((arm) => pct(rate(subset, arm))).join(' | ')} `
      + `| ${pp(pair.delta)} | ${pair.wins} / ${pair.losses} / ${pair.ties} |`,
    );
  }

  if (input.coverage && Object.keys(input.coverage).length) {
    lines.push(
      '',
      '## Source coverage',
      '',
      'The numeric blocks keep only questions whose gold reads as one integer or fraction. They are subsets, not whole benchmarks.',
      '',
      '| Source | Block | Rows | Eligible | Excluded |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const [name, row] of Object.entries(input.coverage)) {
      const excluded = Object.entries(row.excluded || {}).map(([reason, count]) => `${reason} ${count}`).join(', ') || 'none';
      lines.push(`| ${name} | ${label(row.block)} | ${row.total} | ${row.eligible} | ${excluded} |`);
    }
  }

  if (input.counters) {
    lines.push(
      '',
      '## Calls by stage',
      '',
      '| Stage | Calls | At cap | Length stop below cap | Loop stops | Kept after a second loop | Context refusals | In-flight credit retries | Failed |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const [stage, row] of Object.entries(input.counters)) {
      lines.push(
        `| ${stage} | ${row.calls} | ${row.cap} | ${row.belowCap ?? 0} | ${row.loopStops} | ${row.loopCut} | ${row.context} | `
        + `${row.creditRetries ?? 0} | ${row.failed} |`,
      );
    }
    lines.push(
      '',
      'A length stop below the cap is a sign to check for a provider clamp, not proof of one. An in-flight credit refusal is free and comes before any provider; '
      + 'the transport retries it once per run of a slot, and the retry counts toward the campaign POST cap but not as a model attempt.',
    );
    if (input.tailApplied) {
      lines.push(
        '',
        `Tail rule applied: Stage 1 answers ${input.tailApplied.stage1}, B samples ${input.tailApplied.samples}, judges ${input.tailApplied.stage2}.`,
      );
    }
    lines.push('', '| Arm | Outcome counts |', '| --- | --- |');
    for (const arm of ARMS) {
      const counts = statusCounts(completed, arm);
      if (!Object.keys(counts).length) continue;
      lines.push(`| ${arm} | ${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(', ')} |`);
    }
  }

  if (input.spend) {
    const spend = input.spend;
    lines.push(
      '',
      '## Cost',
      '',
      `Campaign: settled ${money(spend.settledUsd)}, still held ${money(spend.unresolvedUsd)}, ${spend.posts} POSTs of ${input.maxPosts}; cap $${input.maxUsd}.`,
    );
    if (spend.audit) {
      lines.push(`Key usage at the last audit: ${spend.audit.usage ?? 'n/a'} (an audit only; it never releases a reserve).`);
    }
    if (input.armCost) {
      const cost = input.armCost;
      lines.push(
        `Test questions, paid once: ${money(cost.test)}. Standalone, with B's first answer counted in both: A8 ${money(cost.A8)}, S8 ${money(cost.S8)}. `
        + `Held reserves inside these: A8 ${money(cost.heldA8)}, S8 ${money(cost.heldS8)}. Retries count toward their own arm.`,
        `Preparation phases (probe, dev, smoke, pilot, self-test): ${money(Number(spend.settledUsd || 0) + Number(spend.unresolvedUsd || 0) - cost.test)}. `
        + 'No claim is made about efficiency at an equal budget.',
      );
    }
  }
  if (input.gold) lines.push('', input.gold);
  if (input.caps) {
    lines.push(
      '',
      `Caps: one cap of ${input.caps.stage1} tokens on every stage. Loop guard: ${input.loopGuard ? 'on' : 'off'}. `
      + `Tail rule: ${input.tailRule ? `last ${input.tailRule.chars} characters of a cut reasoning, marked` : 'off'}.`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
