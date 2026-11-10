// The four criteria in whole texts, under finish-probe-v2-addendum.md, B.1.
// The v1 code compares floating shares, so at a difference of exactly 10 texts
// criterion 4 can fail although it holds. Here every count is compared as an
// integer, and every mean over questions with a tolerance of 1e-9. The groups,
// incompleteness, and the decision rule are those of evaluateCriteria.

import { decide } from './finishProbe.js';

export const TOLERANCE = 1e-9;
const INCOMPLETE = new Set(['pending', 'unknown', 'failed']);

function byQuestionMean(items, value) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.questionId)) groups.set(item.questionId, []);
    groups.get(item.questionId).push(value(item));
  }
  if (!groups.size) return null;
  let sum = 0;
  for (const list of groups.values()) sum += list.reduce((a, b) => a + b, 0) / list.length;
  return sum / groups.size;
}

// The smallest integer k with k / n >= num / den.
export function needOf(n, num, den) {
  return Math.floor((num * n + den - 1) / den);
}

function shareRule(items, outcome, num, den) {
  const correct = items.filter((item) => outcome(item).correct === 1).length;
  const need = needOf(items.length, num, den);
  const mean = byQuestionMean(items, (item) => outcome(item).correct);
  const incomplete = items.filter((item) => INCOMPLETE.has(outcome(item).state)).length;
  let verdict;
  if (!items.length) verdict = 'fail';
  else if (incomplete) verdict = 'undetermined';
  else verdict = correct >= need && mean >= num / den - TOLERANCE ? 'pass' : 'fail';
  return { n: items.length, correct, need, questionMean: mean, incomplete, verdict };
}

export function evaluateExact({ inputs, outcome, labels, models }) {
  const of = (item, condition) => outcome(`${item.id}|${condition}`) || { state: 'pending', correct: 0, accepted: false };
  const f = (item) => of(item, 'F');
  const c = (item) => of(item, 'C');
  const c1 = {};
  let c1Verdict = 'pass';
  for (const model of models) {
    const list = inputs.filter((item) => item.model === model);
    const accepted = list.filter((item) => f(item).accepted).length;
    const incomplete = list.filter((item) => INCOMPLETE.has(f(item).state)).length;
    const verdict = !list.length || incomplete ? 'undetermined' : (accepted * 10 >= 9 * list.length ? 'pass' : 'fail');
    c1[model] = { n: list.length, accepted, incomplete, verdict };
    if (verdict === 'fail') c1Verdict = 'fail';
    else if (verdict === 'undetermined' && c1Verdict !== 'fail') c1Verdict = 'undetermined';
  }
  const firm = inputs.filter((item) => labels.get(item.id) === 'firm');
  const both = inputs.filter((item) => ['firm', 'candidate'].includes(labels.get(item.id)));
  const c2 = shareRule(firm, f, 8, 10);
  const c3 = shareRule(both, f, 5, 10);
  const n = inputs.length;
  const fCorrect = inputs.filter((item) => f(item).correct === 1).length;
  const cCorrect = inputs.filter((item) => c(item).correct === 1).length;
  const margin = 10 / 115;
  const meanDiff = byQuestionMean(inputs, (item) => f(item).correct - c(item).correct);
  const incomplete4 = inputs.filter((item) => INCOMPLETE.has(f(item).state) || INCOMPLETE.has(c(item).state)).length;
  let c4Verdict;
  if (!n) c4Verdict = 'fail';
  else if (incomplete4) c4Verdict = 'undetermined';
  else c4Verdict = ((fCorrect - cCorrect) * 115 >= 10 * n && meanDiff >= margin - TOLERANCE) ? 'pass' : 'fail';
  const c4 = {
    fCorrect, cCorrect, n,
    fRate: n ? fCorrect / n : null,
    cRate: n ? cCorrect / n : null,
    difference: n ? (fCorrect - cCorrect) / n : null,
    questionMeanDifference: meanDiff,
    margin,
    incomplete: incomplete4,
    verdict: c4Verdict,
  };
  return { c1: { models: c1, verdict: c1Verdict }, c2, c3, c4, decision: decide(c1Verdict, c2.verdict, c3.verdict, c4Verdict) };
}

export function leaveOneOutExact({ inputs, outcome, labels, models }) {
  const base = evaluateExact({ inputs, outcome, labels, models });
  const questions = [...new Set(inputs.map((item) => item.questionId))];
  const flips = [];
  for (const question of questions) {
    const rest = evaluateExact({ inputs: inputs.filter((item) => item.questionId !== question), outcome, labels, models });
    for (const name of ['c2', 'c3', 'c4']) {
      if (rest[name].verdict !== base[name].verdict) flips.push({ question, criterion: name, from: base[name].verdict, to: rest[name].verdict });
    }
  }
  return flips;
}

// Where the floating comparison of the v1 code gives another verdict.
export function verdictDifferences(exact, floating) {
  const out = [];
  for (const [model, row] of Object.entries(exact.c1.models)) {
    if (floating.c1.models[model]?.verdict !== row.verdict) out.push({ criterion: `c1 ${model}`, exact: row.verdict, floating: floating.c1.models[model]?.verdict });
  }
  for (const name of ['c2', 'c3', 'c4']) {
    if (floating[name].verdict !== exact[name].verdict) out.push({ criterion: name, exact: exact[name].verdict, floating: floating[name].verdict });
  }
  if (floating.decision !== exact.decision) out.push({ criterion: 'decision', exact: exact.decision, floating: floating.decision });
  return out;
}

// finish-probe-v3: bounds and three verdicts, under finish-probe-v3-protocol.md.
// A cell is confirmed when a generation was received and read: 'accepted' or
// 'rejected'. Every other cell (not measured, outcome unknown, not sent) is
// unconfirmed. A criterion passes when it holds with every unconfirmed cell set
// against it, fails when it does not hold even with every unconfirmed cell set
// in its favour, and is otherwise not evaluable. All comparisons are exact:
// integer counts, and means over questions as fractions in BigInt.

export const CONFIRMED = Object.freeze(['accepted', 'rejected']);

export function isConfirmed(outcome) {
  return CONFIRMED.includes(outcome?.v3);
}

function absBig(value) {
  return value < 0n ? -value : value;
}

function gcdBig(left, right) {
  let a = absBig(left);
  let b = absBig(right);
  while (b) [a, b] = [b, a % b];
  return a;
}

function lcmBig(left, right) {
  return (left / gcdBig(left, right)) * right;
}

function questionSums(items, value) {
  const groups = new Map();
  for (const item of items) {
    const row = groups.get(item.questionId) || { sum: 0, n: 0 };
    row.sum += value(item);
    row.n += 1;
    groups.set(item.questionId, row);
  }
  return [...groups.values()];
}

// Whether the mean over questions of the per-question mean of `value` is at
// least num/den, in exact arithmetic. An empty list never holds.
export function questionMeanAtLeast(items, value, num, den) {
  const groups = questionSums(items, value);
  if (!groups.length) return false;
  let common = 1n;
  for (const row of groups) common = lcmBig(common, BigInt(row.n));
  let total = 0n;
  for (const row of groups) total += BigInt(row.sum) * (common / BigInt(row.n));
  return total * BigInt(den) >= BigInt(num) * BigInt(groups.length) * common;
}

export function questionMean(items, value) {
  const groups = questionSums(items, value);
  if (!groups.length) return null;
  return groups.reduce((sum, row) => sum + row.sum / row.n, 0) / groups.length;
}

export function threeWay(lowHolds, highHolds) {
  if (lowHolds) return 'pass';
  if (!highHolds) return 'fail';
  return 'not_evaluable';
}

// Correct with every unconfirmed cell set to wrong, and set to right.
const lowCorrect = (outcome) => (isConfirmed(outcome) && outcome.correct === 1 ? 1 : 0);
const highCorrect = (outcome) => (isConfirmed(outcome) ? (outcome.correct === 1 ? 1 : 0) : 1);

// Criterion 1 for one route: bounds a/N and (a + u)/N.
export function criterion1Bounded(list, f) {
  const n = list.length;
  const accepted = list.filter((item) => f(item)?.v3 === 'accepted').length;
  const rejected = list.filter((item) => f(item)?.v3 === 'rejected').length;
  const unconfirmed = n - accepted - rejected;
  const verdict = n ? threeWay(10 * accepted >= 9 * n, 10 * (accepted + unconfirmed) >= 9 * n) : 'fail';
  return { n, accepted, rejected, unconfirmed, low: n ? accepted / n : null, high: n ? (accepted + unconfirmed) / n : null, verdict };
}

// Criteria 2 and 3: at least ceil(num/den x N) correct, and a question mean of
// at least num/den. An empty group does not pass.
export function shareBounded(items, f, num, den) {
  const n = items.length;
  const need = needOf(n, num, den);
  const holds = (pick) => n > 0
    && items.reduce((sum, item) => sum + pick(f(item)), 0) >= need
    && questionMeanAtLeast(items, (item) => pick(f(item)), num, den);
  return {
    n,
    need,
    correctLow: items.reduce((sum, item) => sum + lowCorrect(f(item)), 0),
    correctHigh: items.reduce((sum, item) => sum + highCorrect(f(item)), 0),
    unconfirmed: items.filter((item) => !isConfirmed(f(item))).length,
    questionMeanLow: questionMean(items, (item) => lowCorrect(f(item))),
    questionMeanHigh: questionMean(items, (item) => highCorrect(f(item))),
    verdict: n ? threeWay(holds(lowCorrect), holds(highCorrect)) : 'fail',
  };
}

// Criterion 4: 115 x (K_F - K_C) >= 10 x N, and the question mean of F - C at
// least 2/23 (= 10/115). The low bound sets an unconfirmed F wrong and an
// unconfirmed C right; the high bound the other way round.
export function criterion4Bounded(inputs, f, c) {
  const n = inputs.length;
  const diffLow = (item) => lowCorrect(f(item)) - highCorrect(c(item));
  const diffHigh = (item) => highCorrect(f(item)) - lowCorrect(c(item));
  const sum = (value) => inputs.reduce((total, item) => total + value(item), 0);
  const holds = (value) => n > 0 && 115 * sum(value) >= 10 * n && questionMeanAtLeast(inputs, value, 2, 23);
  return {
    n,
    needDifference: needOf(n, 10, 115),
    fCorrect: sum((item) => lowCorrect(f(item))),
    cCorrect: sum((item) => lowCorrect(c(item))),
    fUnconfirmed: inputs.filter((item) => !isConfirmed(f(item))).length,
    cUnconfirmed: inputs.filter((item) => !isConfirmed(c(item))).length,
    differenceLow: sum(diffLow),
    differenceHigh: sum(diffHigh),
    questionMeanLow: questionMean(inputs, diffLow),
    questionMeanHigh: questionMean(inputs, diffHigh),
    verdict: n ? threeWay(holds(diffLow), holds(diffHigh)) : 'fail',
  };
}

function combine(verdicts) {
  if (verdicts.includes('fail')) return 'fail';
  if (verdicts.includes('not_evaluable')) return 'not_evaluable';
  return 'pass';
}

export function evaluateBounded({ inputs, outcome, labels, models }) {
  const pending = { v3: 'pending', correct: 0, accepted: false };
  const f = (item) => outcome(`${item.id}|F`) || pending;
  const c = (item) => outcome(`${item.id}|C`) || pending;
  const routes = {};
  for (const model of models) routes[model] = criterion1Bounded(inputs.filter((item) => item.model === model), f);
  const firm = inputs.filter((item) => labels.get(item.id) === 'firm');
  const both = inputs.filter((item) => ['firm', 'candidate'].includes(labels.get(item.id)));
  return {
    c1: { models: routes, verdict: models.length ? combine(Object.values(routes).map((row) => row.verdict)) : 'fail' },
    c2: shareBounded(firm, f, 8, 10),
    c3: shareBounded(both, f, 5, 10),
    c4: criterion4Bounded(inputs, f, c),
  };
}

export function allPass(criteria) {
  return [criteria.c1.verdict, criteria.c2.verdict, criteria.c3.verdict, criteria.c4.verdict].every((verdict) => verdict === 'pass');
}

// The decision table of the v3 plan. `winArms` are the arms with at least one
// win under the fill policy.
export function decideV3(criteria, winArms = []) {
  const core = [criteria.c1.verdict, criteria.c2.verdict, criteria.c3.verdict];
  if (core.includes('fail')) return { code: 'threshold_not_reached', arms: [] };
  if (core.includes('not_evaluable')) return { code: 'incomplete', arms: [] };
  if (criteria.c4.verdict === 'fail') return { code: 'text_benefit_not_shown', arms: [] };
  if (criteria.c4.verdict === 'not_evaluable') return { code: 'incomplete', arms: [] };
  if (!winArms.length) return { code: 'nothing_to_recommend', arms: [] };
  return { code: 'confirm_on_new_questions', arms: [...winArms] };
}

export function leaveOneOutBounded({ inputs, outcome, labels, models }) {
  const base = evaluateBounded({ inputs, outcome, labels, models });
  const flips = [];
  for (const question of [...new Set(inputs.map((item) => item.questionId))]) {
    const rest = evaluateBounded({ inputs: inputs.filter((item) => item.questionId !== question), outcome, labels, models });
    for (const name of ['c2', 'c3', 'c4']) {
      if (rest[name].verdict !== base[name].verdict) flips.push({ question, criterion: name, from: base[name].verdict, to: rest[name].verdict });
    }
  }
  return flips;
}
