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

export const STAGE_CAPS = {
  stage1: STAGE1_MAX_TOKENS,
  sample: STAGE1_MAX_TOKENS,
  stage2: STAGE2_MAX_TOKENS,
  stage3: FINAL_MAX_TOKENS,
};

export function profileDocument() {
  return {
    campaignId: CAMPAIGN_ID,
    exploratory: true,
    primaryPair: PRIMARY_PAIR,
    maxUsd: MAX_USD,
    maxPosts: MAX_POSTS,
    maxAttempts: MAX_ATTEMPTS,
    maxInFlight: MAX_IN_FLIGHT,
    councilSize: COUNCIL_SIZE,
    shortlistLimit: SHORTLIST_LIMIT,
    reserveLimit: RESERVE_LIMIT,
    selfSamples: SELF_SAMPLES,
    stageCaps: STAGE_CAPS,
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
  };
}
