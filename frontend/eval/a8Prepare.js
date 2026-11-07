// Builds the A8 extension bank, .cache/bank-a8x.json, next to the frozen
// base bank. Nothing here calls a model. The base bank and protocol.js stay
// untouched, so `main` and the v1-v4 campaigns keep loading what they used.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  arxivMonth,
  BLOCK_REGISTRY_VERSION,
  HF_SOURCES,
  LEGACY_DATES,
  MANUAL_EXCLUSIONS,
  MANUAL_SOURCES,
  orderBlocks,
  SPLIT_SEED_A8X,
} from './a8Blocks.js';
import { fingerprint, sortBySeed, taskPublicId } from './datasets.js';
import { canonNumber } from './grade.js';
import { fetchSplit } from './sources.js';
import { sha256, stableStringify } from './util.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(EVAL_ROOT, '.cache');
export const BASE_BANK_PATH = path.join(CACHE, 'bank.json');
export const EXTENSION_PATH = path.join(CACHE, 'bank-a8x.json');
const RAW_DIR = path.join(CACHE, 'raw');
const MANUAL_DIR = path.join(CACHE, 'manual');
const RAW_META = path.join(RAW_DIR, 'a8x-sources.json');

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJsonl(file) {
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function writeJsonl(file, rows) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function fileSha(file) {
  return sha256(readFileSync(file, 'utf8'));
}

// The digest a campaign pins for its bank: every field that can change a
// request or a score, in a fixed order.
export function itemsDigest(items) {
  return sha256(stableStringify(items.map((item) => ({
    split: item.split,
    block: item.block,
    dataset: item.dataset,
    sourceId: item.sourceId,
    kind: item.kind,
    gold: item.goldCanon,
    fingerprint: item.fingerprint,
    choiceCount: item.choiceCount,
    materialDate: item.provenance?.materialDate ?? null,
  }))));
}

async function huggingFaceSha(repo) {
  try {
    const response = await fetch(`https://huggingface.co/api/datasets/${repo}`);
    if (!response.ok) return null;
    const body = await response.json();
    return body?.sha || null;
  } catch {
    return null;
  }
}

// Rows are downloaded once and then read from the frozen copy. A refresh is
// an explicit choice and changes the bank digest.
async function frozenRows(name, source, log, refresh) {
  const file = path.join(RAW_DIR, `a8x-${name}.jsonl`);
  const meta = readJson(RAW_META, {});
  const cached = refresh ? null : readJsonl(file);
  if (cached?.length && meta[name]) return { rows: cached, meta: meta[name] };
  const rows = await fetchSplit(source.repo, source.config, source.split, log);
  if (!rows.length) throw new Error(`${source.repo} returned no rows`);
  writeJsonl(file, rows);
  meta[name] = {
    repo: source.repo,
    config: source.config,
    split: source.split,
    sha: await huggingFaceSha(source.repo),
    rows: rows.length,
    fileSha: fileSha(file),
    fetchedAt: new Date().toISOString(),
  };
  writeJson(RAW_META, meta);
  return { rows, meta: meta[name] };
}

const FIGURE = /!\[|<img|\[asy\]|\\includegraphics|\bshown below\b|\bdiagram below\b|\bfigure below\b/i;

function numberCandidate(name, source, row, index) {
  const stem = String(row.problem ?? row.question ?? '').trim();
  const sourceId = row.problem_idx != null ? String(row.problem_idx) : `q${sha256(stem).slice(0, 12)}`;
  const base = { dataset: name, sourceId, block: source.block, row: index };
  if (!stem) return { ...base, excluded: 'broken_statement' };
  const manual = MANUAL_EXCLUSIONS[`${name}:${sourceId}`];
  if (manual) return { ...base, excluded: manual };
  if (FIGURE.test(stem)) return { ...base, excluded: 'needs_figure' };
  const goldCanon = canonNumber(row.answer);
  if (goldCanon == null) return { ...base, excluded: 'unsupported_answer' };
  if (source.integerOnly && goldCanon.includes('/')) return { ...base, excluded: 'not_integer' };
  const materialDate = source.materialFrom === 'arxiv-id' ? arxivMonth(row.source) : (source.material || null);
  return {
    ...base,
    item: {
      dataset: name,
      sourceId,
      kind: 'number',
      stem,
      goldCanon,
      choiceCount: 0,
      fingerprint: fingerprint(stem),
      block: source.block,
      provenance: {
        source: name,
        repo: source.repo,
        row: index,
        arxiv: row.source ?? null,
        materialDate,
        benchmarkPublished: source.benchmarkPublished,
        generated: false,
      },
    },
  };
}

function splitPool(source, items) {
  const ordered = sortBySeed(items, SPLIT_SEED_A8X);
  const out = { dev: [], test: [], smoke: [], unused: [] };
  if (source.role === 'test') {
    out.test = items;
    return out;
  }
  const dev = source.devCount || 0;
  const smoke = source.smokeCount || 0;
  out.dev = ordered.slice(0, dev);
  if (source.role === 'split') {
    out.test = ordered.slice(dev);
    return out;
  }
  out.smoke = ordered.slice(dev, dev + smoke);
  out.unused = ordered.slice(dev + smoke);
  return out;
}

function rgymItems(rows) {
  const items = [];
  const exclusions = [];
  rows.forEach((row, index) => {
    const goldCanon = canonNumber(row.answer);
    const base = { dataset: row.dataset, sourceId: row.sourceId, block: 'rgym', row: index };
    if (!row.question || goldCanon == null) {
      exclusions.push({ ...base, reason: row.question ? 'unsupported_answer' : 'broken_statement' });
      return;
    }
    items.push({
      dataset: row.dataset,
      sourceId: row.sourceId,
      kind: 'number',
      stem: String(row.question).trim(),
      goldCanon,
      choiceCount: 0,
      fingerprint: fingerprint(row.question),
      block: 'rgym',
      split: row.split,
      provenance: {
        source: 'rgym',
        family: row.family,
        config: row.config,
        seed: row.seed,
        library: row.library,
        generatedAt: row.generatedAt,
        materialDate: String(row.generatedAt || '').slice(0, 10) || null,
        benchmarkPublished: null,
        generated: true,
      },
    });
  });
  return { items, exclusions };
}

const AMC_LETTERS = ['A', 'B', 'C', 'D', 'E'];

function amcItems(rows, manual) {
  const items = [];
  const exclusions = [];
  rows.forEach((row, index) => {
    const base = { dataset: row.dataset, sourceId: row.sourceId, block: 'amc', row: index };
    if (row.exclude) {
      exclusions.push({ ...base, reason: row.exclude });
      return;
    }
    const options = Array.isArray(row.options) ? row.options : [];
    const letters = options.map((option) => option.letter).join('');
    if (options.length !== 5 || letters !== AMC_LETTERS.join('')) {
      throw new Error(`AMC ${row.sourceId} needs options A-E, got ${letters || 'none'}`);
    }
    if (!AMC_LETTERS.includes(row.gold)) throw new Error(`AMC ${row.sourceId} gold ${row.gold} is not A-E`);
    if (row.reviewed !== true) throw new Error(`AMC ${row.sourceId} is not marked as reviewed`);
    items.push({
      dataset: row.dataset,
      sourceId: row.sourceId,
      kind: 'choice',
      stem: String(row.stem).trim(),
      options: options.map((option) => ({ letter: option.letter, text: String(option.text) })),
      goldCanon: row.gold,
      choiceCount: 5,
      fingerprint: fingerprint(row.stem),
      block: 'amc',
      split: 'test',
      provenance: {
        source: 'amc',
        exams: row.exams || [],
        materialDate: manual.material,
        benchmarkPublished: manual.benchmarkPublished,
        goldStatus: row.goldStatus || manual.goldStatus,
        // Set when a figure was dropped or written out as text; the report
        // shows the primary result without these items as a sensitivity line.
        adapted: row.adapted || null,
        generated: false,
      },
    });
  });
  return { items, exclusions };
}

function baseItems() {
  const bank = readJson(BASE_BANK_PATH);
  if (!bank?.items) throw new Error('No base bank. Run the main prepare first.');
  return bank.items;
}

// Adds provenance to a base item without changing any field the base digest
// covers.
export function legacyProvenance(item) {
  const dates = LEGACY_DATES[item.dataset] || {};
  return {
    source: item.dataset,
    materialDate: dates.material || null,
    benchmarkPublished: dates.benchmark || null,
    generated: false,
  };
}

export async function buildExtensionBank({ log = console.log, refresh = false } = {}) {
  const seen = new Map();
  for (const item of baseItems()) {
    seen.set(`id:${item.dataset}:${item.sourceId}`, `base:${item.split}`);
    seen.set(`fp:${item.fingerprint}`, `base:${item.split}`);
  }
  const items = [];
  const exclusions = [];
  const coverage = {};
  const sources = {};
  const admit = (item, sourceName) => {
    const idKey = `id:${item.dataset}:${item.sourceId}`;
    const fpKey = `fp:${item.fingerprint}`;
    const clash = seen.get(idKey) || seen.get(fpKey);
    if (clash) {
      exclusions.push({ dataset: item.dataset, sourceId: item.sourceId, block: item.block, reason: 'duplicate', of: clash });
      coverage[sourceName].excluded.duplicate = (coverage[sourceName].excluded.duplicate || 0) + 1;
      return;
    }
    seen.set(idKey, `${sourceName}:${item.split}`);
    seen.set(fpKey, `${sourceName}:${item.split}`);
    items.push(item);
    coverage[sourceName][item.split] = (coverage[sourceName][item.split] || 0) + 1;
  };

  for (const [name, source] of Object.entries(HF_SOURCES)) {
    const { rows, meta } = await frozenRows(name, source, log, refresh);
    sources[name] = { ...meta, block: source.block, role: source.role, note: source.note || null };
    coverage[name] = { block: source.block, total: rows.length, eligible: 0, excluded: {} };
    const eligible = [];
    rows.forEach((row, index) => {
      const candidate = numberCandidate(name, source, row, index);
      if (candidate.excluded) {
        exclusions.push({ dataset: name, sourceId: candidate.sourceId, block: source.block, reason: candidate.excluded });
        coverage[name].excluded[candidate.excluded] = (coverage[name].excluded[candidate.excluded] || 0) + 1;
      } else {
        eligible.push(candidate.item);
      }
    });
    coverage[name].eligible = eligible.length;
    const pools = splitPool(source, eligible);
    coverage[name].unused = pools.unused.length;
    for (const split of ['dev', 'smoke', 'test']) {
      for (const item of pools[split]) admit({ ...item, split }, name);
    }
  }

  for (const [name, manual] of Object.entries(MANUAL_SOURCES)) {
    const file = path.join(MANUAL_DIR, manual.file);
    const rows = readJsonl(file);
    if (!rows?.length) {
      log(`prepare: ${manual.file} is missing; block ${manual.block} is not available`);
      sources[name] = { file: manual.file, missing: true };
      continue;
    }
    sources[name] = { file: manual.file, fileSha: fileSha(file), rows: rows.length, note: manual.note || null };
    coverage[name] = { block: manual.block, total: rows.length, eligible: 0, excluded: {} };
    const built = name === 'rgym' ? rgymItems(rows) : amcItems(rows, manual);
    for (const exclusion of built.exclusions) {
      exclusions.push(exclusion);
      coverage[name].excluded[exclusion.reason] = (coverage[name].excluded[exclusion.reason] || 0) + 1;
    }
    coverage[name].eligible = built.items.length;
    for (const item of built.items) admit(item, name);
  }

  const blocks = orderBlocks(items.map((item) => item.block));
  const bank = {
    version: BLOCK_REGISTRY_VERSION,
    createdAt: new Date().toISOString(),
    splitSeed: SPLIT_SEED_A8X,
    sources,
    blocks,
    coverage,
    exclusions,
    items,
    digest: itemsDigest(items),
  };
  writeJson(EXTENSION_PATH, bank);
  return bank;
}

export function loadExtensionBank() {
  const bank = readJson(EXTENSION_PATH);
  if (!bank?.items) throw new Error('No extension bank. Run `a8 --phase prepare` first.');
  if (itemsDigest(bank.items) !== bank.digest) throw new Error('Extension bank digest does not match its items.');
  return bank;
}

export function extensionItemId(item) {
  return `${item.split}:${taskPublicId(item)}`;
}

export async function runPrepare(argv) {
  const refresh = argv.includes('--refresh');
  const bank = await buildExtensionBank({ refresh });
  const counts = {};
  for (const item of bank.items) {
    counts[item.block] ||= { dev: 0, smoke: 0, test: 0 };
    counts[item.block][item.split] += 1;
  }
  console.log(`prepare: ${bank.items.length} items in ${bank.blocks.join(', ')}; digest ${bank.digest.slice(0, 12)}`);
  for (const [block, row] of Object.entries(counts)) {
    console.log(`  ${block}: dev ${row.dev}, smoke ${row.smoke}, test ${row.test}`);
  }
  for (const [name, row] of Object.entries(bank.coverage)) {
    const excluded = Object.entries(row.excluded).map(([reason, count]) => `${reason} ${count}`).join(', ') || 'none';
    console.log(`  source ${name}: ${row.total} rows, ${row.eligible} eligible, excluded: ${excluded}${row.unused ? `, unused pool ${row.unused}` : ''}`);
  }
  return 0;
}
