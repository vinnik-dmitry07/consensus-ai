import {
  buildCouncilMetadata,
  calculateAggregateRankings,
  canonicalLabelToModel,
  computeConsensus,
  runPostRanking,
  stage1CollectResponsesStreaming,
  stage2CollectRankingsStreaming,
  stage3SynthesizeFinal,
} from '../src/engine/browser/council.js';
import { queryModelResult } from '../src/engine/browser/openrouter.js';
import { settings } from '../src/engine/browser/settings.js';
import { answerPrompt, failureKind, gradeResponse, plurality } from './grade.js';
import { SELF_MOA_LEAD, SCHEDULE_SEED, PLURALITY_SEED } from './protocol.js';
import { BudgetPaused } from './budget.js';
import { compareHash } from './util.js';

const TERMINAL = new Set(['completed', 'failed', 'skipped']);

function messages(content) {
  return [{ role: 'user', content }];
}

function orderedIds(ids, seed, questionId) {
  return [...ids].sort((left, right) => compareHash(`${seed}\n${questionId}`, left, right));
}

export function independentOrder(questionId, includeA0, seed = SCHEDULE_SEED) {
  const ids = ['stage1', 'b2', 'b3', 'b4', 'b5'];
  if (includeA0) ids.push('a0');
  return orderedIds(ids, seed, questionId);
}

export function synthesisOrder(questionId, seed = SCHEDULE_SEED) {
  return orderedIds(['A3', 'A6', 'A7'], seed, questionId);
}

function rosterDrift(frozen) {
  const council = settings.councilModels;
  if (council.length !== frozen.councilModels.length) return true;
  if (council.some((model, index) => model !== frozen.councilModels[index])) return true;
  if (settings.chairmanModel !== frozen.chairmanModel) return true;
  if (settings.redTeamModel) return true;
  if (settings.nSamples !== 1 || settings.topK !== 3 || settings.selfExclusion !== true) return true;
  return false;
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

function gradeSlot(task, slot) {
  if (!slot || !TERMINAL.has(slot.state)) return null;
  if (slot.state !== 'completed' || !slot.result?.ok) {
    const kind = slot.incompleteHttp ? 'truncated' : failureKind(slot.result);
    return gradeResponse(task, '', kind);
  }
  if (slot.finishReason === 'length') {
    const graded = gradeResponse(task, slot.result.content || '');
    return { ...graded, truncated: true };
  }
  return gradeResponse(task, slot.result.content || '');
}

function withGold(task, grade) {
  if (!grade) return grade;
  if (grade.status !== 'graded') {
    return { ...grade, correct: 0, formatCompliant: false };
  }
  return {
    ...grade,
    correct: grade.extracted === task.goldCanon ? 1 : 0,
    formatCompliant: true,
  };
}

function pickTied(task, tied) {
  return [...tied].sort((left, right) => compareHash(`${PLURALITY_SEED}\n${task.id}`, left, right))[0];
}

function selfMoaPrompt(taskPrompt, samples) {
  const blocks = samples.map((item) => `Sample slot ${item.sample}:\n${item.text}`).join('\n\n');
  return `${SELF_MOA_LEAD}\n\n${taskPrompt}\n\n${blocks}`;
}

async function collectStage(session, generator) {
  let complete = null;
  try {
    for await (const event of generator) {
      if (event[0] === 'all_complete') complete = event[1];
    }
  } catch (error) {
    await session.drain();
    if (session.budget.state.paused || error instanceof BudgetPaused) return { paused: true };
    throw error;
  }
  await session.drain();
  if (session.budget.state.paused) return { paused: true };
  return { paused: false, complete };
}

function rankingsFrom(stage1Results, stage2Results) {
  const ranked = calculateAggregateRankings(stage1Results, stage2Results);
  const topN = Math.max(1, Math.min(settings.topK, ranked.responseRankings.length || 1));
  return {
    ...ranked,
    topKIndices: ranked.responseRankings.slice(0, topN).map((row) => row.index),
  };
}

function sortByCouncil(rows, council) {
  return [...(rows || [])].sort((left, right) => (
    council.indexOf(left.model) - council.indexOf(right.model)
  ));
}

export async function runQuestion(task, session, frozen, baseSnap) {
  const questionId = task.id;
  const prompt = answerPrompt(task);
  const user = messages(prompt);
  const aliasA0 = frozen.chairmanModel === frozen.bModel;
  let councilSnap = baseSnap;
  const outcome = {
    id: questionId,
    split: task.split,
    block: task.block,
    status: 'complete',
    aliasA0,
  };

  const stop = (status, reason) => ({ ...outcome, status, reason, pending: status !== 'complete' });

  async function runStage1() {
    session.restoreLocal(councilSnap);
    session.setContext({ questionId, branch: 'council', stage: 'stage1', sample: 1 });
    const collected = await collectStage(
      session,
      stage1CollectResponsesStreaming(prompt, {}),
    );
    if (collected.paused) return { paused: true };
    if (rosterDrift(frozen)) return { stopped: true };
    const results = sortByCouncil(collected.complete?.results || [], frozen.councilModels);
    councilSnap = session.snapshotLocal();
    return { results, failures: collected.complete?.failures || [] };
  }

  async function runReplicate(sample) {
    session.restoreLocal(baseSnap);
    session.setContext({ questionId, branch: 'replicates', stage: 'sample', sample });
    await queryModelResult(frozen.bModel, user);
    await session.drain();
    if (session.budget.state.paused) return { paused: true };
    if (rosterDrift(frozen)) return { stopped: true };
    return { ok: true };
  }

  async function runA0() {
    session.restoreLocal(baseSnap);
    session.setContext({ questionId, branch: 'direct', stage: 'A0', sample: 1 });
    await queryModelResult(frozen.chairmanModel, user);
    await session.drain();
    if (session.budget.state.paused) return { paused: true };
    if (rosterDrift(frozen)) return { stopped: true };
    return { ok: true };
  }

  const units = {
    stage1: runStage1,
    b2: () => runReplicate(2),
    b3: () => runReplicate(3),
    b4: () => runReplicate(4),
    b5: () => runReplicate(5),
    a0: runA0,
  };
  let stage1 = null;
  for (const id of independentOrder(questionId, !aliasA0)) {
    const result = await units[id]();
    if (id === 'stage1') stage1 = result;
    if (result?.paused) return stop('paused', session.budget.state.pauseReason);
    if (result?.stopped) return stop('stopped', 'roster_mutation');
  }
  if (!stage1?.results) return stop('paused', 'stage1_missing');

  const stage1Results = stage1.results;
  let stage2Results = [];
  let ranked = null;
  if (stage1Results.length) {
    session.restoreLocal(councilSnap);
    session.setContext({ questionId, branch: 'council', stage: 'stage2', sample: 1 });
    const collected = await collectStage(
      session,
      stage2CollectRankingsStreaming(prompt, stage1Results),
    );
    if (collected.paused) return stop('paused', session.budget.state.pauseReason);
    if (rosterDrift(frozen)) return stop('stopped', 'roster_mutation');
    stage2Results = sortByCouncil(collected.complete?.results || [], frozen.councilModels);
    councilSnap = session.snapshotLocal();
  }
  const afterStage2 = councilSnap;

  function bGrade(sample) {
    if (sample === 1) {
      return gradeSlot(task, findSlot(session, {
        questionId, branch: 'council', stage: 'stage1', sample: 1, model: frozen.bModel,
      }));
    }
    return gradeSlot(task, findSlot(session, {
      questionId, branch: 'replicates', stage: 'sample', sample, model: frozen.bModel,
    }));
  }

  function councilGrades() {
    return frozen.councilModels.map((model) => gradeSlot(task, findSlot(session, {
      questionId, branch: 'council', stage: 'stage1', sample: 1, model,
    })) || gradeResponse(task, '', 'provider_error'));
  }

  const bGrades = [1, 2, 3, 4, 5].map((sample) => bGrade(sample) || gradeResponse(task, '', 'provider_error'));
  const council = councilGrades();
  const arms = {
    A1: withGold(task, bGrades[0]),
    A2: withGold(task, plurality(bGrades, (tied) => pickTied(task, tied))),
    A4: withGold(task, plurality(council, (tied) => pickTied(task, tied))),
  };
  if (aliasA0) arms.A0 = { ...arms.A1, aliased: true };
  else {
    arms.A0 = withGold(task, gradeSlot(task, findSlot(session, {
      questionId, branch: 'direct', stage: 'A0', sample: 1, model: frozen.chairmanModel,
    })) || gradeResponse(task, '', 'provider_error'));
  }

  async function runA3() {
    const samples = [1, 2, 3, 4, 5].flatMap((sample) => {
      const slot = sample === 1
        ? findSlot(session, { questionId, branch: 'council', stage: 'stage1', sample: 1, model: frozen.bModel })
        : findSlot(session, { questionId, branch: 'replicates', stage: 'sample', sample, model: frozen.bModel });
      if (slot?.state === 'completed' && slot.result?.content) {
        return [{ sample, text: slot.result.content }];
      }
      return [];
    });
    if (!samples.length) {
      arms.A3 = { correct: 0, status: 'no_answer', formatCompliant: false, extracted: null };
      return { ok: true };
    }
    session.restoreLocal(baseSnap);
    session.setContext({ questionId, branch: 'A3', stage: 'selfmoa', sample: 1 });
    await queryModelResult(frozen.chairmanModel, messages(selfMoaPrompt(prompt, samples)));
    await session.drain();
    if (session.budget.state.paused) return { paused: true };
    if (rosterDrift(frozen)) return { stopped: true };
    arms.A3 = withGold(task, gradeSlot(task, findSlot(session, {
      questionId, branch: 'A3', stage: 'selfmoa', sample: 1, model: frozen.chairmanModel,
    }))) || gradeResponse(task, '', 'provider_error');
    return { ok: true };
  }

  async function runA6() {
    if (!stage2Results.length) {
      arms.A5 = { correct: 0, status: 'not_run', formatCompliant: false, extracted: null };
      arms.A6 = { correct: 0, status: 'not_run', formatCompliant: false, extracted: null };
      arms.A7 = arms.A7 || { correct: 0, status: 'not_run', formatCompliant: false, extracted: null };
      return { ok: true };
    }
    session.restoreLocal(afterStage2);
    session.setContext({ questionId, branch: 'A6', stage: 'redteam', sample: 1 });
    ranked = await runPostRanking(prompt, stage1Results, stage2Results);
    await session.drain();
    if (session.budget.state.paused) return { paused: true };
    if (rosterDrift(frozen)) return { stopped: true };
    const labelToModel = canonicalLabelToModel(stage1Results);
    const metadata = buildCouncilMetadata(
      labelToModel,
      ranked.responseRankings,
      ranked.aggregateRankings,
      ranked.topKIndices,
      ranked.redTeam,
      ranked.consensus,
      ranked.rankingFallback,
    );
    const leader = ranked.responseRankings[0];
    if (leader && stage1Results[leader.index]) {
      arms.A5 = gradeResponse(task, stage1Results[leader.index].response || '');
    } else {
      arms.A5 = { correct: 0, status: 'no_answer', formatCompliant: false, extracted: null };
    }
    outcome.rankingFallback = Boolean(ranked.rankingFallback);
    outcome.confidence = ranked.consensus?.level || null;
    outcome.redTeamVerdict = ranked.redTeam?.verdict || null;
    outcome.redTeamMissing = !ranked.redTeam || Boolean(ranked.redTeam.error);
    session.setContext({ questionId, branch: 'A6', stage: 'stage3', sample: 1 });
    try {
      const stage3 = await stage3SynthesizeFinal(prompt, stage1Results, stage2Results, metadata);
      await session.drain();
      if (session.budget.state.paused) return { paused: true };
      arms.A6 = gradeResponse(task, stage3.response || '');
      arms.A6.model = stage3.model;
      arms.A6.fallback = stage3.model !== frozen.chairmanModel;
      outcome.a6Model = stage3.model;
    } catch (error) {
      await session.drain();
      if (session.budget.state.paused || error instanceof BudgetPaused) return { paused: true };
      arms.A6 = gradeResponse(task, '', 'provider_error');
    }
    if (rosterDrift(frozen)) return { stopped: true };
    return { ok: true };
  }

  async function runA7() {
    if (!stage2Results.length) {
      arms.A7 = { correct: 0, status: 'not_run', formatCompliant: false, extracted: null };
      if (!arms.A5) arms.A5 = { correct: 0, status: 'not_run', formatCompliant: false, extracted: null };
      return { ok: true };
    }
    session.restoreLocal(afterStage2);
    const partial = rankingsFrom(stage1Results, stage2Results);
    const consensus = computeConsensus(partial.responseRankings, stage2Results, null);
    const metadata = buildCouncilMetadata(
      canonicalLabelToModel(stage1Results),
      partial.responseRankings,
      partial.aggregateRankings,
      partial.topKIndices,
      null,
      consensus,
      partial.rankingFallback,
    );
    outcome.confidenceWithoutRedTeam = consensus.level;
    outcome.a7Metadata = {
      redTeam: metadata.red_team,
      verdict: metadata.consensus?.red_team_verdict || null,
      level: metadata.consensus?.level || null,
      reasons: metadata.consensus?.reasons || [],
    };
    if (!arms.A5) {
      const leader = partial.responseRankings[0];
      arms.A5 = leader
        ? gradeResponse(task, stage1Results[leader.index]?.response || '')
        : { correct: 0, status: 'no_answer', formatCompliant: false, extracted: null };
    }
    session.setContext({ questionId, branch: 'A7', stage: 'stage3', sample: 1 });
    try {
      const stage3 = await stage3SynthesizeFinal(prompt, stage1Results, stage2Results, metadata);
      await session.drain();
      if (session.budget.state.paused) return { paused: true };
      arms.A7 = gradeResponse(task, stage3.response || '');
      arms.A7.model = stage3.model;
      arms.A7.fallback = stage3.model !== frozen.chairmanModel;
      outcome.a7Model = stage3.model;
    } catch (error) {
      await session.drain();
      if (session.budget.state.paused || error instanceof BudgetPaused) return { paused: true };
      arms.A7 = gradeResponse(task, '', 'provider_error');
    }
    return { ok: true };
  }

  if (!stage1Results.length) {
    arms.A5 = { correct: 0, status: 'not_run', formatCompliant: false, extracted: null };
    arms.A6 = { correct: 0, status: 'not_run', formatCompliant: false, extracted: null };
    arms.A7 = { correct: 0, status: 'not_run', formatCompliant: false, extracted: null };
  }

  const synthesis = {
    A3: runA3,
    A6: stage1Results.length ? runA6 : async () => ({ ok: true }),
    A7: stage1Results.length ? runA7 : async () => ({ ok: true }),
  };
  for (const id of synthesisOrder(questionId)) {
    const result = await synthesis[id]();
    if (result?.paused) return stop('paused', session.budget.state.pauseReason);
    if (result?.stopped) return stop('stopped', 'roster_mutation');
  }

  outcome.arms = arms;
  outcome.oracleCouncil = council.some((grade) => grade?.correct === 1) ? 1 : 0;
  outcome.oracleB = bGrades.some((grade) => grade?.correct === 1) ? 1 : 0;
  outcome.leaderCorrect = arms.A5?.correct ?? null;
  outcome.availableCouncil = council.filter((grade) => grade?.status === 'graded').length;
  outcome.correctCouncil = council.filter((grade) => grade?.correct === 1).length;
  outcome.tieA2 = Boolean(arms.A2?.tie);
  outcome.tieA4 = Boolean(arms.A4?.tie);
  outcome.abstainA2 = arms.A2?.abstain ?? 0;
  outcome.abstainA4 = arms.A4?.abstain ?? 0;
  outcome.pending = false;
  return outcome;
}
