import { stableStringify, sha256 } from './util.js';

export const PROTOCOL_VERSION = 'eval-protocol-1';

// SHA-256 of the key that was hardcoded in the audited tree. The value itself
// is not stored here. The bench refuses to send it.
export const PUBLISHED_KEY_SHA256 = '6960e656a6aee20c444cf942135b7495bd1a27d277ed08c7b4976ff7a35338fc';

export const INCIDENT = {
  publishedKeyRemovedFromSource: true,
  revocationConfirmedByOwner: false,
  pagesRedeployConfirmed: false,
};

export const SPLIT_SEED = 'eval-split-v1';
export const SCHEDULE_SEED = 'eval-schedule-v1';
export const PLURALITY_SEED = 'eval-plurality-v1';
export const BOOTSTRAP_SEED = 'eval-bootstrap-v1';
export const BOOTSTRAP_REPS = 10000;
export const DELTA_MIN = 0.05;
export const ALPHA = 0.05;

export const POOL_LIMIT = 7;
export const COUNCIL_SIZE = 5;
export const DEV_PER_BLOCK = 8;
export const SMOKE_COUNT = 2;
export const TEST_COUNTS = { aime: 30, gpqa: 50, mmlu: 40 };
export const TOP_K = 3;
export const SELF_EXCLUSION = true;
export const ENGINE_RETRY_LIMIT = 5;

// Extended profile from the plan, including the 15% reserve. This is a ceiling.
export const TOTAL_POST_CAP = 3053;
export const CONSERVATIVE_DAILY_POSTS = 50;

export const ANSWER_INSTRUCTIONS = [
  'Answer the question. Put the final answer on the last line in exactly this form:',
  'ANSWER: <answer>',
  'For a numeric question, the answer is an integer from 0 through 999.',
  'For a multiple-choice question, the answer is a single letter.',
  'Do not write anything after that line.',
].join('\n');

export const SELF_MOA_LEAD = [
  'You are aggregating independent answers from one model.',
  'The samples may repeat the same mistake. Do not treat agreement as proof.',
  'Give your own final answer on the last line as ANSWER: <answer>.',
].join('\n');

export const SOURCES = {
  aime2025: {
    dataset: 'aime2025',
    repo: 'math-ai/aime25',
    url: 'https://huggingface.co/datasets/math-ai/aime25',
    config: 'default',
    split: 'test',
    role: 'dev',
    count: DEV_PER_BLOCK,
  },
  aime2026: {
    dataset: 'aime2026',
    repo: 'math-ai/aime26',
    url: 'https://huggingface.co/datasets/math-ai/aime26',
    config: 'default',
    split: 'test',
    role: 'test',
    count: TEST_COUNTS.aime,
  },
  gpqa: {
    dataset: 'gpqa',
    repo: 'Idavidrein/gpqa',
    url: 'https://huggingface.co/datasets/Idavidrein/gpqa',
    config: 'gpqa_diamond',
    split: 'train',
    dev: DEV_PER_BLOCK,
    test: TEST_COUNTS.gpqa,
    smoke: SMOKE_COUNT,
  },
  mmlu: {
    dataset: 'mmlu',
    repo: 'TIGER-Lab/MMLU-Pro',
    url: 'https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro',
    config: 'default',
    devSplit: 'validation',
    testSplit: 'test',
    dev: DEV_PER_BLOCK,
    test: TEST_COUNTS.mmlu,
  },
};

export const PRIMARY_ALTERNATIVES = ['A0', 'A1', 'A2', 'A3', 'A4'];
export const DIAGNOSTIC_PAIRS = [
  ['A5', 'A4'],
  ['A7', 'A5'],
  ['A6', 'A7'],
  ['A6', 'A5'],
];

export const TIE_BREAK = ['accuracy', 'completion', 'latency', 'configId'];

export function protocolDocument() {
  return {
    version: PROTOCOL_VERSION,
    deltaMin: DELTA_MIN,
    alpha: ALPHA,
    bootstrapReps: BOOTSTRAP_REPS,
    bootstrapSeed: BOOTSTRAP_SEED,
    splitSeed: SPLIT_SEED,
    scheduleSeed: SCHEDULE_SEED,
    pluralitySeed: PLURALITY_SEED,
    poolLimit: POOL_LIMIT,
    councilSize: COUNCIL_SIZE,
    devPerBlock: DEV_PER_BLOCK,
    smokeCount: SMOKE_COUNT,
    testCounts: TEST_COUNTS,
    topK: TOP_K,
    selfExclusion: SELF_EXCLUSION,
    engineRetryLimit: ENGINE_RETRY_LIMIT,
    totalPostCap: TOTAL_POST_CAP,
    conservativeDailyPosts: CONSERVATIVE_DAILY_POSTS,
    answerInstructions: ANSWER_INSTRUCTIONS,
    selfMoaLead: SELF_MOA_LEAD,
    sources: SOURCES,
    primaryAlternatives: PRIMARY_ALTERNATIVES,
    diagnosticPairs: DIAGNOSTIC_PAIRS,
    tieBreak: TIE_BREAK,
    canonicalStage1Order: 'council-list',
    stage2JudgeOrder: 'council-list',
    stopRules: [
      'daily or total post cap pauses the run; pending questions are not scored incorrect',
      'zero Stage 1 successes skip Stage 2, A5, A6, and A7',
      'zero Stage 2 successes skip A5, A6, and A7',
      'a pause inside red team does not keep consensus or start Stage 3',
      'a roster mutation stops the cohort; the model is not replaced',
      'test N and the comparison family are not changed after seeing test results',
    ],
    incident: INCIDENT,
  };
}

export function protocolHash() {
  return sha256(stableStringify(protocolDocument()));
}
