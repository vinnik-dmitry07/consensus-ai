import {
  buildCouncilMetadata,
  calculateAggregateRankings,
  canonicalLabelToModel,
  computeConsensus,
  stage1CollectResponsesStreaming,
  stage2CollectRankingsStreaming,
  stage3SynthesizeFinal,
} from '../src/engine/browser/council.js';
import { queryModelResult } from '../src/engine/browser/openrouter.js';
import { answerPrompt, failureKind, gradeResponse, plurality } from './grade.js';
import { N_SAMPLES, SCHEDULE_SEED, SELF_EXCLUSION, SELF_SAMPLES, TOP_K } from './a8Profile.js';
import { sha256 } from './util.js';
import { BudgetPaused } from './budget.js';
import { isEvalInvariant } from './invariant.js';
import { selfMoaPrompt } from './variants.js';

function messages(content) {
  return [{ role: 'user', content }];
}

export function finalOrder(questionId, seed) {
  const digest = sha256(`${seed}\nfinal\n${questionId}`);
  return Number.parseInt(digest.slice(0, 2), 16) % 2 === 0 ? ['A8', 'S8'] : ['S8', 'A8'];
}

function rosterOf(frozen) {
  return {
    councilModels: [...frozen.councilModels],
    chairmanModel: frozen.chairmanModel,
    redTeamModel: null,
    nSamples: N_SAMPLES,
    topK: TOP_K,
    selfExclusion: SELF_EXCLUSION,
    strictChairman: true,
  };
}

async function collectStage(session, generator) {
  let complete = null;
  for await (const event of generator) {
    if (event[0] === 'all_complete') complete = event[1];
  }
  await session.drain();
  return complete;
}

function budgetPaused(session) {
  return session.budget.state.paused ? session.budget.state.pauseReason : null;
}

function coolingSkip(session, questionId) {
  return session.slots().some((slot) => (
    slot.meta?.questionId === questionId && slot.state === 'skipped'
  ));
}

function gradeCall(task, result) {
  if (!result) return gradeResponse(task, '', 'provider_error');
  if (!result.ok) return gradeResponse(task, '', failureKind(result));
  const grade = gradeResponse(task, result.content || '');
  return { ...grade, text: result.content || '' };
}

function terminal(reason) {
  return {
    correct: 0,
    status: 'not_run',
    reason,
    formatCompliant: false,
    extracted: null,
    text: '',
  };
}

function findSlot(session, meta) {
  return session.slots().find((slot) => (
    slot.meta
    && slot.meta.questionId === meta.questionId
    && slot.meta.branch === meta.branch
    && slot.meta.stage === meta.stage
    && slot.meta.sample === meta.sample
    && slot.meta.model === meta.model
  )) || null;
}

export async function runComparison(task, session, frozen, options = {}) {
  const roster = rosterOf(frozen);
  const prompt = answerPrompt(task);
  const questionId = task.id;
  const outcome = {
    id: questionId,
    split: task.split,
    block: task.block,
    status: 'complete',
    calls: [],
  };
  const stop = (status, reason) => ({ ...outcome, status, reason, pending: status !== 'complete' });

  try {
    session.setContext({ questionId, branch: 'council', stage: 'stage1', sample: 1 });
    const stage1 = await collectStage(session, stage1CollectResponsesStreaming(prompt, { roster, n: 1 }));
    if (budgetPaused(session)) return stop('pending', budgetPaused(session));
    if (coolingSkip(session, questionId)) return stop('pending', 'cooldown');
    const stage1Results = stage1?.results || [];
    const sample1 = stage1Results.find((row) => row.model === frozen.bModel) || null;
    const sample1Slot = findSlot(session, {
      questionId,
      branch: 'council',
      stage: 'stage1',
      sample: 1,
      model: frozen.bModel,
    });
    const samples = [{
      sample: 1,
      text: sample1?.response || '',
      result: sample1
        ? { ok: true, content: sample1.response }
        : (sample1Slot?.result ?? null),
    }];

    for (let sample = 2; sample <= SELF_SAMPLES; sample += 1) {
      session.setContext({ questionId, branch: 'replicates', stage: 'sample', sample, model: frozen.bModel });
      const result = await queryModelResult(frozen.bModel, messages(prompt));
      await session.drain();
      if (budgetPaused(session) && !result?.ok) return stop('pending', budgetPaused(session));
      if (result?.skipped || coolingSkip(session, questionId)) return stop('pending', 'cooldown');
      samples.push({ sample, text: result?.content || '', result });
    }

    let stage2Results = [];
    const councilReady = frozen.councilModels.every((model) => {
      const row = stage1Results.find((item) => item.model === model);
      return row && String(row.response || '').trim();
    });
    if (councilReady) {
      session.setContext({ questionId, branch: 'council', stage: 'stage2', sample: 1 });
      const stage2 = await collectStage(
        session,
        stage2CollectRankingsStreaming(prompt, stage1Results, { roster }),
      );
      stage2Results = stage2?.results || [];
    }
    if (budgetPaused(session)) return stop('pending', budgetPaused(session));
    if (coolingSkip(session, questionId)) return stop('pending', 'cooldown');

    const ranked = stage2Results.length
      ? calculateAggregateRankings(stage1Results, stage2Results)
      : { responseRankings: [], aggregateRankings: [], rankingFallback: false };
    const topN = Math.max(1, Math.min(roster.topK, ranked.responseRankings.length));
    const topKIndices = ranked.responseRankings.slice(0, topN).map((row) => row.index);
    const consensus = computeConsensus(ranked.responseRankings, stage2Results, null);
    const metadata = buildCouncilMetadata(
      canonicalLabelToModel(stage1Results),
      ranked.responseRankings,
      ranked.aggregateRankings,
      topKIndices,
      null,
      consensus,
      ranked.rankingFallback,
    );

    async function runA8() {
      if (budgetPaused(session)) return stop('pending', budgetPaused(session));
      if (!councilReady || !stage2Results.length) {
        return terminal(councilReady ? 'no_stage2' : 'incomplete_council');
      }
      session.setContext({ questionId, branch: 'A8', stage: 'stage3', sample: 1, model: frozen.chairmanModel });
      try {
        const stage3 = await stage3SynthesizeFinal(prompt, stage1Results, stage2Results, metadata, {
          roster,
        });
        await session.drain();
        const grade = gradeResponse(task, stage3.response || '');
        return {
          ...grade,
          text: stage3.response || '',
          model: stage3.model,
          fallback: stage3.model !== frozen.chairmanModel,
        };
      } catch (error) {
        if (isEvalInvariant(error) || error instanceof BudgetPaused) throw error;
        if (session.budget.state.paused) return stop('pending', budgetPaused(session));
        return { ...gradeResponse(task, '', 'provider_error'), reason: error.message, text: '' };
      }
    }

    async function runS8() {
      if (budgetPaused(session)) return stop('pending', budgetPaused(session));
      if (samples.length !== SELF_SAMPLES || samples.some((item) => !item.text)) {
        return terminal('incomplete_samples');
      }
      session.setContext({ questionId, branch: 'S8', stage: 'stage3', sample: 1, model: frozen.chairmanModel });
      const result = await queryModelResult(
        frozen.chairmanModel,
        messages(selfMoaPrompt(prompt, samples)),
      );
      await session.drain();
      if (session.budget.state.paused && !result?.ok) return stop('pending', budgetPaused(session));
      const grade = gradeCall(task, result);
      return { ...grade, model: frozen.chairmanModel, fallback: false };
    }

    const arms = {};
    for (const arm of finalOrder(questionId, options.scheduleSeed || SCHEDULE_SEED)) {
      const produced = arm === 'A8' ? await runA8() : await runS8();
      if (produced?.pending) return produced;
      arms[arm] = produced;
    }
    arms.B8 = gradeCall(task, samples[0].result);
    const councilGrades = frozen.councilModels.map((model) => {
      const row = stage1Results.find((item) => item.model === model);
      return row ? gradeResponse(task, row.response || '') : gradeResponse(task, '', 'provider_error');
    });
    const replicateGrades = samples.map((item) => gradeCall(task, item.result));
    const leader = ranked.responseRankings[0];
    const leaderGrade = leader
      ? gradeResponse(task, stage1Results[leader.index]?.response || '')
      : terminal('no_leader');
    outcome.arms = arms;
    outcome.diagnostics = {
      councilVote: plurality(councilGrades, (tied) => [...tied].sort()[0]),
      replicateVote: plurality(replicateGrades, (tied) => [...tied].sort()[0]),
      leader: leaderGrade,
      oracle: councilGrades.some((grade) => grade.correct === 1) ? 1 : 0,
      rescue: leaderGrade.correct === 0 && arms.A8?.correct === 1 ? 1 : 0,
      harm: leaderGrade.correct === 1 && arms.A8?.correct === 0 ? 1 : 0,
      replicateTexts: samples.map((item) => item.text),
      sameText: new Set(samples.map((item) => item.text)).size === 1,
      sameAnswer: new Set(replicateGrades.map((grade) => grade.extracted ?? '')).size === 1,
    };
    outcome.rankingFallback = Boolean(ranked.rankingFallback);
    outcome.callsExpected = frozen.councilModels.length + (SELF_SAMPLES - 1) + frozen.councilModels.length + 2;
    return outcome;
  } catch (error) {
    if (isEvalInvariant(error)) throw error;
    if (error instanceof BudgetPaused || session.budget.state.paused) {
      return stop('pending', session.budget.state.pauseReason || error.reason || 'paused');
    }
    throw error;
  }
}
