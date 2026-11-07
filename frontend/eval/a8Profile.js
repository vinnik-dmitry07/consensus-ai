// Model ids are chosen later from the catalogue and are not stored here.

import { LOOP_GUARD_DEFAULTS } from '../src/engine/browser/loopGuard.js';

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
// describes any campaign. B's Stage 1 answer is sample 1, so the sample cap
// always equals the Stage 1 cap.
export function capsFrom(overrides = {}) {
  const caps = { ...STAGE_CAPS };
  for (const [stage, value] of Object.entries(overrides)) {
    if (value == null) continue;
    if (!(stage in caps)) throw new Error(`Unknown stage cap ${stage}`);
    if (!Number.isInteger(value) || value < 1) throw new Error(`Cap for ${stage} must be a positive integer`);
    caps[stage] = value;
  }
  if (overrides.stage1 != null && overrides.sample == null) caps.sample = caps.stage1;
  if (caps.sample !== caps.stage1) throw new Error('The sample cap must equal the Stage 1 cap');
  return caps;
}

// v5. A call cut at its cap or by the loop guard, with no visible answer,
// is passed on as the end of its reasoning only. Scores use the full text.
export const TAIL_RULE = Object.freeze({
  chars: 8000,
  marker: '[This answer was cut off before a final answer. Last 8000 characters of its unfinished reasoning:]',
  appliesTo: 'a call that ended at its cap or at the loop guard and whose content is its reasoning',
});

// Room an assembled prompt keeps for the question, the template, and the
// judges' notes, and how many outputs of the cap the largest prompt carries:
// S8 synthesis holds five samples plus its own output; a judge or the
// chairman holds three answers, counted at 1.5 because another model's
// tokenizer may spend more tokens on the same text, plus its own output.
export const CONTEXT_RESERVE_TOKENS = 8000;
export const SYNTHESIS_CONTEXT_FACTOR = 6;
export const JUDGE_CONTEXT_FACTOR = 5.5;

export function contextProblems(route, cap) {
  const problems = [];
  if (route.maxCompletion != null && route.maxCompletion < cap) {
    problems.push(`${route.id} allows ${route.maxCompletion} completion tokens, below ${cap}`);
  }
  if (route.context != null) {
    for (const [label, factor] of [['S8 synthesis', SYNTHESIS_CONTEXT_FACTOR], ['judge', JUDGE_CONTEXT_FACTOR]]) {
      const need = Math.ceil(factor * cap) + CONTEXT_RESERVE_TOKENS;
      if (need > route.context) problems.push(`${route.id} ${label} needs ${need} of ${route.context} context tokens`);
    }
  }
  return problems;
}

// The largest single cap every route of the shortlist can take.
export function maxCommonCap(routes) {
  let cap = Number.POSITIVE_INFINITY;
  for (const route of routes) {
    if (route.maxCompletion != null) cap = Math.min(cap, route.maxCompletion);
    if (route.context != null) {
      cap = Math.min(cap, Math.floor((route.context - CONTEXT_RESERVE_TOKENS) / SYNTHESIS_CONTEXT_FACTOR));
    }
  }
  if (!Number.isFinite(cap) || cap < 1) throw new Error('No route states a completion or context limit; pass explicit caps.');
  return cap;
}

export const V5_PILOT_PER_BLOCK = 2;
export const V5_PILOT_PER_BLOCK_MAX = 4;
// With two to four pilot questions per block, this quantile picks the dearest
// one: the conservative forecast is the worst pilot question of each block.
export const FORECAST_QUANTILE = 0.9;

// The secondary family of an extended campaign, under one Holm correction.
// The primary pair, A8 against S8 on the new blocks, is not in it. Groups B
// and C are pooled: with the v4 council B is one month of ArXivMath, too small
// to test, and a near-powerless entry would only cost the others power. The report still
// shows A, B, and C one by one as diagnostics.
export const V5_SECONDARY_FAMILY = [
  { name: 'A8 - S8, group A', left: 'A8', right: 'S8', set: 'primary', groups: ['A'] },
  { name: 'A8 - S8, groups B and C', left: 'A8', right: 'S8', set: 'primary', groups: ['B', 'C'] },
  { name: 'A8 - S8, legacy blocks', left: 'A8', right: 'S8', set: 'legacy' },
  { name: 'A8 - P8', left: 'A8', right: 'P8', set: 'primary' },
  { name: 'S8 - P8', left: 'S8', right: 'P8', set: 'primary' },
];

export function v5Policy() {
  return {
    loopGuard: { ...LOOP_GUARD_DEFAULTS },
    tailRule: { ...TAIL_RULE },
    evalAnnotations: true,
    contextCheck: true,
    requireCapConfirmation: true,
    pilotGate: true,
    pilotPerBlock: V5_PILOT_PER_BLOCK,
    pilotPerBlockMax: V5_PILOT_PER_BLOCK_MAX,
    forecastQuantile: FORECAST_QUANTILE,
    secondaryFamily: V5_SECONDARY_FAMILY,
    devPerBlock: null,
  };
}

export function streamTimeoutFor(caps) {
  const largest = Math.max(...Object.values(caps));
  return Math.max(ENGINE_STREAM_SECONDS, Math.ceil(largest / MIN_TOKENS_PER_SECOND) + HEADER_GRACE_SECONDS);
}

// `extras` carries the policy of an extended campaign. Without it the
// document is the v1-v4 profile, so replay checks against those runs hold.
export function profileDocument(caps = STAGE_CAPS, extras = {}) {
  return {
    loopGuard: null,
    tailRule: null,
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
    ...extras,
  };
}
