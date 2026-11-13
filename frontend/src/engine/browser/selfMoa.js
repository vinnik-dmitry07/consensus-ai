/**
 * Self-MoA (the S8 arm of the a8 evaluations): one model answers the
 * question several times on its own, then the same model combines those
 * answers. No peer ranking and no red team. Port of the Self-MoA part of
 * backend/council.py; the prompt text must stay identical in both engines.
 */

import { canonicalLabelToModel, MODELS_UNAVAILABLE } from './council.js';
import * as openrouter from './openrouter.js';
import { modelUnavailable } from './roster.js';
import { MODE_SELF_MOA } from './settings.js';

export const SELF_MOA_SAMPLES = 5;

export function isSelfMoaRoster(roster) {
  return roster?.mode === MODE_SELF_MOA;
}

/** The one model that answers and combines: the run's chairman. */
export function selfMoaModel(roster) {
  const chairman = String(roster?.chairmanModel || '').trim();
  if (chairman) return chairman;
  return String(roster?.councilModels?.[0] || '').trim();
}

/** The Stage 1 roster of a Self-MoA run: one model, fixed sample count. */
export function selfMoaStage1Roster(roster) {
  return {
    ...roster,
    councilModels: [selfMoaModel(roster)],
    nSamples: SELF_MOA_SAMPLES,
  };
}

export function sampleTexts(stage1Results) {
  return (stage1Results || [])
    .map((row) => (typeof row?.response === 'string' ? row.response : ''))
    .filter((text) => text.trim());
}

export function buildSelfMoaPrompt(queryText, samples) {
  const blocks = samples
    .map((text, index) => `Sample slot ${index + 1}:\n${text}`)
    .join('\n\n');
  return `You are aggregating independent answers from one model.
The samples may repeat the same mistake. Do not treat agreement as proof.

Original Question: ${queryText}

SAMPLES:

${blocks}

Your task:
- Check the reasoning of every sample. Keep what is correct and fix what is wrong.
- Where the samples disagree, work out which answer is right instead of following the majority.
- Do not mention the samples, the aggregation, or model names.

Provide a clear, well-reasoned final answer:`;
}

export function selfMoaMetadata(stage1Results, model) {
  return {
    mode: MODE_SELF_MOA,
    model,
    sample_count: sampleTexts(stage1Results).length,
    label_to_model: canonicalLabelToModel(stage1Results || []),
  };
}

export async function selfMoaSynthesize(queryText, stage1Results, roster) {
  const model = selfMoaModel(roster);
  const samples = sampleTexts(stage1Results);
  if (!samples.length) throw new Error('No samples to combine. Retry Stage 1 first.');
  if (!model || modelUnavailable(model)) throw new Error(MODELS_UNAVAILABLE);
  const prompt = buildSelfMoaPrompt(queryText, samples);
  const options = roster?.runId ? { runId: roster.runId } : {};
  const result = await openrouter.queryModelResult(
    model,
    [{ role: 'user', content: prompt }],
    options,
  );
  if (result.skipped) throw new Error(MODELS_UNAVAILABLE);
  if (!result.ok) {
    const detail = result.error?.message || 'failed to generate response';
    throw new Error(`Self-MoA model (${model}) failed: ${detail}`);
  }
  return {
    model,
    response: result.content || '',
    usage: result.usage || {},
    mode: MODE_SELF_MOA,
    sample_count: samples.length,
  };
}
