// How the red team of campaign `main` (A6) ended, how its verdict reads, and
// what A6 and A7 scored on the same question, for each stored layer of that
// run: as run, repair, complete. Offline: no network, no model call, no write
// outside the output directory. Not part of the hashed method.
//
//   node eval/tools/redteam_main_audit.js [--out <dir>]
//
// The labels (a diagnostic, not a pre-registered test; the template label was
// widened after a first look at the counts, from a template line alone to the
// template anywhere in the reply):
//   ending        the A6 red-team slot of the question in that layer's journal:
//                 stop, cap (finish length), finish_<reason>, failed: <kind of
//                 failure>, skipped, or no call.
//   engine        the verdict the question record stored (what the chairman of
//                 A6 was shown); "missing" when the record has none.
//   clean         the reply read by the clean rule of redteam-probe-v1: the
//                 last line holding exactly one verdict word. Without one:
//                 "template in text" when the reply holds the prompt's
//                 three-word template (the engine then reads REFUTED), "none"
//                 otherwise, "no text" without a reply.
//   outcome       A6 and A7 as stored: both right, A6 only, A7 only, both wrong.
// Grades are the stored ones of each layer; no gold is changed here.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRedTeamVerdict } from '../../src/engine/browser/council.js';
import { questionRecords } from '../campaignData.js';
import { failureKind } from '../grade.js';
import { flagValue, mdTable as table } from '../noteTools.js';
import { cleanReading } from '../redTeamProbe.js';
import { readSlotJournal } from '../runtime.js';

const EVAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(EVAL_ROOT, '.runs', 'main');

export const LAYERS = Object.freeze([
  { name: 'as run', journal: path.join(MAIN, 'events.jsonl'), questions: path.join(MAIN, 'questions') },
  { name: 'repair', journal: path.join(MAIN, 'repair', 'events.jsonl'), questions: path.join(MAIN, 'repair', 'questions') },
  { name: 'complete', journal: path.join(MAIN, 'complete', 'events.jsonl'), questions: path.join(MAIN, 'complete', 'questions') },
]);
export const OUTCOMES = Object.freeze(['both right', 'A6 only', 'A7 only', 'both wrong']);

export function rtEnding(slot) {
  if (!slot) return 'no call';
  if (slot.state === 'completed' && slot.result?.ok !== false) {
    const finish = slot.result?.finishReason ?? slot.finishReason ?? null;
    if (finish === 'stop') return 'stop';
    if (finish === 'length') return 'cap';
    return `finish_${finish ?? 'unknown'}`;
  }
  if (slot.state === 'skipped' || slot.result?.skipped) return 'skipped';
  return `failed: ${failureKind(slot.result)}`;
}

const TEMPLATE = /REFUTED\s*\|\s*CONTESTED\s*\|\s*UPHELD/i;

export function cleanVerdict(text) {
  if (!String(text || '').trim()) return 'no text';
  const reading = cleanReading(text);
  if (reading.verdict) return reading.verdict;
  return TEMPLATE.test(text) ? 'template in text' : 'none';
}

export function outcomeOf(a6, a7) {
  const left = a6?.correct === 1;
  const right = a7?.correct === 1;
  if (left && right) return 'both right';
  if (left) return 'A6 only';
  if (right) return 'A7 only';
  return 'both wrong';
}

// One row per test question of a layer.
export function layerRows(layer) {
  const slots = new Map();
  for (const slot of readSlotJournal(layer.journal).values()) {
    if (slot.meta?.stage !== 'redteam' || slot.meta?.branch !== 'A6') continue;
    const id = slot.meta.questionId;
    if (slots.has(id)) throw new Error(`${layer.name}: more than one A6 red-team slot for ${id}`);
    slots.set(id, slot);
  }
  return questionRecords(layer.questions, 'test_')
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((record) => {
      const slot = slots.get(record.id) || null;
      const text = slot?.result?.ok === false ? '' : (slot?.result?.content || '');
      const ending = rtEnding(slot);
      return {
        id: record.id,
        block: record.block,
        rtModel: slot?.meta?.model ?? null,
        ending,
        engine: record.redTeamVerdict ?? 'missing',
        // The verdict the engine reads from the same reply, to check that the
        // record and the journal agree.
        engineFromText: ending === 'stop' || ending === 'cap' || ending.startsWith('finish_') ? parseRedTeamVerdict(text).verdict : null,
        clean: cleanVerdict(text),
        outcome: outcomeOf(record.arms?.A6, record.arms?.A7),
      };
    });
}

function countRows(rows, keyOf) {
  const out = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const entry = out.get(key) || Object.fromEntries(OUTCOMES.map((name) => [name, 0]));
    entry[row.outcome] += 1;
    out.set(key, entry);
  }
  return [...out.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function summarize(rows) {
  const wins = rows.filter((row) => row.outcome === 'A6 only').length;
  const losses = rows.filter((row) => row.outcome === 'A7 only').length;
  return {
    questions: rows.length,
    wins,
    losses,
    byEnding: countRows(rows, (row) => row.ending),
    byVerdict: countRows(rows, (row) => `${row.engine} / ${row.clean}`),
    capLosses: rows.filter((row) => row.ending === 'cap' && row.outcome === 'A7 only').length,
    readDiffers: rows.filter((row) => row.engineFromText && row.engine !== 'missing' && row.engineFromText !== row.clean).length,
    recordMismatch: rows.filter((row) => row.engineFromText && row.engineFromText !== row.engine).map((row) => row.id),
  };
}

function renderCounts(title, entries) {
  return [
    `| ${title} | ${OUTCOMES.join(' | ')} | Questions |`,
    `|---|${OUTCOMES.map(() => '---').join('|')}|---|`,
    ...entries.map(([key, entry]) => `| ${key} | ${OUTCOMES.map((name) => entry[name]).join(' | ')} | ${OUTCOMES.reduce((sum, name) => sum + entry[name], 0)} |`),
  ];
}

export function renderAudit(layers) {
  const lines = [
    '# Red team of campaign `main`: endings, verdicts and A6 against A7',
    '',
    'Built by `eval/tools/redteam_main_audit.js` from the stored journals and question records of `.runs/main`. No new calls. "A6 only" is a question A6 got right and A7 did not; "A7 only" the reverse.',
    '',
    ...table(['Layer', 'Questions', 'A6 only', 'A7 only', 'A7 only with RT at the cap', 'Engine and clean verdict differ', 'Record differs from journal'], layers.map(({ name, summary }) => [
      name, summary.questions, summary.wins, summary.losses, summary.capLosses, summary.readDiffers, summary.recordMismatch.length,
    ])),
  ];
  for (const { name, summary } of layers) {
    lines.push('', `## ${name}`, '', ...renderCounts('RT ending', summary.byEnding), '', ...renderCounts('Engine verdict / clean verdict', summary.byVerdict));
    if (summary.recordMismatch.length) lines.push('', `Record and journal disagree on: ${summary.recordMismatch.join(', ')}.`);
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const outDir = path.resolve(flagValue(argv, '--out') || path.join(EVAL_ROOT, '.runs', 'redteam-main-audit'));
  const layers = LAYERS.map((layer) => {
    const rows = layerRows(layer);
    return { name: layer.name, rows, summary: summarize(rows) };
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'audit.json'), `${JSON.stringify(layers.map(({ name, rows, summary }) => ({ name, summary, rows })), null, 2)}\n`);
  writeFileSync(path.join(outDir, 'audit.md'), renderAudit(layers));
  console.log(JSON.stringify(layers.map(({ name, summary }) => ({ name, questions: summary.questions, wins: summary.wins, losses: summary.losses, capLosses: summary.capLosses, readDiffers: summary.readDiffers, recordMismatch: summary.recordMismatch.length }))));
  console.log(`written: ${path.join(outDir, 'audit.md')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
