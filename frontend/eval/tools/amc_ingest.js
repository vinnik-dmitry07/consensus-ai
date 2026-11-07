// Prepares AMC 10A and 12A 2026 for a hand transcription. It downloads the
// two papers into .cache/amc, renders every page to PNG, and extracts the
// text layer. The text layer garbles formulas, so the problems are typed by
// hand from the page images into .cache/manual/amc2026.jsonl, one JSON row
// per problem:
//   { dataset: 'amc2026', sourceId: '12A-1', exams: ['12A #1', '10A #2'],
//     stem, options: [{ letter: 'A', text }, ... 'E'], gold: 'A',
//     goldStatus: 'unofficial', reviewed: true, verified: 'hand' | 'code' }
// or, for a problem left out, { dataset, sourceId, exams, exclude: 'needs_figure' }.
// A problem shared by both papers appears once. Nothing here goes into git.
//
// Usage: node frontend/eval/tools/amc_ingest.js

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVAL_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AMC_DIR = path.join(EVAL_ROOT, '.cache', 'amc');
const PYTHON = path.join(EVAL_ROOT, '.cache', 'venv', 'Scripts', 'python.exe');
const BASE = 'https://www.thethinkacademy.com/blog/wp-content/uploads/2026/11';
const PAPERS = ['2026-AMC-12A-Paper.pdf', '2026-AMC-10A-Paper.pdf'];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || '').slice(0, 300)}`);
  return result.stdout.trim();
}

function main() {
  mkdirSync(path.join(AMC_DIR, 'pages'), { recursive: true });
  if (!existsSync(PYTHON)) throw new Error('Create the venv first: py -3.10 -m venv .cache/venv, then pip install pypdf pymupdf');
  for (const paper of PAPERS) {
    const file = path.join(AMC_DIR, paper);
    if (!existsSync(file)) {
      console.log(`downloading ${paper}`);
      run('curl.exe', ['-L', '--fail', '--silent', '--show-error', '-A', 'Mozilla/5.0', '-o', file, `${BASE}/${paper}`]);
    }
    const exam = paper.match(/AMC-(\d+A)/)[1];
    console.log(run(PYTHON, [path.join(EVAL_ROOT, 'tools', 'pdf_text.py'), file, path.join(AMC_DIR, `2026-AMC-${exam}.txt`)]));
    console.log(run(PYTHON, ['-c', [
      'import sys, pymupdf',
      'doc = pymupdf.open(sys.argv[1])',
      'for n, page in enumerate(doc, start=1):',
      '    page.get_pixmap(matrix=pymupdf.Matrix(1.6, 1.6)).save(f"{sys.argv[2]}-p{n}.png")',
      'print(len(doc), "pages rendered")',
    ].join('\n'), file, path.join(AMC_DIR, 'pages', exam)]));
  }
  console.log(`Type the problems from ${path.join(AMC_DIR, 'pages')} into .cache/manual/amc2026.jsonl.`);
  return 0;
}

process.exitCode = main();
