// Helpers shared by the README-block, gate, and route tools that sit outside
// the frozen finish-probe files (V3_FILES, V4_FILES) and outside the a8 method
// hash (SOURCE_FILES in a8.js). Changing this file changes no frozen hash.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { replaceSection } from './report.js';

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

// The section between start and end replaced, or placed right after `after`.
export function placeAfter(readme, start, end, body, after) {
  const replaced = replaceSection(readme, start, end, `\n${body}\n`);
  if (replaced != null) return replaced;
  const at = readme.indexOf(after);
  if (at < 0) throw new Error(`${after} is not in the README`);
  const cut = at + after.length;
  return `${readme.slice(0, cut)}\n\n${start}\n\n${body}\n\n${end}${readme.slice(cut)}`;
}

// Files given to the analysis models as rules, each under its own heading.
export function ruleFiles(root, names) {
  return names.map((name) => `# File ${name}\n\n${readFileSync(path.join(root, name), 'utf8')}`).join('\n\n');
}

// One OpenRouter model writes the analysis, another checks it (evalAnalysis.js);
// the section is then saved as analysis.md and placed in the README after
// `after`. `section(record)` turns the record into the text of the section.
// Returns 2 when no text came back, as the analysis CLIs do.
export async function placeAnalysis({ dir, instruction, rules, report, limits, readme, start, end, after, section, showHeld = false, analyse = null }) {
  const runAnalysis = analyse || (await import('./evalAnalysis.js')).runAnalysis;
  const record = await runAnalysis({ dir, instruction, rules, report, limits, key: envKey() });
  const held = showHeld ? `held $${record.spend.heldUsd.toFixed(4)}, ` : '';
  console.log(`analysis spend: settled $${record.spend.settledUsd.toFixed(4)}, ${held}${record.spend.posts} POSTs`);
  if (!record.text) {
    console.log(`analysis not placed: ${record.reason}`);
    return 2;
  }
  const body = section(record);
  writeFileSync(path.join(dir, 'analysis.md'), `${body}\n`, 'utf8');
  writeFileSync(readme, placeAfter(readFileSync(readme, 'utf8'), start, end, body, after), 'utf8');
  console.log('analysis placed in README');
  return 0;
}
