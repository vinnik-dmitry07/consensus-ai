// Model ids are chosen later from the catalogue and are not stored here.

export const CAMPAIGN_ID = 'a8-open-v1';
export const PRIMARY_PAIR = ['A8', 'S8'];
export const MAX_USD = 60;
export const MAX_POSTS = 4000;
export const MAX_ATTEMPTS = 2;
export const MAX_IN_FLIGHT = 3;
export const COUNCIL_SIZE = 3;
export const SHORTLIST_LIMIT = 5;
export const RESERVE_LIMIT = 2;
export const SELF_SAMPLES = 5;
export const STAGE1_MAX_TOKENS = 8192;
export const STAGE2_MAX_TOKENS = 4096;
export const FINAL_MAX_TOKENS = 8192;
export const MIN_CONTEXT = 65536;
export const MIN_COMPLETION = 8192;
export const DEV_PER_BLOCK = 8;
export const PILOT_PER_BLOCK = 4;
export const SMOKE_COUNT = 2;
export const N_SAMPLES = 1;
export const TOP_K = 3;
export const SELF_EXCLUSION = true;
export const TEMPERATURE = 0.7;
export const TOP_P = 1;
export const QUALITY_SOURCE = 'openrouter /models?sort=top-weekly among paid ids with hugging_face_id';
export const SCHEDULE_SEED = 'a8-open-v1-schedule';

// Written into every campaign so a reader can tell which rule scored a
// missing input. v1 synthesized S8 from whatever samples had text.
export const ARM_RULES = {
  a8RequiresFullCouncil: true,
  s8RequiresAllSamples: true,
  emptyTextIsMethodFailure: true,
  // P8 is a plurality vote over the same three Stage 1 answers A8 reads. It
  // makes no call. An answer without a parseable final line abstains.
  p8RequiresFullCouncil: true,
  p8TieBreak: 'seeded hash over the tied answers (PLURALITY_SEED), as A4 in main',
};
export const STAGE1_ORDER = 'Stage 2 and the chairman see answers in call-completion order; replayed answers keep their source order and come first.';

// Secondary pairs are reported with a Holm correction over this family. They
// never replace the primary pair.
export const SECONDARY_PAIRS = [['P8', 'S8'], ['P8', 'A8']];

// The stream deadline has to let a full-cap answer finish. The slowest paid
// route seen so far (StepFun on Featherless) fell to about 8 tokens a second,
// so the deadline grows with the largest cap instead of staying at the
// engine's 600 s, which a 16384-token answer would not meet.
export const MIN_TOKENS_PER_SECOND = 8;
export const HEADER_GRACE_SECONDS = 120;
export const ENGINE_STREAM_SECONDS = 600;

// Runner pacing. These change wall-clock time, not the requests.
export const DEFAULT_JOBS = 6;
export const CALLS_PER_QUESTION = 7;
export const DEFAULT_MODEL_IN_FLIGHT = 6;
export const DEFAULT_MAX_RESUMES = 30;

export const STAGE_CAPS = {
  stage1: STAGE1_MAX_TOKENS,
  sample: STAGE1_MAX_TOKENS,
  stage2: STAGE2_MAX_TOKENS,
  stage3: FINAL_MAX_TOKENS,
};

// Caps are fixed at preflight and written into campaign.json. Later phases
// read them from there, so the constants above describe v1 and this function
// describes any campaign.
export function capsFrom(overrides = {}) {
  const caps = { ...STAGE_CAPS };
  for (const [stage, value] of Object.entries(overrides)) {
    if (value == null) continue;
    if (!(stage in caps)) throw new Error(`Unknown stage cap ${stage}`);
    if (!Number.isInteger(value) || value < 1) throw new Error(`Cap for ${stage} must be a positive integer`);
    caps[stage] = value;
  }
  return caps;
}

export function streamTimeoutFor(caps) {
  const largest = Math.max(...Object.values(caps));
  return Math.max(ENGINE_STREAM_SECONDS, Math.ceil(largest / MIN_TOKENS_PER_SECOND) + HEADER_GRACE_SECONDS);
}

export function profileDocument(caps = STAGE_CAPS) {
  return {
    campaignId: CAMPAIGN_ID,
    exploratory: true,
    primaryPair: PRIMARY_PAIR,
    secondaryPairs: SECONDARY_PAIRS,
    maxUsd: MAX_USD,
    maxPosts: MAX_POSTS,
    maxAttempts: MAX_ATTEMPTS,
    maxInFlight: MAX_IN_FLIGHT,
    councilSize: COUNCIL_SIZE,
    shortlistLimit: SHORTLIST_LIMIT,
    reserveLimit: RESERVE_LIMIT,
    selfSamples: SELF_SAMPLES,
    stageCaps: caps,
    streamTimeoutSeconds: streamTimeoutFor(caps),
    minContext: MIN_CONTEXT,
    minCompletion: MIN_COMPLETION,
    devPerBlock: DEV_PER_BLOCK,
    pilotPerBlock: PILOT_PER_BLOCK,
    smokeCount: SMOKE_COUNT,
    temperature: TEMPERATURE,
    topP: TOP_P,
    qualitySource: QUALITY_SOURCE,
    scheduleSeed: SCHEDULE_SEED,
    generationSeed: null,
    redTeam: null,
    nSamples: N_SAMPLES,
    topK: TOP_K,
    selfExclusion: SELF_EXCLUSION,
    armRules: ARM_RULES,
    stage1Order: STAGE1_ORDER,
  };
}
