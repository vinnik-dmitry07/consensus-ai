import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCES } from './protocol.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
// Published in the official GPQA README. The extracted questions stay in the gitignored cache.
const GPQA_ZIP_URL = 'https://github.com/idavidrein/gpqa/raw/main/dataset.zip';
const GPQA_ZIP_PASSWORD = 'deserted-untie-orchid';

function readJsonl(file) {
  if (!existsSync(file)) return null;
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return rows;
}

function writeJsonl(file, rows) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchJson(url, log) {
  let wait = 2000;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const response = await fetch(url);
    if (response.status === 429 || response.status >= 500) {
      log(`HTTP ${response.status}, retry ${attempt} after ${wait}ms`);
      await response.text();
      await sleep(wait);
      wait = Math.min(wait * 2, 30000);
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 180)}`);
      error.status = response.status;
      throw error;
    }
    return JSON.parse(text);
  }
  throw new Error(`Gave up after retries for ${url}`);
}

async function fetchSplit(repo, config, split, log) {
  const rows = [];
  let offset = 0;
  const length = 100;
  let loggedFields = false;
  for (;;) {
    const url = new URL('https://datasets-server.huggingface.co/rows');
    url.searchParams.set('dataset', repo);
    url.searchParams.set('config', config);
    url.searchParams.set('split', split);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('length', String(length));
    log(`${repo} ${config}/${split} offset ${offset}`);
    const body = await fetchJson(url, log);
    const page = body.rows || [];
    for (const entry of page) rows.push(entry.row || entry);
    if (!loggedFields && rows.length) {
      log(`fields: ${Object.keys(rows[0]).join(', ')}`);
      loggedFields = true;
    }
    if (page.length < length) break;
    offset += page.length;
    if (offset > 20000) break;
    await sleep(150);
  }
  log(`${repo} ${split}: ${rows.length} rows`);
  return rows;
}

function downloadGpqa(cacheDir, log) {
  const dir = path.join(cacheDir, 'gpqa');
  mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, 'dataset.zip');
  const jsonlPath = path.join(dir, 'diamond.jsonl');
  if (!existsSync(zipPath)) {
    log('Downloading the official GPQA zip into the gitignored cache');
    const result = spawnSync('curl.exe', ['-L', '--fail', '--silent', '--show-error', '-o', zipPath, GPQA_ZIP_URL], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`GPQA zip download failed: ${(result.stderr || '').slice(0, 180)}`);
    }
  }
  const extracted = spawnSync('py', [
    '-3',
    path.join(EVAL_ROOT, 'gpqa_extract.py'),
    zipPath,
    jsonlPath,
    GPQA_ZIP_PASSWORD,
  ], { encoding: 'utf8' });
  if (extracted.stdout) log(extracted.stdout.trim());
  if (extracted.status !== 0) {
    throw new Error(`GPQA extract failed: ${(extracted.stderr || extracted.stdout || '').slice(0, 240)}`);
  }
  const rows = readJsonl(jsonlPath);
  if (!rows?.length) throw new Error('GPQA Diamond jsonl is empty');
  return rows;
}

export async function loadRawSources(cacheDir, log = console.log) {
  const manual = path.join(cacheDir, 'manual');
  const rawDir = path.join(cacheDir, 'raw');
  mkdirSync(manual, { recursive: true });
  mkdirSync(rawDir, { recursive: true });
  const missing = [];

  async function take(name, loader) {
    try {
      for (const file of [path.join(manual, `${name}.jsonl`), path.join(rawDir, `${name}.jsonl`)]) {
        const local = readJsonl(file);
        if (local?.length) {
          log(`${name}: ${local.length} cached rows`);
          return local;
        }
      }
      const rows = await loader();
      writeJsonl(path.join(rawDir, `${name}.jsonl`), rows);
      return rows;
    } catch (error) {
      missing.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  const raw = {
    aime2025: await take('aime2025', () => (
      fetchSplit(SOURCES.aime2025.repo, SOURCES.aime2025.config, SOURCES.aime2025.split, log)
    )),
    aime2026: await take('aime2026', () => (
      fetchSplit(SOURCES.aime2026.repo, SOURCES.aime2026.config, SOURCES.aime2026.split, log)
    )),
    gpqa: await take('gpqa', async () => {
      try {
        return await fetchSplit(SOURCES.gpqa.repo, SOURCES.gpqa.config, SOURCES.gpqa.split, log);
      } catch (error) {
        if (error?.status !== 401) throw error;
        log('GPQA is gated on Hugging Face. Using the official repository zip instead.');
        return downloadGpqa(cacheDir, log);
      }
    }),
    mmluValidation: await take('mmlu-validation', () => (
      fetchSplit(SOURCES.mmlu.repo, SOURCES.mmlu.config, SOURCES.mmlu.devSplit, log)
    )),
    mmluTest: await take('mmlu-test', () => (
      fetchSplit(SOURCES.mmlu.repo, SOURCES.mmlu.config, SOURCES.mmlu.testSplit, log)
    )),
  };
  if (missing.length) {
    throw new Error(
      `Could not load every source. Put JSONL files in ${manual} and do not commit them. ${missing.join(' | ')}`,
    );
  }
  return raw;
}

export function sourceMetadata() {
  return {
    aime2025: SOURCES.aime2025,
    aime2026: SOURCES.aime2026,
    gpqa: {
      ...SOURCES.gpqa,
      fallback: 'Official idavidrein/gpqa dataset.zip when the Hugging Face config is gated',
    },
    mmlu: SOURCES.mmlu,
    note: 'Question text and GPQA choices stay in the gitignored cache. Reports keep ids only.',
  };
}
