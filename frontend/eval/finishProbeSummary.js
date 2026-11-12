// The closing summary of finish-probe v1, v2, and v3. It reads the stored
// journals and reports of the three rounds and sends no model call. Every
// number in report.json, report.md, and the README block is computed here.
// The frozen files of v3 (V3_FILES) are imported, never changed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cellKey, cellState, loadSource, orderCells } from './finishProbe.js';
import { evaluateBounded, isConfirmed } from './finishProbeCriteria.js';
import { budgetTotals, labelSpend, mergedSlots, stageIndex } from './finishProbeV2.js';
import {
  ARMS, COUNCIL, HY4, STAGE1, STEPFUN, V3_CAPS, allCells, handRecount, labelsOf, moneyOf, outcomesFor, stageCells, v3Paths,
} from './finishProbeV3.js';
import { ANALYSIS_LIMITS, median, placeAfter, placeAnalysis, readJson, readJsonl, rewriteFile, ruleFiles } from './noteTools.js';
import { readSlotJournal } from './runtime.js';

export { median };

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(EVAL_ROOT, '.runs');
export const SUMMARY_RUN = 'finish-probe-summary';
export const SOURCE_RUN = 'a8-open-v5e';
export const BASE_CAP = 2048;
const LABELS_V2 = 'finish-probe-v2-labels.json';
const README = path.join(EVAL_ROOT, 'README.md');
export const README_START = '<!-- finish-probe-summary:start -->';
export const README_END = '<!-- finish-probe-summary:end -->';
export const AFTER_V3 = '<!-- finish-probe-v3-analysis:end -->';
export const GROUPS = Object.freeze(['firm', 'candidate', 'none', 'unlabelled']);

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function journalIndex(file) {
  return existsSync(file) ? stageIndex([...readSlotJournal(file).values()]) : new Map();
}

export function summaryPaths(root = RUNS_ROOT) {
  const dir = path.join(root, SUMMARY_RUN);
  const v1 = path.join(root, 'finish-probe-v1');
  const v2 = path.join(root, 'finish-probe-v2');
  return {
    report: path.join(dir, 'report.json'),
    reportMd: path.join(dir, 'report.md'),
    readme: path.join(dir, 'readme-block.md'),
    analysis: path.join(dir, 'analysis'),
    v1: { report: path.join(v1, 'report.json'), budget: path.join(v1, 'budget.jsonl') },
    v2: { report: path.join(v2, 'report.json'), budget: path.join(v2, 'budget.jsonl'), labels: path.join(v2, 'labels', 'calls.jsonl'), analysis: path.join(v2, 'analysis', 'calls.jsonl') },
    v3: v3Paths(root),
  };
}

const stateOf = (row) => (row?.v3 === 'accepted' || row?.v3 === 'rejected' ? row.v3 : 'unconfirmed');
const STATES = Object.freeze(['accepted', 'rejected']);

// Rows: the class of a cell at 2048 (`to` plus unconfirmed); columns: its class
// at 8192 (`to`). Only cells v3 confirmed are counted.
function crossTable(list, at2048, at8192, classify, to) {
  const table = Object.fromEntries([...to, 'unconfirmed'].map((from) => [from, Object.fromEntries(to.map((key) => [key, 0]))]));
  for (const cell of list) table[classify(at2048.get(cell.id))][classify(at8192.get(cell.id))] += 1;
  return table;
}

// The markdown rows of a crossTable; the unconfirmed row only when it holds a cell.
function crossRows(table, to, label = (key) => key) {
  return [...to, 'unconfirmed']
    .filter((from) => from !== 'unconfirmed' || to.some((key) => table[from][key] > 0))
    .map((from) => `| ${label(from)} | ${to.map((key) => table[from][key]).join(' | ')} |`);
}

// The same StepFun F cells at the 2048 cap (v1 and v2) and at 8192 (v3), on
// every cell v3 confirmed.
export function transitions(cells, at2048, at8192) {
  const list = cells.filter((cell) => isConfirmed(at8192.get(cell.id)));
  const table = crossTable(list, at2048, at8192, stateOf, STATES);
  const side = (outcome) => {
    const rows = list.map((cell) => outcome.get(cell.id));
    const accepted = rows.filter((row) => row?.v3 === 'accepted');
    const cut = rows.filter((row) => row?.v3 === 'rejected');
    const tokens = (group) => group.map((row) => Number(row.completionTokens)).filter(Number.isFinite);
    const money = (group) => group.map((row) => row.cost).filter(Number.isFinite);
    const seconds = (group) => group.map((row) => row.serviceMs).filter((value) => Number.isFinite(value) && value > 0).map((value) => value / 1000);
    const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
    return {
      accepted: accepted.length,
      correct: accepted.filter((row) => row.correct === 1).length,
      rejected: cut.length,
      acceptedTokensMedian: median(tokens(accepted)),
      acceptedTokensMax: tokens(accepted).length ? Math.max(...tokens(accepted)) : null,
      acceptedMeanUsd: mean(money(accepted)),
      rejectedMeanUsd: mean(money(cut)),
      acceptedMedianSeconds: median(seconds(accepted)),
      rejectedMedianSeconds: median(seconds(cut)),
    };
  };
  return { n: list.length, table, at2048: side(at2048), at8192: side(at8192) };
}

// Acceptance and correctness of the F outcomes of these inputs.
function tally(list, outcome) {
  const rows = list.map((item) => outcome.get(`${item.id}|F`));
  return {
    n: list.length,
    accepted: rows.filter((row) => row?.v3 === 'accepted').length,
    correct: rows.filter((row) => row?.v3 === 'accepted' && row.correct === 1).length,
    wrong: rows.filter((row) => row?.v3 === 'accepted' && row.correct !== 1).length,
    rejected: rows.filter((row) => row?.v3 === 'rejected').length,
    unconfirmed: rows.filter((row) => !isConfirmed(row)).length,
  };
}

// Acceptance and correctness of F by the v2 label group of the text.
export function byGroup(inputs, outcome, groups) {
  return Object.fromEntries(GROUPS.map((group) => [group, tally(inputs.filter((item) => (groups.get(item.id) || 'unlabelled') === group), outcome)]));
}

// The status both labelling passes gave the text (accepted, leading, none),
// without the gold. Texts where the passes differ are kept apart.
export const STATUSES = Object.freeze(['accepted', 'leading', 'none', 'differ', 'unlabelled']);

export function statusOf(item) {
  if (!item) return 'unlabelled';
  const a = item.passA?.status;
  const b = item.passB?.status;
  return a && a === b ? a : 'differ';
}

export function byStatus(inputs, outcome, labelItems) {
  return Object.fromEntries(STATUSES.map((status) => {
    // The status table has no wrong column.
    const { wrong: _wrong, ...counts } = tally(inputs.filter((item) => statusOf(labelItems.get(item.id)) === status), outcome);
    return [status, counts];
  }));
}

// right (accepted and correct), wrong (accepted, not correct), cut (rejected).
export const FORMS = Object.freeze(['right', 'wrong', 'cut']);

function formOf(row) {
  if (row?.v3 === 'accepted') return row.correct === 1 ? 'right' : 'wrong';
  return row?.v3 === 'rejected' ? 'cut' : 'unconfirmed';
}

export function correctnessTransitions(cells, at2048, at8192) {
  return crossTable(cells.filter((cell) => isConfirmed(at8192.get(cell.id))), at2048, at8192, formOf, FORMS);
}

// Every cell whose acceptance differs between the caps.
export function changedCells(cells, at2048, at8192, labelItems) {
  return cells
    .filter((cell) => isConfirmed(at8192.get(cell.id)) && stateOf(at2048.get(cell.id)) !== stateOf(at8192.get(cell.id)))
    .map((cell) => {
      const low = at2048.get(cell.id);
      const high = at8192.get(cell.id);
      return {
        cell: cell.sourceId,
        status: statusOf(labelItems.get(cell.sourceId)),
        at2048: { form: formOf(low), tokens: low?.completionTokens ?? null },
        at8192: { form: formOf(high), tokens: high?.completionTokens ?? null },
      };
    });
}

// What a correct recovered answer cost, per route and condition F.
export function pricePerCorrect(inputs, outcome, models, condition = 'F') {
  return models.map((model) => {
    const rows = inputs.filter((item) => item.model === model).map((item) => outcome.get(`${item.id}|${condition}`));
    const posted = rows.filter((row) => (row?.posts || 0) > 0);
    const usd = posted.map((row) => row.cost).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
    const correct = rows.filter((row) => row?.v3 === 'accepted' && row.correct === 1).length;
    return {
      route: model,
      n: rows.length,
      posted: posted.length,
      withoutCost: posted.filter((row) => !Number.isFinite(row.cost)).length,
      usd,
      accepted: rows.filter((row) => row?.v3 === 'accepted').length,
      correct,
      usdPerCorrect: correct ? usd / correct : null,
    };
  });
}

function stateCounts(cells, outcome) {
  const counts = { n: cells.length, accepted: 0, rejected: 0, unknown: 0, unmeasured: 0, pending: 0 };
  for (const cell of cells) counts[outcome.get(cell.id)?.v3 || 'pending'] += 1;
  return counts;
}

export function buildSummary(paths, source) {
  const { tasks, sources, rows, ctx } = source;
  const inputs = sources.filter((item) => item.kind === 'input');
  const cells = allCells(sources);
  const idx1 = journalIndex(paths.v3.v1.main);
  const idx2 = journalIndex(paths.v3.v2.main);
  const idx3 = journalIndex(paths.v3.events);
  // The 2048 reading: a v1 cell when v1 finished it, otherwise v2's, as in the v2 report.
  const at2048 = outcomesFor(cells, tasks, stageIndex(mergedSlots(cells, idx1, idx2)));
  const at8192 = outcomesFor(cells, tasks, idx3);
  const labelData = labelsOf(path.join(EVAL_ROOT, LABELS_V2));
  const groups = labelData.groups;
  const labelItems = new Map((labelData.data?.items || []).map((item) => [item.cell, item]));

  const v1Cells = orderCells(sources);
  const v1Done = v1Cells.filter((cell) => cellState(idx1.get(cellKey(cell))) === 'done').length;
  const v2Report = readJson(paths.v2.report);
  const v3Report = readJson(paths.v3.report);
  const v1Money = budgetTotals(readJsonl(paths.v1.budget));
  const v2Money = budgetTotals(readJsonl(paths.v2.budget), { maxUsd: 10, maxPosts: 500 });
  const v2Labels = labelSpend(readJsonl(paths.v2.labels));
  const v2Analysis = labelSpend(readJsonl(paths.v2.analysis));
  const v3Money = moneyOf(readJsonl(paths.v3.budget));
  const rounds = [
    {
      round: 'v1', caps: `${BASE_CAP} after a pilot`, capsRu: `${BASE_CAP} после пилота`, cells: v1Cells.length, done: v1Done,
      decision: readJson(paths.v1.report)?.result?.criteria?.decision ?? null,
      settledUsd: v1Money.settledUsd, heldUsd: v1Money.heldUsd, posts: v1Money.posts, extraUsd: 0, extraPosts: 0,
    },
    {
      round: 'v2', caps: `${BASE_CAP}`, capsRu: `${BASE_CAP}`, cells: v1Cells.length, done: v2Report?.extra ? v2Report.meta.origin.v1Done + v2Report.extra.v2Done : null,
      unmeasured: v2Report?.extra?.unavailable ?? null,
      heldNoModelUsd: v2Report?.extra?.held?.routeUnavailableUsd ?? null,
      decision: v2Report?.result?.criteria?.decision ?? null,
      settledUsd: v2Money.settledUsd, heldUsd: v2Money.heldUsd, posts: v2Money.posts,
      extraUsd: v2Labels.knownUsd + v2Analysis.knownUsd, extraPosts: v2Labels.calls + v2Analysis.calls,
    },
    {
      round: 'v3', caps: `${V3_CAPS[STEPFUN]} StepFun, ${BASE_CAP} others`, capsRu: `StepFun ${V3_CAPS[STEPFUN]}, остальные ${BASE_CAP}`, cells: cells.length,
      done: cells.filter((cell) => isConfirmed(at8192.get(cell.id))).length,
      decision: v3Report?.result?.decision?.code ?? null,
      settledUsd: v3Money.settledUsd, heldUsd: v3Money.heldUsd, posts: v3Money.posts,
      extraUsd: 0, extraPosts: 0,
    },
  ];

  const s1 = stageCells(1, sources);
  const bounded = evaluateBounded({ inputs, outcome: (id) => at2048.get(id), labels: groups, models: COUNCIL });
  const recount = handRecount({ rows, ctx, sources, outcome: (id) => at2048.get(id), primaryBlocks: source.campaign.primaryBlocks });
  const unmeasured = {
    hy4At2048: Object.fromEntries(['F', 'C'].map((condition) => [condition, inputs.filter((item) => item.model === HY4 && at2048.get(`${item.id}|${condition}`)?.v3 === 'unmeasured').length])),
    v3Stages: Object.fromEntries([1, 2, 3].map((stage) => [stage, stateCounts(stageCells(stage, sources), at8192)])),
    unlabelledInputs: inputs.filter((item) => !groups.has(item.id)).length,
  };
  const v3Stage1 = v3Report?.result?.stage1 ?? null;
  const corrections = {
    stage1Rule: STAGE1.stopAt,
    stage1Rejected: v3Stage1?.rejected ?? null,
    v3MoneyNow: { settledUsd: v3Money.settledUsd, posts: v3Money.posts, keyDelta: v3Money.key.delta },
  };
  const meta = {
    run: SUMMARY_RUN,
    sourceRun: SOURCE_RUN,
    inputs: inputs.length,
    syntheses: sources.length - inputs.length,
    questions: new Set(inputs.map((item) => item.questionId)).size,
    stepfunInputs: s1.length,
    stepfunQuestions: new Set(s1.map((cell) => cell.questionId)).size,
    labels: Object.fromEntries(['firm', 'candidate', 'none'].map((group) => [group, [...groups.values()].filter((value) => value === group).length])),
    rounds,
    total: {
      settledUsd: rounds.reduce((sum, row) => sum + row.settledUsd + row.extraUsd, 0),
      heldUsd: rounds.reduce((sum, row) => sum + row.heldUsd, 0),
      posts: rounds.reduce((sum, row) => sum + row.posts + row.extraPosts, 0),
    },
  };
  const result = {
    transitions: transitions(s1, at2048, at8192),
    groups2048: Object.fromEntries(COUNCIL.map((model) => [model, byGroup(inputs.filter((item) => item.model === model), at2048, groups)])),
    groups8192: byGroup(inputs.filter((item) => item.model === STEPFUN && isConfirmed(at8192.get(`${item.id}|F`))), at8192, groups),
    status2048: byStatus(inputs.filter((item) => item.model === STEPFUN), at2048, labelItems),
    status8192: byStatus(inputs.filter((item) => item.model === STEPFUN && isConfirmed(at8192.get(`${item.id}|F`))), at8192, labelItems),
    correctness: correctnessTransitions(s1, at2048, at8192),
    changed: changedCells(s1, at2048, at8192, labelItems),
    bounded,
    recount,
    v2Movement: v2Report?.result?.policies?.['fill:F']?.all?.movement ?? null,
    price2048: pricePerCorrect(inputs, at2048, COUNCIL),
    price8192: pricePerCorrect(inputs, at8192, [STEPFUN]),
    unmeasured,
    corrections,
  };
  return { meta, result };
}

// Rendering.

const pct = (value) => (value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const usd4 = (value) => (value == null ? 'n/a' : `$${Number(value).toFixed(4)}`);
const usd2 = (value) => (value == null ? 'n/a' : `$${Number(value).toFixed(2)}`);
const num = (value, digits = 1) => (value == null ? 'n/a' : Number(value).toFixed(digits).replace(/\.0+$/, ''));
const short = (model) => String(model).split('/')[0];
const span = (low, high) => (low === high ? `${low}` : `${low}..${high}`);
const armCell = (row) => `+${row.wins} / -${row.losses} / =${row.unchanged} / ?${row.undetermined}`;
const pp = (pair) => (pair?.delta == null ? 'n/a' : `${(pair.delta * 100).toFixed(1)}`);
const interval = (row) => (row?.low == null ? 'n/a' : `[${(row.low * 100).toFixed(1)}, ${(row.high * 100).toFixed(1)}]`);

function criteriaLines(c) {
  const lines = [];
  for (const [model, row] of Object.entries(c.c1.models)) {
    lines.push(`- 1, ${model}: accepted ${row.accepted}, rejected ${row.rejected}, unconfirmed ${row.unconfirmed} of ${row.n}; bounds ${pct(row.low)}–${pct(row.high)}; ${row.verdict}.`);
  }
  for (const [name, title] of [['c2', 'firm'], ['c3', 'firm and candidate']]) {
    const row = c[name];
    lines.push(`- ${name.slice(1)}, ${title}: correct ${span(row.correctLow, row.correctHigh)} of ${row.n} (unconfirmed ${row.unconfirmed}), need ${row.need}; question mean ${pct(row.questionMeanLow)}–${pct(row.questionMeanHigh)}; ${row.verdict}.`);
  }
  const f = c.c4;
  lines.push(`- 4, F over C on ${f.n} inputs: F correct ${f.fCorrect} (unconfirmed ${f.fUnconfirmed}), C correct ${f.cCorrect} (unconfirmed ${f.cUnconfirmed}); difference ${span(f.differenceLow, f.differenceHigh)} texts, need ${f.needDifference}; question mean ${pct(f.questionMeanLow)}–${pct(f.questionMeanHigh)}, need ${pct(2 / 23)}; ${f.verdict}.`);
  return lines;
}

function groupRows(table) {
  return GROUPS.map((group) => {
    const row = table[group];
    return `| ${group} | ${row.n} | ${row.accepted} | ${row.correct} | ${row.wrong} | ${row.rejected} | ${row.unconfirmed} |`;
  });
}

export function renderSummaryReport({ meta, result }) {
  const lines = ['# Finishing cut answers: summary of finish-probe v1, v2, and v3', ''];
  lines.push(`Source: ${meta.sourceRun}, read only: ${meta.inputs} cut inputs from ${meta.questions} questions and ${meta.syntheses} cut syntheses. StepFun has ${meta.stepfunInputs} inputs from ${meta.stepfunQuestions} questions. No call is sent for this summary.`);
  lines.push('Diagnostic only: the texts had been read, the golds and grader changed after the run, and these tables were chosen after the results of v1 to v3 were known. The decisions of the rounds stand as recorded.');
  lines.push('');
  lines.push('## Rounds', '', '| Round | Caps | Cells | With an outcome | Decision as recorded | Settled | Held | POSTs | Labels and analysis |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of meta.rounds) {
    const done = row.unmeasured != null ? `${row.done}, not measured ${row.unmeasured}` : `${row.done}`;
    lines.push(`| ${row.round} | ${row.caps} | ${row.cells} | ${done} | ${row.decision ?? 'n/a'} | ${usd4(row.settledUsd)} | ${usd4(row.heldUsd)} | ${row.posts} | ${row.extraPosts ? `${usd4(row.extraUsd)} in ${row.extraPosts} calls` : 'none'} |`);
  }
  lines.push('', `All rounds: settled ${usd4(meta.total.settledUsd)} with labels and analysis, held ${usd4(meta.total.heldUsd)}, ${meta.total.posts} POSTs and calls. Of the v2 held money, ${usd4(meta.rounds[1].heldNoModelUsd)} is the reserve of calls that got a 404 before any model (v2 report). v1 and v2 ran conditions F, T, and C; v3 sent StepFun F only.`, '');

  const t = result.transitions;
  lines.push('## StepFun F: the same cells at 2048 and at 8192', '', `Every StepFun F cell that v3 confirmed (${t.n}). Rows: outcome at 2048 (v1 or v2); columns: outcome at 8192 (v3).`, '', '| At 2048 | accepted at 8192 | rejected at 8192 |', '| --- | --- | --- |');
  lines.push(...crossRows(t.table, STATES));
  lines.push('', '| Cap | accepted | correct among accepted | rejected | accepted tokens median | accepted tokens max | mean $ accepted | mean $ rejected | median s accepted | median s rejected |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [cap, side] of [[BASE_CAP, t.at2048], [V3_CAPS[STEPFUN], t.at8192]]) {
    lines.push(`| ${cap} | ${side.accepted} | ${side.correct} | ${side.rejected} | ${num(side.acceptedTokensMedian)} | ${side.acceptedTokensMax ?? 'n/a'} | ${usd4(side.acceptedMeanUsd)} | ${usd4(side.rejectedMeanUsd)} | ${num(side.acceptedMedianSeconds)} | ${num(side.rejectedMedianSeconds)} |`);
  }
  lines.push('', 'The same cells by correctness: right (accepted and correct), wrong (accepted, not correct), cut (not accepted). One generation per cell and cap.', '', `| At 2048 | ${FORMS.map((form) => `${form} at 8192`).join(' | ')} |`, `| --- | ${FORMS.map(() => '---').join(' | ')} |`);
  lines.push(...crossRows(result.correctness, FORMS));
  lines.push('', 'Cells whose acceptance differs between the caps (status: what both labelling passes gave the text):', '');
  for (const row of result.changed) lines.push(`- ${row.cell}: status ${row.status}; 2048 ${row.at2048.form} (${row.at2048.tokens ?? 'n/a'} tokens), 8192 ${row.at8192.form} (${row.at8192.tokens ?? 'n/a'} tokens).`);
  lines.push('', '## F by the status both labelling passes gave the text', '', 'Each pass marks the value the text holds as accepted, leading, or none, without the gold. "differ": the passes disagree.', '');
  lines.push(`| Status | at 2048: accepted / correct / n | at 8192: accepted / correct / n |`, '| --- | --- | --- |');
  for (const status of STATUSES) {
    const low = result.status2048[status];
    const high = result.status8192[status];
    lines.push(`| ${status} | ${low.accepted} / ${low.correct} / ${low.n} | ${high.accepted} / ${high.correct} / ${high.n} |`);
  }
  lines.push('', '## F by the label group of the text', '', `Groups from the frozen v2 labels: ${JSON.stringify(meta.labels)}; the other texts are unlabelled. The groups compare the passes with the gold (finish-probe-protocol.md): firm, the accepted value equals the gold; candidate, the gold is among the leading values, or the passes give different groups; none, the gold was not treated as an answer, which includes a text that holds a wrong value. "correct" and "wrong" are among the accepted answers.`, '');
  for (const model of COUNCIL) {
    lines.push(`At 2048, ${model}:`, '', '| Group | n | accepted | correct | wrong | rejected | unconfirmed |', '| --- | --- | --- | --- | --- | --- | --- |', ...groupRows(result.groups2048[model]), '');
  }
  lines.push(`At 8192, ${STEPFUN}, cells v3 confirmed:`, '', '| Group | n | accepted | correct | wrong | rejected | unconfirmed |', '| --- | --- | --- | --- | --- | --- | --- |', ...groupRows(result.groups8192), '');

  lines.push('## v1 and v2 data read with the bounds of v3 (shown only)', '', 'The cells of v1 and v2, conditions F and C, read with the v3 cell states and bounded criteria. A 404 before generation is not measured. This does not change the decision of any round.', '', ...criteriaLines(result.bounded), '');

  const rc = result.recount;
  lines.push('## Recount of the arms at 2048', '', `All ${rc.rows} kept questions; primary set ${rc.primaryRows}. Cells: wins / losses / unchanged / undetermined (the arm reads a cell with no confirmed outcome).`, '', `| Policy | Against | ${ARMS.join(' | ')} |`, `| --- | --- | ${ARMS.map(() => '---').join(' | ')} |`);
  for (const policy of ['fill', 'all']) {
    lines.push(`| ${policy} | stored arms | ${ARMS.map((arm) => armCell(rc[policy].all[arm])).join(' | ')} |`);
    lines.push(`| ${policy} | fallback | ${ARMS.map((arm) => armCell(rc[policy].overFallback[arm])).join(' | ')} |`);
  }
  if (result.v2Movement) lines.push('', `The v2 report counts fill:F over the original as ${ARMS.map((arm) => `${arm} +${result.v2Movement[arm].wins} / -${result.v2Movement[arm].losses}`).join(', ')}. It takes a value where an arm reads a cell that got a 404; here such an arm is undetermined.`);
  lines.push('', '| Policy, primary set | A8 correct | S8 correct | A8 - S8, pp | wins/losses | 95% | 90% |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const [name, row] of [['original', rc.original], ['fallback', rc.fallback], ['fill', rc.fill], ['all', rc.all]]) {
    const pair = row.a8MinusS8;
    lines.push(`| ${name} | ${row.primaryCorrect.A8} | ${row.primaryCorrect.S8} | ${pp(pair)} | ${pair.wins}/${pair.losses} | ${interval(pair.interval)} | ${interval(pair.interval90)} |`);
  }
  lines.push('', '## Price of a correct recovered answer (condition F)', '', '| Cap | Route | inputs | posted | without a cost | spent | accepted | correct | $ per correct |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [cap, list] of [[BASE_CAP, result.price2048], [V3_CAPS[STEPFUN], result.price8192]]) {
    for (const row of list) lines.push(`| ${cap === BASE_CAP ? cap : `${cap} (v3)`} | ${row.route} | ${row.n} | ${row.posted} | ${row.withoutCost} | ${usd4(row.usd)} | ${row.accepted} | ${row.correct} | ${usd4(row.usdPerCorrect)} |`);
  }
  const u = result.unmeasured;
  lines.push('', '## Not measured', '');
  lines.push(`- hy4 at 2048: F ${u.hy4At2048.F}, C ${u.hy4At2048.C} cells got a 404 before generation.`);
  for (const [stage, row] of Object.entries(u.v3Stages)) lines.push(`- v3 stage ${stage}: ${row.n} cells, ${row.pending} not sent.`);
  lines.push(`- Labels: ${u.unlabelledInputs} of ${meta.inputs} inputs have no label.`);
  const c = result.corrections;
  lines.push('', '## Corrections to the v3 README block', '');
  lines.push(`- The stage-1 line shows the stop rule in brackets ("${c.stage1Rule} подтверждённых неуспехов"); the count of confirmed failures was ${c.stage1Rejected}.`);
  lines.push('- The A8 − S8 line ends with a double full stop after "п. п.".');
  lines.push(`- The block was first built before the two analysis calls. Rebuilt from the same frozen code after them, its money line reads settled ${usd2(c.v3MoneyNow.settledUsd)}, ${c.v3MoneyNow.posts} POSTs, key moved ${usd2(c.v3MoneyNow.keyDelta)}.`);
  lines.push('', 'The frozen v3 code is not edited for the first two: an edit would change its hash.');
  return lines.join('\n');
}

export function renderSummaryReadme({ meta, result }) {
  const t = result.transitions;
  const lines = [
    '### Итог серии finish-probe (v1–v3)',
    '',
    `Сводка трёх раундов дописывания на ${meta.inputs} оборванных входах (${meta.questions} вопросов) и ${meta.syntheses} синтезах a8-open-v5e. Новых вызовов нет: числа посчитаны кодом из журналов раундов. Таблицы выбраны после результатов, это диагностика; решения раундов остаются как записаны.`,
    '',
    '| Раунд | Лимит | Ячеек | С исходом | Решение раунда | Подтверждено | POST |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of meta.rounds) {
    const done = row.unmeasured != null ? `${row.done}, не измерено ${row.unmeasured}` : `${row.done}`;
    lines.push(`| ${row.round} | ${row.capsRu} | ${row.cells} | ${done} | \`${row.decision ?? 'n/a'}\` | ${usd2(row.settledUsd)} | ${row.posts} |`);
  }
  lines.push('', `Разметка и анализ v2 — ещё ${usd2(meta.rounds[1].extraUsd)}. Всего с ними ${usd2(meta.total.settledUsd)}, удержано ${usd2(meta.total.heldUsd)}, из них ${usd2(meta.rounds[1].heldNoModelUsd)} — резерв вызовов v2, получивших 404 до модели.`);
  lines.push('', `StepFun F, одни и те же ${t.n} ячеек при лимите ${BASE_CAP} и ${V3_CAPS[STEPFUN]}:`, '', `| При ${BASE_CAP} | принят при ${V3_CAPS[STEPFUN]} | не принят при ${V3_CAPS[STEPFUN]} |`, '| --- | --- | --- |');
  const ru = { accepted: 'принят', rejected: 'не принят', unconfirmed: 'без исхода' };
  lines.push(...crossRows(t.table, STATES, (from) => ru[from]));
  lines.push('', `Принято: при ${BASE_CAP} — ${t.at2048.accepted}, при ${V3_CAPS[STEPFUN]} — ${t.at8192.accepted}; верных среди принятых ${t.at2048.correct} и ${t.at8192.correct}. По верности (верно / неверно / не принят), строки при ${BASE_CAP}, столбцы при ${V3_CAPS[STEPFUN]}:`, '', `| При ${BASE_CAP} | верно | неверно | не принят |`, '| --- | --- | --- | --- |');
  const formRu = { right: 'верно', wrong: 'неверно', cut: 'не принят', unconfirmed: 'без исхода' };
  lines.push(...crossRows(result.correctness, FORMS, (from) => formRu[from]));
  const statusRu = { accepted: 'оба: значение принято', leading: 'оба: значение ведущее', none: 'оба: значения нет', differ: 'проходы разошлись', unlabelled: 'не размечен' };
  const s2 = result.status2048;
  const s8 = result.status8192;
  lines.push('', `StepFun F по статусу, который оба прохода разметки поставили тексту без эталона (принято / верно среди принятых / n):`, '', `| Статус текста | При ${BASE_CAP} | При ${V3_CAPS[STEPFUN]} |`, '| --- | --- | --- |');
  for (const status of STATUSES) lines.push(`| ${statusRu[status]} | ${s2[status].accepted} / ${s2[status].correct} / ${s2[status].n} | ${s8[status].accepted} / ${s8[status].correct} / ${s8[status].n} |`);
  const g = result.groups2048[STEPFUN];
  const g8 = result.groups8192;
  lines.push('', `Те же тексты по группам разметки v2, которые сравнивают значение текста с эталоном (finish-probe-protocol.md):`, '', `| Группа | При ${BASE_CAP} | При ${V3_CAPS[STEPFUN]} |`, '| --- | --- | --- |');
  const groupRu = { firm: 'firm: принятое значение равно эталону', candidate: 'candidate: эталон среди ведущих или проходы разошлись', none: 'none: эталон не выступал ответом', unlabelled: 'не размечен' };
  for (const group of GROUPS) lines.push(`| ${groupRu[group]} | ${g[group].accepted} / ${g[group].correct} / ${g[group].n} | ${g8[group].accepted} / ${g8[group].correct} / ${g8[group].n} |`);
  const rc = result.recount;
  lines.push('', `Пересчёт рук при ${BASE_CAP}, заполнение против fallback (выигрыши / потери / без изменения / неопределённо): ${ARMS.map((arm) => `${arm} ${armCell(rc.fill.overFallback[arm])}`).join('; ')}. A8 − S8 на основном наборе: исходно ${pp(rc.original.a8MinusS8)} п. п., fallback ${pp(rc.fallback.a8MinusS8)}, заполнение ${pp(rc.fill.a8MinusS8)} ${interval(rc.fill.a8MinusS8.interval)}.`);
  const verdictRu = { pass: 'выполнен', fail: 'не выполнен', not_evaluable: 'не определён' };
  const b = result.bounded;
  lines.push('', `Данные v1 и v2 в границах v3 (только показано): критерий 1 — ${Object.entries(b.c1.models).map(([model, row]) => `${short(model)} ${row.accepted} из ${row.n}, ${verdictRu[row.verdict]}`).join('; ')}; критерий 2 — ${verdictRu[b.c2.verdict]}; 3 — ${verdictRu[b.c3.verdict]}; 4 — ${verdictRu[b.c4.verdict]}.`);
  lines.push('', `Цена одного верного ответа F при ${BASE_CAP}: ${result.price2048.map((row) => `${short(row.route)} ${usd4(row.usdPerCorrect)} (${row.correct} верных)`).join(', ')}; StepFun при ${V3_CAPS[STEPFUN]} — ${usd4(result.price8192[0].usdPerCorrect)} (${result.price8192[0].correct} верных).`);
  const u = result.unmeasured;
  lines.push('', `Не измерено: hy4 при ${BASE_CAP} — F ${u.hy4At2048.F}, C ${u.hy4At2048.C} (404 до генерации); в v3 не отправлено ${u.v3Stages[1].pending + u.v3Stages[2].pending + u.v3Stages[3].pending} из ${u.v3Stages[1].n + u.v3Stages[2].n + u.v3Stages[3].n} ячеек; без разметки ${u.unlabelledInputs} из ${meta.inputs} входов.`);
  const c = result.corrections;
  lines.push('', `Поправки к блоку v3: в строке этапа 1 в скобках стоит порог правила (${c.stage1Rule}), подтверждённых неуспехов было ${c.stage1Rejected}; в строке A8 − S8 лишняя точка. Замороженный код v3 не правится, иначе сменится его хэш. Строка расхода блока v3 пересобрана после вызовов анализа.`);
  lines.push('', 'Полная сводка — `.runs/finish-probe-summary/report.md`. Воспроизвести без сети:', '', '```bash', 'node frontend/eval/finishProbeSummaryCli.js --phase report', '```');
  return lines.join('\n');
}

export function runSummaryReport(argv = [], paths = summaryPaths()) {
  const source = loadSource(SOURCE_RUN);
  const built = buildSummary(paths, source);
  writeJson(paths.report, built);
  writeFileSync(paths.reportMd, `${renderSummaryReport(built)}\n`, 'utf8');
  const block = renderSummaryReadme(built);
  writeFileSync(paths.readme, `${block}\n`, 'utf8');
  if (argv.includes('--readme')) {
    rewriteFile(README, (text) => placeAfter(text, README_START, README_END, block, AFTER_V3));
  }
  console.log(`summary written: ${paths.reportMd}`);
  return 0;
}

// Analysis: one OpenRouter model writes it from the summary and the rules of
// the three rounds; another checks it against the summary. Claude does not
// write or edit the text.

export const ANALYSIS_START = '<!-- finish-probe-summary-analysis:start -->';
export const ANALYSIS_END = '<!-- finish-probe-summary-analysis:end -->';
export const RULE_FILES = Object.freeze(['finish-probe-protocol.md', 'finish-probe-v2-protocol.md', 'finish-probe-v2-addendum.md', 'finish-probe-v3-protocol.md']);
export const SUMMARY_INSTRUCTION = [
  'You analyse the closing summary of a series of three diagnostic rounds (v1, v2, v3) for the README of the project. The rules of the rounds and the summary are given below as data.',
  'Write the body of a section titled "Анализ серии", in Russian, 200 to 350 words, as short paragraphs or a short list. No heading: the heading is added separately.',
  'Use only numbers that appear in the summary. Do not introduce any other number.',
  'Cover: what each round decided under its own rule; what the same StepFun cells at the two caps show; what the label groups show; what the recount of the arms shows; what stays unmeasured; the main limits.',
  'Do not present any follow-up experiment as decided. You may say what stays open.',
  'Return only the text of the section.',
].join('\n');

export function summaryAnalysisSection(text, check, writer, checker) {
  return [
    '#### Анализ серии',
    '',
    `_Текст написала модель ${writer} через OpenRouter по \`.runs/finish-probe-summary/report.md\` и правилам трёх раундов; модель ${checker} сверила его со сводкой (замечаний: ${check.problems.length}). Claude этот текст не писал и не правил._`,
    '',
    String(text).trim(),
  ].join('\n');
}

export function runSummaryAnalysis(paths = summaryPaths()) {
  if (!existsSync(paths.reportMd)) throw new Error('Build the summary first.');
  return placeAnalysis({
    dir: paths.analysis,
    instruction: SUMMARY_INSTRUCTION,
    rules: ruleFiles(EVAL_ROOT, RULE_FILES),
    report: readFileSync(paths.reportMd, 'utf8'),
    limits: ANALYSIS_LIMITS,
    readme: README,
    start: ANALYSIS_START,
    end: ANALYSIS_END,
    after: README_END,
    section: (record) => summaryAnalysisSection(record.text, record.check, record.writer, record.checker),
    showHeld: true,
  });
}
