// Offline rebuild of the finish-probe v2 and v3 reports against the input they
// were frozen with. Both runs hash `.runs/a8-open-v5e/reports/report-corrected.md`
// at the freeze. That live file was rebuilt on 2026-11-11 by another session with
// the report code of branch claude/v5e-report-fixes, so the v2 and v3 `report`
// phases now refuse. The frozen copy is kept in
// `.runs/frozen-inputs/a8-open-v5e/report-corrected.md`. Each report phase runs
// in a child process whose reads of the live path return the frozen copy
// (frozenInputRedirect.mjs). No file of a8-open-v5e is moved or written, and the
// frozen v2 and v3 code is not touched.
//
//   node frontend/eval/finishProbeFrozenRebuild.js

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fileSha } from './noteTools.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = path.join(EVAL_ROOT, '.runs');
const LIVE = path.join(RUNS_ROOT, 'a8-open-v5e', 'reports', 'report-corrected.md');
const FROZEN = path.join(RUNS_ROOT, 'frozen-inputs', 'a8-open-v5e', 'report-corrected.md');
const REDIRECT = path.join(EVAL_ROOT, 'frozenInputRedirect.mjs');
const RUNS = Object.freeze(['finish-probe-v2', 'finish-probe-v3']);

// A node child that reads `live` as `frozen`.
export function runRedirected(args, pairs, options = {}) {
  return spawnSync(process.execPath, ['--import', pathToFileURL(REDIRECT).href, ...args], {
    encoding: 'utf8',
    ...options,
    env: { ...process.env, ...options.env, FROZEN_REDIRECT: JSON.stringify(pairs) },
  });
}

function reportFiles(run) {
  const dir = path.join(RUNS_ROOT, run);
  return readdirSync(dir).filter((name) => /^report.*\.(md|json)$/.test(name)).sort().map((name) => path.join(dir, name));
}

function frozenHash() {
  const hashes = RUNS.map((run) => JSON.parse(readFileSync(path.join(RUNS_ROOT, run, 'manifest.json'), 'utf8')).frozen?.sourceHashes?.corrected);
  if (!hashes[0] || hashes.some((hash) => hash !== hashes[0])) throw new Error('The v2 and v3 manifests do not name one frozen hash of report-corrected.md');
  return hashes[0];
}

function rebuild(run) {
  const files = reportFiles(run);
  const before = files.map(fileSha);
  const child = runRedirected([path.join(EVAL_ROOT, 'finishProbeCli.js'), run, '--phase', 'report'], [[LIVE, FROZEN]], { env: { or_key: '', OR_KEY: '' } });
  const after = files.map(fileSha);
  const changed = files.filter((_, index) => before[index] !== after[index]).map((file) => path.basename(file));
  const tail = String(child.stderr || '').split('\n').find((line) => line && !line.includes('NODE_TLS')) || '';
  return { run, exit: child.status, files: files.map((file) => path.basename(file)), changed, tail };
}

function main() {
  const want = frozenHash();
  if (!existsSync(FROZEN) || fileSha(FROZEN) !== want) throw new Error(`No frozen copy with sha ${want.slice(0, 12)} at ${FROZEN}`);
  const live = fileSha(LIVE);
  const results = RUNS.map(rebuild);
  const after = fileSha(LIVE);
  console.log(`report-corrected.md: live ${live.slice(0, 12)}, read as frozen ${want.slice(0, 12)}, live after ${after.slice(0, 12)}`);
  let code = after === live ? 0 : 1;
  for (const result of results) {
    if (result.exit !== 0 || result.changed.length) code = 1;
    console.log(`${result.run}: exit ${result.exit}, ${result.files.join(', ')} ${result.changed.length ? `CHANGED: ${result.changed.join(', ')}` : 'byte-identical'}${result.exit === 0 ? '' : ` (${result.tail})`}`);
  }
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
