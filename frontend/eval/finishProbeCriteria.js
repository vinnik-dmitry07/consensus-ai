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
