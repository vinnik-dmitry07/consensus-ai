// Readers of the stored data of a campaign, shared by the offline tools that
// sit outside the frozen files and the a8 method hash: the question bank, the
// gold corrections files, and the question records of a phase.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonAnswer } from './grade.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// The bank of questions by id: the base bank and the a8 extension.
export function loadBankTasks() {
  const byId = new Map();
  for (const name of ['bank.json', 'bank-a8x.json']) {
    for (const item of readJson(path.join(EVAL_ROOT, '.cache', name)).items) {
      byId.set(`${item.split}:${item.dataset}:${item.sourceId}`, item);
    }
  }
  return byId;
}

// Same reading of a corrections file as the campaign report: an entry either
// replaces the gold or removes the question from the scored set. Keys that
// start with $ are notes. goldOf(id) is the gold in force.
export function readGold(entries, tasks) {
  const gold = new Map();
  const excluded = new Set();
  const reasons = new Map();
  for (const [id, entry] of Object.entries(entries)) {
    if (id.startsWith('$')) continue;
    const task = tasks.get(id);
    if (!task) throw new Error(`Gold override for unknown question ${id}`);
    reasons.set(id, entry?.reason || '');
    if (entry?.exclude === true) {
      excluded.add(id);
      continue;
    }
    const canon = canonAnswer(String(entry?.gold ?? entry), task);
    if (canon == null) throw new Error(`Gold override for ${id} does not read as a ${task.kind} answer`);
    gold.set(id, canon);
  }
  return { gold, excluded, reasons, goldOf: (id) => gold.get(id) ?? tasks.get(id).goldCanon };
}

// The question records of a phase directory (`test_`, `dev_`, ...), in
// directory order.
export function questionRecords(dir, prefix) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)))
    .filter((row) => row?.id);
}
