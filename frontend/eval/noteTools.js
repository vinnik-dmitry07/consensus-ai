// Helpers shared by the README-block, gate, route, and offline tools that sit
// outside the frozen finish-probe files (V2_FILES, V3_FILES, V4_FILES) and
// outside the a8 method hash (SOURCE_FILES in a8.js). Changing this file
// changes no frozen hash.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonAnswer } from './grade.js';
import { replaceSection } from './report.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const readJson = (file, fallback = null) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
export const readJsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
export const envKey = () => String(process.env.or_key || process.env.OR_KEY || '').trim();
// Money and POST limits of one written-and-checked analysis.
export const ANALYSIS_LIMITS = Object.freeze({ maxUsd: 0.5, maxPosts: 8 });

export function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? null : (argv[index + 1] ?? null);
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// A markdown table: header row, separator, one row per list of cells.
export function mdTable(header, body) {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...body.map((cells) => `| ${cells.join(' | ')} |`)];
}

// The section between start and end replaced, or placed right after `after`.
export function placeAfter(readme, start, end, body, after) {
  const replaced = replaceSection(readme, start, end, `\n${body}\n`);
  if (replaced != null) return replaced;
  const at = readme.indexOf(after);
  if (at < 0) throw new Error(`${after} is not in the README`);
  const cut = at + after.length;
  return `${readme.slice(0, cut)}\n\n${start}\n\n${body}\n\n${end}${readme.slice(cut)}`;
}

// The section between start and end replaced, or placed right before `before`.
export function placeBefore(readme, start, end, body, before) {
  const replaced = replaceSection(readme, start, end, `\n${body}\n`);
  if (replaced != null) return replaced;
  const at = readme.indexOf(before);
  if (at < 0) throw new Error(`${before} is not in the README`);
  return `${readme.slice(0, at)}${start}\n\n${body}\n\n${end}\n\n${readme.slice(at)}`;
}

// A file keeps the line endings it has (a checkout may hold it with CRLF): the
// change is made on an LF copy and written back in the file's own form.
export function withLineEndings(original, change) {
  const before = original.replace(/\r\n/g, '\n');
  const after = change(before);
  if (after === before) return original;
  return original.includes('\r\n') ? after.replace(/\n/g, '\r\n') : after;
}

// Applies `change` to the LF text of a file; a file that comes out the same is
// not written. Returns whether it was written.
export function rewriteFile(file, change) {
  const original = readFileSync(file, 'utf8');
  const next = withLineEndings(original, change);
  if (next === original) return false;
  writeFileSync(file, next, 'utf8');
  return true;
}

// Files given to the analysis models as rules, each under its own heading.
export function ruleFiles(root, names) {
  return names.map((name) => `# File ${name}\n\n${readFileSync(path.join(root, name), 'utf8')}`).join('\n\n');
}

// One OpenRouter model writes the analysis, another checks it (evalAnalysis.js);
// the section is then saved as analysis.md and placed in the README after
// `after`. `section(record)` turns the record into the text of the section.
// Returns 2 when no text came back, as the analysis CLIs do.
export async function placeAnalysis({ dir, instruction, rules, report, limits, readme, start, end, after, section, label, showHeld = false, analyse = null }) {
  const runAnalysis = analyse || (await import('./evalAnalysis.js')).runAnalysis;
  // An undefined label leaves evalAnalysis's own default.
  const record = await runAnalysis({ dir, instruction, rules, report, limits, key: envKey(), label });
  const held = showHeld ? `held $${record.spend.heldUsd.toFixed(4)}, ` : '';
  console.log(`analysis spend: settled $${record.spend.settledUsd.toFixed(4)}, ${held}${record.spend.posts} POSTs`);
  if (!record.text) {
    console.log(`analysis not placed: ${record.reason}`);
    return 2;
  }
  const body = section(record);
  writeFileSync(path.join(dir, 'analysis.md'), `${body}\n`, 'utf8');
  rewriteFile(readme, (text) => placeAfter(text, start, end, body, after));
  console.log('analysis placed in README');
  return 0;
}

// The bank of questions by id: the base bank and the a8 extension.
export function loadBankTasks(root = EVAL_ROOT) {
  const byId = new Map();
  for (const name of ['bank.json', 'bank-a8x.json']) {
    for (const item of JSON.parse(readFileSync(path.join(root, '.cache', name), 'utf8')).items) {
      byId.set(`${item.split}:${item.dataset}:${item.sourceId}`, item);
    }
  }
  return byId;
}

// Same reading of a corrections file as the campaign report: an entry either
// replaces the gold or removes the question from the scored set. Keys that
// start with $ are notes.
export function readGold(entries, tasks) {
  const gold = new Map();
  const excluded = new Map();
  const reasons = new Map();
  for (const [id, entry] of Object.entries(entries)) {
    if (id.startsWith('$')) continue;
    const task = tasks.get(id);
    if (!task) throw new Error(`Gold override for unknown question ${id}`);
    reasons.set(id, entry?.reason || '');
    if (entry?.exclude === true) {
      excluded.set(id, entry.reason || '');
      continue;
    }
    const canon = canonAnswer(String(entry?.gold ?? entry), task);
    if (canon == null) throw new Error(`Gold override for ${id} does not read as a ${task.kind} answer`);
    gold.set(id, canon);
  }
  return { gold, excluded, reasons };
}
