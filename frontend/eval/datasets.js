import { sha256 } from './util.js';
import { SPLIT_SEED, SOURCES } from './protocol.js';

export function fingerprint(text) {
  return sha256(String(text || '').replace(/\s+/g, ' ').trim().toLowerCase());
}

export function sortBySeed(items, seed) {
  return [...items].sort((left, right) => {
    const a = sha256(`${seed}\n${left.dataset}\n${left.sourceId}`);
    const b = sha256(`${seed}\n${right.dataset}\n${right.sourceId}`);
    if (a < b) return -1;
    if (a > b) return 1;
    return String(left.sourceId).localeCompare(String(right.sourceId));
  });
}

export function permuteChoices(choices, itemId, seed) {
  const ranked = choices.map((choice, index) => ({
    ...choice,
    index,
    key: sha256(`${seed}\n${itemId}\n${index}\n${choice.text}`),
  }));
  ranked.sort((left, right) => {
    if (left.key < right.key) return -1;
    if (left.key > right.key) return 1;
    return left.index - right.index;
  });
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let goldLetter = null;
  const options = ranked.map((choice, position) => {
    const letter = letters[position];
    if (choice.correct) goldLetter = letter;
    return { letter, text: choice.text };
  });
  if (!goldLetter) throw new Error(`No correct choice for ${itemId}`);
  return { options, goldLetter };
}

export function labelChoicesInOrder(choices, goldIndex) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (!Number.isInteger(goldIndex) || goldIndex < 0 || goldIndex >= choices.length) {
    throw new Error('MMLU gold index is outside the option list');
  }
  return {
    options: choices.map((text, index) => ({ letter: letters[index], text: String(text) })),
    goldLetter: letters[goldIndex],
  };
}

export function hamiltonQuotas(counts, total) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  const population = entries.reduce((sum, [, count]) => sum + count, 0);
  if (!population || total < 0) throw new Error('Cannot allocate an empty category population');
  const rows = entries.map(([name, count]) => {
    const exact = (total * count) / population;
    return { name, count, seats: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let used = rows.reduce((sum, row) => sum + row.seats, 0);
  const order = [...rows].sort((left, right) => (
    right.frac - left.frac || left.name.localeCompare(right.name)
  ));
  for (const row of order) {
    if (used >= total) break;
    if (row.seats < row.count) {
      row.seats += 1;
      used += 1;
    }
  }
  if (used !== total) throw new Error(`Quota shortfall: assigned ${used} of ${total}`);
  const quotas = {};
  for (const row of rows) quotas[row.name] = row.seats;
  return quotas;
}

function takeSorted(items, count, seed) {
  const sorted = sortBySeed(items, seed);
  if (sorted.length < count) {
    throw new Error(`Need ${count} items and only have ${sorted.length}`);
  }
  return sorted.slice(0, count);
}

function groupBy(items, field) {
  const groups = new Map();
  for (const item of items) {
    const key = String(item[field] || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

export function selectMmlu(validation, test, seed) {
  const devGroups = groupBy(validation, 'category');
  const categories = [...devGroups.keys()].filter(Boolean).sort();
  if (categories.length < SOURCES.mmlu.dev) {
    throw new Error(`MMLU validation has ${categories.length} categories; dev needs ${SOURCES.mmlu.dev}`);
  }
  const dev = [];
  for (const category of categories.slice(0, SOURCES.mmlu.dev)) {
    dev.push(takeSorted(devGroups.get(category), 1, seed)[0]);
  }
  const testGroups = groupBy(test, 'category');
  const counts = {};
  for (const [category, rows] of testGroups) {
    if (category) counts[category] = rows.length;
  }
  const quotas = hamiltonQuotas(counts, SOURCES.mmlu.test);
  const chosen = [];
  for (const category of Object.keys(quotas).sort()) {
    chosen.push(...takeSorted(testGroups.get(category), quotas[category], seed));
  }
  return { dev, test: chosen, quotas };
}

export function findOverlap(groups) {
  const seenId = new Map();
  const seenText = new Map();
  const dupes = [];
  for (const [name, items] of Object.entries(groups)) {
    for (const item of items) {
      const idKey = `${item.dataset}:${item.sourceId}`;
      const textKey = item.fingerprint;
      if (seenId.has(idKey)) dupes.push({ type: 'id', key: idKey, a: seenId.get(idKey), b: name });
      else seenId.set(idKey, name);
      if (seenText.has(textKey)) dupes.push({ type: 'text', key: textKey, a: seenText.get(textKey), b: name });
      else seenText.set(textKey, name);
    }
  }
  return dupes;
}

function field(row, names) {
  for (const name of names) {
    if (row[name] != null && row[name] !== '') return row[name];
  }
  return undefined;
}

function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value == null || value === '') return [];
  return [String(value)];
}

export function normalizeAime(row, dataset) {
  const problem = field(row, ['problem', 'question', 'Problem']);
  const answer = field(row, ['answer', 'final_answer', 'Answer']);
  const sourceId = String(field(row, ['id', 'unique_id', 'problem_id', 'ID']) ?? problem);
  if (problem == null || answer == null) {
    throw new Error(`AIME row is missing fields. Keys: ${Object.keys(row).join(', ')}`);
  }
  const gold = String(answer).trim();
  return {
    dataset,
    sourceId,
    kind: 'integer',
    stem: String(problem).trim(),
    goldCanon: String(Number(gold)),
    choiceCount: 0,
    fingerprint: fingerprint(problem),
  };
}

export function normalizeGpqa(row, seed) {
  const question = field(row, ['Question', 'question', 'preamble']);
  const correct = field(row, ['Correct Answer', 'correct_answer', 'correct']);
  let incorrect = asList(field(row, ['incorrect', 'Incorrect Answers']));
  if (!incorrect.length) {
    incorrect = [1, 2, 3].map((index) => field(row, [
      `Incorrect Answer ${index}`,
      `incorrect_answer_${index}`,
    ])).filter((value) => value != null);
  }
  const sourceId = String(field(row, ['id', 'Record ID', 'record_id']) ?? fingerprint(question));
  if (!question || correct == null || incorrect.length < 3) {
    throw new Error(`GPQA row is missing choices. Keys: ${Object.keys(row).join(', ')}`);
  }
  const choices = [
    { text: String(correct).trim(), correct: true },
    ...incorrect.slice(0, 3).map((text) => ({ text: String(text).trim(), correct: false })),
  ];
  const permuted = permuteChoices(choices, sourceId, seed);
  return {
    dataset: 'gpqa',
    sourceId,
    kind: 'choice',
    stem: String(question).trim(),
    options: permuted.options,
    goldCanon: permuted.goldLetter,
    choiceCount: permuted.options.length,
    fingerprint: fingerprint(question),
  };
}

export function normalizeMmlu(row) {
  const question = field(row, ['question', 'Question']);
  const options = asList(field(row, ['options', 'choices', 'Options']));
  const rawAnswer = field(row, ['answer', 'answer_index', 'Answer']);
  const category = String(field(row, ['category', 'subject']) || '');
  const sourceId = String(field(row, ['question_id', 'id', 'ID']) ?? fingerprint(question));
  if (!question || !options.length || rawAnswer == null) {
    throw new Error(`MMLU row is missing fields. Keys: ${Object.keys(row).join(', ')}`);
  }
  let goldIndex;
  if (typeof rawAnswer === 'number' || /^\d+$/.test(String(rawAnswer))) {
    goldIndex = Number(rawAnswer);
  } else {
    goldIndex = String(rawAnswer).trim().toUpperCase().charCodeAt(0) - 65;
  }
  const labeled = labelChoicesInOrder(options, goldIndex);
  return {
    dataset: 'mmlu',
    sourceId,
    category,
    kind: 'choice',
    stem: String(question).trim(),
    options: labeled.options,
    goldCanon: labeled.goldLetter,
    choiceCount: labeled.options.length,
    fingerprint: fingerprint(question),
  };
}

export function buildBank(raw, seed = SPLIT_SEED) {
  const aimeDev = takeSorted(
    (raw.aime2025 || []).map((row) => normalizeAime(row, 'aime2025')),
    SOURCES.aime2025.count,
    seed,
  ).map((item) => ({ ...item, split: 'dev', block: 'aime' }));
  const aimeTest = takeSorted(
    (raw.aime2026 || []).map((row) => normalizeAime(row, 'aime2026')),
    SOURCES.aime2026.count,
    seed,
  ).map((item) => ({ ...item, split: 'test', block: 'aime' }));
  const gpqa = sortBySeed((raw.gpqa || []).map((row) => normalizeGpqa(row, seed)), seed);
  const gpqaNeed = SOURCES.gpqa.dev + SOURCES.gpqa.test + SOURCES.gpqa.smoke;
  if (gpqa.length < gpqaNeed) throw new Error(`GPQA has ${gpqa.length} rows; need ${gpqaNeed}`);
  const gpqaDev = gpqa.slice(0, SOURCES.gpqa.dev).map((item) => ({ ...item, split: 'dev', block: 'gpqa' }));
  const gpqaTest = gpqa.slice(SOURCES.gpqa.dev, SOURCES.gpqa.dev + SOURCES.gpqa.test)
    .map((item) => ({ ...item, split: 'test', block: 'gpqa' }));
  const gpqaSmoke = gpqa.slice(SOURCES.gpqa.dev + SOURCES.gpqa.test, gpqaNeed)
    .map((item) => ({ ...item, split: 'smoke', block: 'gpqa' }));
  const mmlu = selectMmlu(
    (raw.mmluValidation || []).map((row) => normalizeMmlu(row)),
    (raw.mmluTest || []).map((row) => normalizeMmlu(row)),
    seed,
  );
  const mmluDev = mmlu.dev.map((item) => ({ ...item, split: 'dev', block: 'mmlu' }));
  const mmluTest = mmlu.test.map((item) => ({ ...item, split: 'test', block: 'mmlu' }));
  const items = [
    ...aimeDev,
    ...aimeTest,
    ...gpqaDev,
    ...gpqaTest,
    ...gpqaSmoke,
    ...mmluDev,
    ...mmluTest,
  ];
  const overlap = findOverlap({
    aimeDev,
    aimeTest,
    gpqaDev,
    gpqaTest,
    gpqaSmoke,
    mmluDev,
    mmluTest,
  });
  if (overlap.length) {
    throw new Error(`Smoke, dev, and test overlap (${overlap.length} collisions)`);
  }
  return {
    items,
    mmluQuotas: mmlu.quotas,
    counts: {
      dev: items.filter((item) => item.split === 'dev').length,
      test: items.filter((item) => item.split === 'test').length,
      smoke: items.filter((item) => item.split === 'smoke').length,
    },
  };
}

export function taskPublicId(task) {
  return `${task.dataset}:${task.sourceId}`;
}
