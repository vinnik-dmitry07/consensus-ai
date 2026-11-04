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
import { runBranch } from './questionScope.js';
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
  try {
    for await (const event of generator) {
      if (event[0] === 'all_complete') complete = event[1];
    }
  } finally {
    // A stage stops at its first thrown call; its sibling calls still finish
    // and settle their reservations before the question moves on.
    await session.drain();
  }
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

function matchingSlots(session, meta) {
  return session.slots().filter((slot) => (
    slot.meta
    && slot.meta.questionId === meta.questionId
    && slot.meta.branch === meta.branch
    && slot.meta.stage === meta.stage
    && slot.meta.sample === meta.sample
    && slot.meta.model === meta.model
  ));
}

function findSlot(session, meta) {
  return matchingSlots(session, meta)[0] || null;
}

// The slot that produced this text. A question resumed after a pause can hold
// an older slot of the same model under another request hash, so the text
// decides which one counts.
function slotForText(session, meta, text) {
  const list = matchingSlots(session, meta).filter((slot) => slot.state === 'completed');
  return list.find((slot) => (slot.result?.content || '') === text) || list[0] || null;
}

function orderKey(slot) {
  if (!slot) return [2, Number.POSITIVE_INFINITY];
  if (slot.reusedFrom) return [0, slot.sourceOrdinal ?? Number.POSITIVE_INFINITY];
  return [1, slot.completedOrdinal ?? Number.POSITIVE_INFINITY];
}

// Stage 2 judges and the chairman see answers in a fixed order: the order in
// which their calls completed. Replayed answers keep their source journal's
// completion order and come before fresh ones. On a fresh run this is the
// streaming order the engine already produced; on a replay it reproduces the
// source run's prompts byte for byte.
export function orderBySlots(session, rows, metaOf, textOf) {
  return rows
    .map((row, index) => ({ row, index, key: orderKey(slotForText(session, metaOf(row), textOf(row))) }))
    .sort((left, right) => (
      left.key[0] - right.key[0] || left.key[1] - right.key[1] || left.index - right.index
    ))
    .map((item) => item.row);
}

class Pending extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function settleBranches(settled) {
  const failures = settled.filter((item) => item.status === 'rejected').map((item) => item.reason);
  const invariant = failures.find((error) => isEvalInvariant(error));
  if (invariant) throw invariant;
  const paused = failures.find((error) => error instanceof BudgetPaused || error instanceof Pending);
  if (paused) throw paused;
  if (failures.length) throw failures[0];
  return settled.map((item) => item.value);
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
  const context = (branch, stage, sample = 1, model = undefined) => (
    model ? { questionId, branch, stage, sample, model } : { questionId, branch, stage, sample }
  );
  const guard = () => {
    const paused = budgetPaused(session);
    if (paused) throw new Pending(paused);
    if (coolingSkip(session, questionId)) throw new Pending('cooldown');
  };

  try {
    // Stage 1 and the four extra B generations do not depend on each other.
    const stage1Branch = runBranch(context('council', 'stage1'), async () => {
      const done = await collectStage(session, stage1CollectResponsesStreaming(prompt, { roster, n: 1 }));
      return done?.results || [];
    });
    const sampleBranches = [];
    for (let sample = 2; sample <= SELF_SAMPLES; sample += 1) {
      sampleBranches.push(runBranch(context('replicates', 'sample', sample, frozen.bModel), async () => {
        const result = await queryModelResult(frozen.bModel, messages(prompt));
        await session.drain();
        return { sample, text: result?.content || '', result };
      }));
    }
    const [rawStage1, ...extraSamples] = settleBranches(
      await Promise.allSettled([stage1Branch, ...sampleBranches]),
    );
    guard();
    if (extraSamples.some((item) => item.result?.skipped)) throw new Pending('cooldown');

    const stage1Results = orderBySlots(
      session,
      rawStage1,
      (row) => context('council', 'stage1', 1, row.model),
      (row) => row.response || '',
    );
    const sample1 = stage1Results.find((row) => row.model === frozen.bModel) || null;
    const sample1Slot = findSlot(session, context('council', 'stage1', 1, frozen.bModel));
    const samples = [{
      sample: 1,
      text: sample1?.response || '',
      result: sample1
        ? { ok: true, content: sample1.response }
        : (sample1Slot?.result ?? null),
    }, ...extraSamples];

    const councilReady = frozen.councilModels.every((model) => {
      const row = stage1Results.find((item) => item.model === model);
      return row && String(row.response || '').trim();
    });

    // A8 needs Stage 2; S8 needs only the five samples. They run side by side.
    async function runA8() {
      let stage2Results = [];
      if (councilReady) {
        const stage2 = await collectStage(
          session,
          stage2CollectRankingsStreaming(prompt, stage1Results, { roster }),
        );
        stage2Results = orderBySlots(
          session,
          stage2?.results || [],
          (row) => context('council', 'stage2', 1, row.model),
          (row) => row.ranking || '',
        );
      }
      guard();
      const ranked = stage2Results.length
        ? calculateAggregateRankings(stage1Results, stage2Results)
        : { responseRankings: [], aggregateRankings: [], rankingFallback: false };
      const finish = (arm) => ({ arm, ranked });
      if (!councilReady || !stage2Results.length) {
        return finish(terminal(councilReady ? 'no_stage2' : 'incomplete_council'));
      }
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
      session.setContext(context('A8', 'stage3', 1, frozen.chairmanModel));
      try {
        const stage3 = await stage3SynthesizeFinal(prompt, stage1Results, stage2Results, metadata, {
          roster,
        });
        await session.drain();
        const grade = gradeResponse(task, stage3.response || '');
        return finish({
          ...grade,
          text: stage3.response || '',
          model: stage3.model,
          fallback: stage3.model !== frozen.chairmanModel,
        });
      } catch (error) {
        if (isEvalInvariant(error) || error instanceof BudgetPaused) throw error;
        await session.drain();
        guard();
        return finish({ ...gradeResponse(task, '', 'provider_error'), reason: error.message, text: '' });
      }
    }

    async function runS8() {
      if (samples.length !== SELF_SAMPLES || samples.some((item) => !item.text)) {
        return terminal('incomplete_samples');
      }
      const result = await queryModelResult(
        frozen.chairmanModel,
        messages(selfMoaPrompt(prompt, samples)),
      );
      await session.drain();
      if (result?.skipped) throw new Pending('cooldown');
      if (session.budget.state.paused && !result?.ok) throw new Pending(budgetPaused(session));
      const grade = gradeCall(task, result);
      return { ...grade, model: frozen.chairmanModel, fallback: false };
    }

    const order = finalOrder(questionId, options.scheduleSeed || SCHEDULE_SEED);
    const branches = order.map((arm) => (arm === 'A8'
      ? runBranch(context('council', 'stage2'), runA8)
      : runBranch(context('S8', 'stage3', 1, frozen.chairmanModel), runS8)));
    const produced = settleBranches(await Promise.allSettled(branches));
    const a8 = produced[order.indexOf('A8')];
    const s8 = produced[order.indexOf('S8')];
    const { ranked } = a8;
    const arms = {};
    for (const arm of order) arms[arm] = arm === 'A8' ? a8.arm : s8;
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
    outcome.finalOrder = order;
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
    if (error instanceof Pending) return stop('pending', error.reason || 'paused');
    if (error instanceof BudgetPaused || session.budget.state.paused) {
      return stop('pending', session.budget.state.pauseReason || error.reason || 'paused');
    }
    throw error;
  }
}
