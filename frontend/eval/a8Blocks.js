// Blocks of the A8 bank and how each one is built and dated. The registry is
// part of the hashed method: changing it is a different campaign.

export const BLOCK_REGISTRY_VERSION = 'a8-blocks-v1';

export const LEGACY_BLOCKS = ['aime', 'gpqa', 'mmlu'];
export const EXTENSION_BLOCKS = ['rgym', 'amc', 'arxiv', 'hmmt', 'livemath'];
export const BLOCK_ORDER = [...LEGACY_BLOCKS, ...EXTENSION_BLOCKS];

export const BLOCK_LABELS = {
  aime: 'AIME',
  gpqa: 'GPQA',
  mmlu: 'MMLU-Pro',
  rgym: 'reasoning-gym',
  amc: 'AMC 2026',
  arxiv: 'ArXivMath',
  hmmt: 'HMMT Feb 2026',
  livemath: 'LiveMathBench',
};

// Earliest known publication of the material behind each legacy dataset and
// the date of the benchmark version. Month precision is enough here.
export const LEGACY_DATES = {
  aime2025: { material: '2025-02', benchmark: '2025-02' },
  aime2026: { material: '2026-02', benchmark: '2026-02' },
  gpqa: { material: '2023-11', benchmark: '2023-11' },
  mmlu: { material: '2024-06', benchmark: '2024-06' },
};

// Hugging Face sources. The rows are frozen in .cache/raw on first download
// and the repository sha is recorded next to them; datasets-server serves only
// `main`, so the frozen copy, not a revision pin, is what makes them stable.
export const HF_SOURCES = {
  'arxivmath-0826': {
    repo: 'MathArena/arxivmath-0826',
    config: 'default',
    split: 'train',
    block: 'arxiv',
    role: 'test',
    benchmarkPublished: '2026-09-13',
    materialFrom: 'arxiv-id',
  },
  'arxivmath-0926': {
    repo: 'MathArena/arxivmath-0926',
    config: 'default',
    split: 'train',
    block: 'arxiv',
    role: 'test',
    benchmarkPublished: '2026-10-16',
    materialFrom: 'arxiv-id',
  },
  'arxivmath-0626': {
    repo: 'MathArena/arxivmath-0626',
    config: 'default',
    split: 'train',
    block: 'arxiv',
    role: 'dev',
    devCount: 4,
    smokeCount: 1,
    benchmarkPublished: '2026-08-25',
    materialFrom: 'arxiv-id',
  },
  hmmt_feb_2026: {
    repo: 'MathArena/hmmt_feb_2026',
    config: 'default',
    split: 'train',
    block: 'hmmt',
    role: 'test',
    benchmarkPublished: '2026-02-19',
    material: '2026-02',
  },
  hmmt_nov_2025: {
    repo: 'MathArena/hmmt_nov_2025',
    config: 'default',
    split: 'train',
    block: 'hmmt',
    role: 'dev',
    devCount: 4,
    benchmarkPublished: '2025-11-17',
    material: '2025-11',
  },
  'livemath-202505': {
    repo: 'llm-2025-sahara/LiveMathBench-en',
    officialRepo: 'opencompass/LiveMathBench',
    config: 'v202505_all_en',
    split: 'test',
    block: 'livemath',
    role: 'split',
    devCount: 4,
    integerOnly: true,
    benchmarkPublished: '2025-05',
    material: '2025-05',
    note: 'Unofficial mirror of the gated opencompass/LiveMathBench; v202505_hard_en and v202505_all_en point to one file.',
  },
};

// Sources prepared outside Hugging Face, read from .cache/manual.
export const MANUAL_SOURCES = {
  rgym: {
    file: 'rgym.jsonl',
    // One independent gold check per row; prepare refuses a row without one.
    verify: 'rgym-verify.json',
    block: 'rgym',
    generator: 'frontend/eval/tools/rgym_generate.py',
    procedural: true,
  },
  amc: {
    file: 'amc2026.jsonl',
    block: 'amc',
    material: '2026-11-05',
    benchmarkPublished: '2026-11-06',
    goldStatus: 'unofficial',
    note: 'AMC 10A and 12A 2026, transcribed by hand from the Think Academy PDFs; key from the same publisher.',
  },
};

export const SPLIT_SEED_A8X = 'a8x-split-v1';

// Questions dropped by name after review of the statements, before any model
// saw them. A text rule would also drop questions that ask for one least or
// largest value, so the list is explicit.
// hmmt_feb_2026:32 asks for every possible value and tells the model to box a
// comma-separated list, which clashes with the one-number ANSWER line.
// The reasoning-gym entries come from the independent gold check recorded in
// .cache/manual/rgym-verify.json: three aiw questions ask about a person the
// statement never introduces, one aiw colleague puzzle has a gold that counts
// a person twice, and one gsm_symbolic question asks for 60.8 students.
export const MANUAL_EXCLUSIONS = {
  'hmmt_feb_2026:32': 'set_valued',
  'rgym-aiw:test-20261106-2': 'wrong_gold',
  'rgym-aiw:test-20261106-3': 'ambiguous',
  'rgym-aiw:test-20261106-4': 'ambiguous',
  'rgym-aiw:test-20261106-9': 'ambiguous',
  'rgym-gsm_symbolic:test-20261106-8': 'inconsistent',
};

// Which blocks a v5 test reports as the primary set. Legacy blocks are a
// secondary comparison: they were used four times to choose caps.
export function primaryBlocksOf(blocks) {
  return blocks.filter((block) => EXTENSION_BLOCKS.includes(block));
}

export function orderBlocks(blocks) {
  return [...new Set(blocks)].sort((left, right) => {
    const a = BLOCK_ORDER.indexOf(left);
    const b = BLOCK_ORDER.indexOf(right);
    return (a < 0 ? 999 : a) - (b < 0 ? 999 : b) || String(left).localeCompare(String(right));
  });
}

// Month of an arXiv identifier such as 2609.04659 or math/0601001v2.
export function arxivMonth(source) {
  const match = String(source || '').match(/^(\d{2})(\d{2})\.\d{4,5}/);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `20${match[1]}-${match[2]}`;
}

function monthOf(date) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : null;
}

// Chronology group of one question against the listing dates of the chosen
// models. One direction only: A means the material appeared after every
// listing; anything in the same month as a listing counts as not after it.
// No group claims the material is free of training leakage.
export function chronologyGroup(provenance, listings) {
  if (provenance?.generated) return 'A';
  const material = monthOf(provenance?.materialDate);
  const dates = (listings || []).map(monthOf).filter(Boolean);
  if (!material || !dates.length || dates.length !== (listings || []).length) return 'Unknown';
  const after = dates.filter((listing) => material > listing).length;
  if (after === dates.length) return 'A';
  if (after === 0) return 'C';
  return 'B';
}
