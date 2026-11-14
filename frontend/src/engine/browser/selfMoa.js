/**
 * Self-MoA (the S8 arm of the a8 evaluations): one model answers the
 * question several times on its own, then the same model combines those
 * answers. No peer ranking and no red team.
 *
 * The method follows the a8-open v5+ runs (frontend/eval/a8Variants.js):
 * five samples, temperature 0.7 and top_p 1, a 32768-token cap and a stream
 * deadline that lets a full cap finish, the loop guard with two attempts, the
 * tail rule for a sample cut before it wrote an answer, samples in slot
 * order, and a synthesis only from a full set. The product drops the
 * ANSWER: line format; the user's own question takes the place of the
 * graded task prompt.
 *
 * Port of the Self-MoA part of backend/council.py. Prompt text, constants
 * and the tail rule are pinned in tests/fixtures/stage2_cases.json.
 */

import {
  canonicalLabelToModel,
  MODELS_UNAVAILABLE,
  pendingStage1Slots,
  retainedStage1Failures,
  usableStage1Results,
} from './council.js';
import { LOOP_GUARD_DEFAULTS } from './loopGuard.js';
import * as openrouter from './openrouter.js';
import { modelUnavailable } from './roster.js';
import { MODE_SELF_MOA } from './settings.js';

export const SELF_MOA_SAMPLES = 5;
export const SELF_MOA_MAX_TOKENS = 32768;
export const SELF_MOA_TEMPERATURE = 0.7;
export const SELF_MOA_TOP_P = 1;
// A full 32768-token answer at 8 tokens a second, plus the header grace.
export const SELF_MOA_STREAM_SECONDS = Math.ceil(SELF_MOA_MAX_TOKENS / 8) + 120;
// Two attempts per call, as the runs allowed per slot: a stream the loop guard
// stops is asked once more, and the second keeps its text, marked loopCut.
export const SELF_MOA_MAX_ATTEMPTS = 2;
export const SELF_MOA_TAIL_CHARS = 8000;
export const SELF_MOA_TAIL_MARKER = '[This answer was cut off before a final answer. Last 8000 characters of its unfinished reasoning:]';
export const SELF_MOA_LEAD = [
  'You are aggregating independent answers from one model.',
  'The samples may repeat the same mistake. Do not treat agreement as proof.',
  'Give your own final answer.',
].join('\n');

export function isSelfMoaRoster(roster) {
  return roster?.mode === MODE_SELF_MOA;
}

/** The one model that answers and combines: the run's chairman. */
export function selfMoaModel(roster) {
  const chairman = String(roster?.chairmanModel || '').trim();
  if (chairman) return chairman;
  return String(roster?.councilModels?.[0] || '').trim();
}

/** What every Self-MoA call sends besides its messages. */
export function selfMoaRequestOptions(roster = null) {
  const options = {
    maxTokens: SELF_MOA_MAX_TOKENS,
    temperature: SELF_MOA_TEMPERATURE,
    topP: SELF_MOA_TOP_P,
    timeout: SELF_MOA_STREAM_SECONDS,
    loopGuard: { ...LOOP_GUARD_DEFAULTS },
    maxRetries: SELF_MOA_MAX_ATTEMPTS,
    // Finish reason and reasoning provenance, needed by the tail rule.
    evalAnnotations: true,
  };
  if (roster?.runId) options.runId = roster.runId;
  return options;
}

/**
 * A call that ended at its cap or at the loop guard and whose content is
 * its own reasoning, because no visible answer was ever written.
 */
export function isCutReasoning(result) {
  if (!result?.ok || result.contentFromReasoning !== true) return false;
  return result.finishReason === 'loop' || result.providerFinishReason === 'length';
}

export function sampleResult(model, response) {
  const result = {
    model,
    response: response.content || '',
    usage: response.usage || {},
  };
  if (isCutReasoning(response)) result.cut_reasoning = true;
  return result;
}

/** What the synthesis sees of one sample: a cut one gives only its tail. */
export function forwardSampleText(row) {
  const text = typeof row?.response === 'string' ? row.response : '';
  if (row?.cut_reasoning !== true) return text;
  return `${SELF_MOA_TAIL_MARKER}\n${text.slice(-SELF_MOA_TAIL_CHARS)}`;
}

export function usableSamples(stage1Results) {
  return (stage1Results || []).filter(
    (row) => typeof row?.response === 'string' && row.response.trim(),
  );
}

export function buildSelfMoaPrompt(queryText, samples) {
  const blocks = samples
    .map((text, index) => `Sample slot ${index + 1}:\n${text}`)
    .join('\n\n');
  return `${SELF_MOA_LEAD}\n\n${queryText}\n\n${blocks}`;
}

/** Written before Stage 1, so a retry keeps the mode and the model. */
export function selfMoaStartMetadata(roster) {
  return { mode: MODE_SELF_MOA, model: selfMoaModel(roster) };
}

export function selfMoaMetadata(stage1Results, model) {
  return {
    mode: MODE_SELF_MOA,
    model,
    sample_count: usableSamples(stage1Results).length,
    label_to_model: canonicalLabelToModel(stage1Results || []),
  };
}

export function incompleteSamplesMessage(count) {
  return `Only ${count} of ${SELF_MOA_SAMPLES} samples arrived. `
    + `Resume Stage 1 to fetch the rest, or combine the ${count} you have.`;
}

async function* asCompleted(factories) {
  const pending = new Set(factories.map((factory) => Promise.resolve().then(factory)));
  while (pending.size) {
    const winner = await Promise.race(
      [...pending].map((promise) => promise.then(
        (value) => ({ promise, value }),
        (reason) => ({ promise, reason, failed: true }),
      )),
    );
    pending.delete(winner.promise);
    if (winner.failed) throw winner.reason;
    yield winner.value;
  }
}

/**
 * Stage 1 of a Self-MoA run. Emits the same events as the council's Stage 1.
 * Kept samples come first; new ones follow in slot order, not in the order
 * their calls finished.
 */
export async function* collectSelfMoaSamples(userQuery, options = {}) {
  const roster = options.roster || null;
  const model = selfMoaModel(roster);
  const models = [model];
  const n = SELF_MOA_SAMPLES;
  const kept = usableStage1Results(models, n, options.existingResults ?? null);
  const pending = pendingStage1Slots(models, n, kept);
  const failures = retainedStage1Failures(options.existingFailures ?? null, pending, models);

  yield ['init', {
    total_models: n,
    pending_models: pending.length,
    existing_count: kept.length + failures.length,
  }];
  for (const result of kept) yield ['model_complete', { result, existing: true }];
  for (const failure of failures) yield ['model_failed', { ...failure, existing: true }];

  const messages = [{ role: 'user', content: userQuery }];
  const requestOptions = selfMoaRequestOptions(roster);
  const fresh = new Array(pending.length).fill(null);
  if (pending.length) {
    const tasks = pending.map((slotModel, slot) => async () => ({
      slot,
      response: await openrouter.queryModelResult(slotModel, messages, requestOptions),
    }));
    for await (const { slot, response } of asCompleted(tasks)) {
      if (response.ok) {
        const result = sampleResult(model, response);
        fresh[slot] = result;
        yield ['model_complete', { result, existing: false }];
      } else if (response.skipped) {
        yield ['model_failed', { model, error: response.error, skipped: true }];
      } else {
        const failure = { model, error: response.error };
        failures.push(failure);
        yield ['model_failed', failure];
      }
    }
  }

  yield ['all_complete', { results: [...kept, ...fresh.filter(Boolean)], failures }];
}

export async function selfMoaSynthesize(queryText, stage1Results, roster) {
  const model = selfMoaModel(roster);
  const samples = usableSamples(stage1Results).map(forwardSampleText);
  if (!samples.length) throw new Error('No samples to combine. Retry Stage 1 first.');
  if (!model || modelUnavailable(model)) throw new Error(MODELS_UNAVAILABLE);
  const prompt = buildSelfMoaPrompt(queryText, samples);
  const result = await openrouter.queryModelResult(
    model,
    [{ role: 'user', content: prompt }],
    selfMoaRequestOptions(roster),
  );
  if (result.skipped) throw new Error(MODELS_UNAVAILABLE);
  if (!result.ok) {
    const detail = result.error?.message || 'failed to generate response';
    throw new Error(`Self-MoA model (${model}) failed: ${detail}`);
  }
  const final = {
    model,
    response: result.content || '',
    usage: result.usage || {},
    mode: MODE_SELF_MOA,
    sample_count: samples.length,
  };
  if (result.finishReason === 'loop' || result.providerFinishReason === 'length') final.cut = true;
  return final;
}
