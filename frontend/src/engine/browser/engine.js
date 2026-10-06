/**
 * In-browser council engine. Emits the same event objects the Python SSE
 * stream parses into, so the UI does not care which engine is active.
 */

import * as council from './council.js';
import * as openrouter from './openrouter.js';
import {
  prepareCouncilQuery,
  rebuildCouncilQuery,
} from './query.js';
import { settings } from './settings.js';
import * as storage from './storage.js';

function errorText(exc) {
  if (exc instanceof Error) return exc.message || exc.name;
  return String(exc);
}

function emitTo(onEvent, event) {
  if (typeof onEvent === 'function') onEvent(event.type, event);
}

async function postRankingMetadata(queryText, stage1Results, stage2Results, labelToModel = null) {
  const ranked = await council.runPostRanking(queryText, stage1Results, stage2Results);
  return council.buildCouncilMetadata(
    labelToModel || council.canonicalLabelToModel(stage1Results),
    ranked.responseRankings,
    ranked.aggregateRankings,
    ranked.topKIndices,
    ranked.redTeam,
    ranked.consensus,
    ranked.rankingFallback,
  );
}

async function runAndSavePostRanking(
  conversationId,
  msgIndex,
  queryText,
  stage1Results,
  stage2Results,
  labelToModel = null,
) {
  try {
    const metadata = await postRankingMetadata(
      queryText,
      stage1Results,
      stage2Results,
      labelToModel,
    );
    await storage.updateStreamingMessage(conversationId, msgIndex, { metadata });
    const redTeam = metadata.red_team;
    const redOk = Boolean(redTeam) && !redTeam.error;
    let redError = null;
    if (redTeam?.error) {
      redError = redTeam.error.message || 'Red-team review unavailable';
    }
    return { metadata, redOk, redError };
  } catch (exc) {
    const metadata = council.buildCouncilMetadata(
      labelToModel || council.canonicalLabelToModel(stage1Results),
      [],
      [],
      Array.from(
        { length: Math.min(settings.topK, stage1Results.length) },
        (_, index) => index,
      ),
      null,
      {
        level: 'LOW',
        reasons: [`Post-ranking failed: ${errorText(exc)}`],
        leader_index: stage1Results.length ? 0 : null,
        leader_score: null,
        leader_mean_correctness: null,
        top1_agreement: 0,
        disputed_claims: [],
        red_team_verdict: null,
      },
      true,
    );
    await storage.updateStreamingMessage(conversationId, msgIndex, { metadata });
    return { metadata, redOk: false, redError: errorText(exc) };
  }
}

export const pipeline = { runAndSavePostRanking };

function stage2FailMessage(failures) {
  if (failures?.length) {
    const first = failures[0].error?.message || '';
    if (first) return first;
  }
  return 'All models failed to respond in Stage 2';
}

async function* emitStage1(
  conversationId,
  msgIndex,
  userMessage,
  collected,
  existingResults = null,
  existingFailures = null,
) {
  const councilModels = [...settings.councilModels];
  const pending = council.pendingStage1Slots(
    councilModels,
    settings.nSamples,
    existingResults,
  );
  if (existingFailures?.length) {
    await storage.updateStreamingMessage(conversationId, msgIndex, {
      stage1_failures: council.retainedStage1Failures(
        existingFailures,
        pending,
        councilModels,
      ),
    });
  }

  let results = [];
  let failures = [];
  for await (const [eventType, eventData] of council.stage1CollectResponsesStreaming(
    userMessage,
    { existingResults, existingFailures },
  )) {
    if (eventType === 'init') {
      yield { type: 'stage1_init', data: eventData };
    } else if (eventType === 'model_complete') {
      if (!eventData.existing) {
        await storage.appendStage1Result(conversationId, msgIndex, eventData.result);
      }
      yield { type: 'stage1_model_complete', data: eventData };
    } else if (eventType === 'model_failed') {
      if (!eventData.existing) {
        await storage.appendStage1Failure(conversationId, msgIndex, {
          model: eventData.model,
          error: eventData.error,
        });
      }
      yield { type: 'stage1_model_failed', data: eventData };
    } else if (eventType === 'all_complete') {
      results = eventData.results;
      failures = eventData.failures || [];
    }
  }

  collected.results = results;
  collected.failures = failures;
  await storage.updateStreamingMessage(conversationId, msgIndex, {
    stage1: results,
    stage1_complete: Boolean(results.length),
    stage1_failures: failures,
  });
  if (!results.length) throw new council.Stage1AllFailed(failures);
  yield { type: 'stage1_complete', data: results, failures };
}

async function* emitStage2(conversationId, msgIndex, queryText, stage1Results, collected) {
  let results = [];
  let labelToModel = {};
  let failures = [];
  collected.results = results;
  collected.labelToModel = labelToModel;
  collected.failures = failures;

  for await (const [eventType, eventData] of council.stage2CollectRankingsStreaming(
    queryText,
    stage1Results,
  )) {
    if (eventType === 'init') {
      yield { type: 'stage2_init', data: eventData };
    } else if (eventType === 'model_complete') {
      yield { type: 'stage2_model_complete', data: eventData };
    } else if (eventType === 'model_failed') {
      failures.push(eventData);
      collected.failures = failures;
      yield { type: 'stage2_model_failed', data: eventData };
    } else if (eventType === 'all_complete') {
      results = eventData.results;
      labelToModel = eventData.label_to_model;
      failures = eventData.failures || failures;
      collected.results = results;
      collected.labelToModel = labelToModel;
      collected.failures = failures;
    }
  }

  if (!results.length) throw new Error(stage2FailMessage(failures));

  await storage.updateStreamingMessage(conversationId, msgIndex, {
    stage2: results,
    stage2_failures: failures,
    metadata: { label_to_model: labelToModel },
  });
  yield {
    type: 'stage2_complete',
    data: results,
    failures,
    metadata: { label_to_model: labelToModel },
  };
}

async function persistGenericError(conversationId, msgIndex, stage, exc) {
  const message = errorText(exc);
  await storage.updateStreamingMessage(conversationId, msgIndex, {
    error: { stage, message },
    streaming: false,
  });
  return { type: 'error', stage, message };
}

async function persistStage2Error(conversationId, msgIndex, exc, collected) {
  const failures = collected.failures || [];
  const message = errorText(exc);
  await storage.updateStreamingMessage(conversationId, msgIndex, {
    error: { stage: 2, message },
    stage2_failures: failures,
    streaming: false,
  });
  return { type: 'stage2_error', stage: 2, message, failures };
}

async function persistStage1Error(conversationId, msgIndex, exc, collected) {
  let failures = [];
  if (exc instanceof council.Stage1AllFailed) failures = exc.failures;
  else if (collected.failures) failures = collected.failures;
  const message = errorText(exc);
  await storage.updateStreamingMessage(conversationId, msgIndex, {
    error: { stage: 1, message },
    stage1_failures: failures,
    streaming: false,
  });
  return { type: 'stage1_error', stage: 1, message, failures };
}

function startTitle(queryText) {
  const controller = new AbortController();
  const state = { controller, done: false, title: null };
  state.promise = council.generateConversationTitle(queryText, controller.signal).then(
    (title) => {
      state.done = true;
      state.title = title;
      return title;
    },
    () => {
      state.done = true;
      state.title = null;
      return null;
    },
  );
  return state;
}

async function settleTitle(conversationId, state) {
  if (!state.done) {
    state.controller.abort();
    return;
  }
  if (!state.title) return;
  try {
    await storage.updateConversationTitle(conversationId, state.title);
  } catch {
    // A title is optional. A storage miss must not fail the run.
  }
}

async function* runFromStage2(ctx) {
  ctx.currentStage = 2;
  yield { type: 'stage2_start' };
  const collected = {};
  try {
    yield* emitStage2(
      ctx.conversationId,
      ctx.msgIndex,
      ctx.queryText,
      ctx.stage1Results,
      collected,
    );
    ctx.stage2Results = collected.results;
    ctx.labelToModel = collected.labelToModel;
  } catch (exc) {
    yield await persistStage2Error(ctx.conversationId, ctx.msgIndex, exc, collected);
    return true;
  }

  const stopped = yield* emitRedTeamAndStage3(ctx);
  return stopped;
}

async function* emitRedTeamAndStage3(ctx) {
  yield { type: 'redteam_start' };
  const { metadata, redOk, redError } = await pipeline.runAndSavePostRanking(
    ctx.conversationId,
    ctx.msgIndex,
    ctx.queryText,
    ctx.stage1Results,
    ctx.stage2Results,
    ctx.labelToModel,
  );
  if (redOk) yield { type: 'redteam_complete', metadata };
  else {
    yield {
      type: 'redteam_error',
      message: redError || 'Red-team review unavailable',
      metadata,
    };
  }

  ctx.currentStage = 3;
  ctx.metadata = metadata;
  yield { type: 'stage3_start' };
  try {
    const stage3Result = await council.stage3SynthesizeFinal(
      ctx.queryText,
      ctx.stage1Results,
      ctx.stage2Results,
      metadata,
    );
    await storage.updateStreamingMessage(ctx.conversationId, ctx.msgIndex, {
      stage3: stage3Result,
      streaming: false,
    });
    yield { type: 'stage3_complete', data: stage3Result };
  } catch (exc) {
    await storage.updateStreamingMessage(ctx.conversationId, ctx.msgIndex, {
      error: { stage: 3, message: errorText(exc) },
      streaming: false,
    });
    yield { type: 'stage3_error', stage: 3, message: errorText(exc) };
    return true;
  }
  return false;
}

export const browserEngine = {
  async getCredits() {
    const [creditsData, keyData] = await Promise.all([
      openrouter.getCredits(),
      openrouter.getKeyInfo(),
    ]);
    if (!creditsData) throw new Error('Failed to fetch credits');
    const total = creditsData.total_credits || 0;
    const used = creditsData.total_usage || 0;
    const payload = { total, used, remaining: total - used };
    if (keyData) {
      payload.limit = keyData.limit;
      payload.limit_remaining = keyData.limit_remaining;
      payload.limit_reset = keyData.limit_reset;
    }
    return payload;
  },

  async getPricing() {
    const modelsPricing = await openrouter.getModelsPricing();
    const allModels = new Set();
    const baseOf = (model) => openrouter.catalogueModelId(model);
    for (const model of settings.councilModels) allModels.add(baseOf(model));
    allModels.add(baseOf(settings.chairmanModel));
    const redTeamId = settings.redTeamModel || settings.chairmanModel;
    allModels.add(baseOf(redTeamId));

    const pricing = {};
    for (const modelId of allModels) {
      if (modelsPricing[modelId]) pricing[modelId] = modelsPricing[modelId];
    }
    return {
      council_models: [...settings.councilModels],
      chairman_model: settings.chairmanModel,
      n_samples: settings.nSamples,
      top_k: settings.topK,
      self_exclusion: settings.selfExclusion,
      red_team_model: settings.redTeamModel,
      pricing,
    };
  },

  async getAvailableModels() {
    const modelsData = await openrouter.getModelsPricing();
    if (!modelsData || Object.keys(modelsData).length === 0) {
      throw new Error('Failed to fetch models');
    }
    const models = Object.entries(modelsData).map(([modelId, info]) => ({
      id: modelId,
      name: info.name || modelId,
      pricing: info.pricing || {},
      description: info.description || '',
    }));
    models.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return { models };
  },

  getSettings() {
    return settings.toDict();
  },

  async updateSettings(data) {
    const councilModels = data.council_models ?? settings.councilModels;
    const chairman = data.chairman_model ?? settings.chairmanModel;
    if (!councilModels?.length) {
      throw new Error('Select at least one council model');
    }
    if (!chairman || !String(chairman).trim()) {
      throw new Error('Select a chairman model');
    }
    const redTeam = 'red_team_model' in data ? data.red_team_model : settings.redTeamModel;
    const toCheck = [...councilModels, chairman];
    if (redTeam) toCheck.push(redTeam);
    let unknown;
    try {
      unknown = await openrouter.unknownCatalogueIds(toCheck);
    } catch (exc) {
      if (exc instanceof openrouter.CatalogueUnavailable) {
        throw new Error('Model catalogue unavailable');
      }
      throw exc;
    }
    if (unknown.length) {
      const error = new Error(`Unknown models: ${unknown.join(', ')}`);
      error.unknown_models = unknown;
      throw error;
    }
    settings.updateFromDict(data);
    return settings.toDict();
  },

  resetSettings() {
    settings.resetToDefaults();
    return settings.toDict();
  },

  forgetApiKey() {
    settings.clearApiKey();
    return settings.toDict();
  },

  listConversations() {
    return storage.listConversations();
  },

  createConversation() {
    return storage.createConversation(crypto.randomUUID());
  },

  async getConversation(conversationId) {
    const conversation = await storage.getConversation(conversationId);
    if (!conversation) throw new Error('Failed to get conversation');
    return conversation;
  },

  async removeConversation(conversationId) {
    try {
      await storage.removeConversation(conversationId);
    } catch {
      throw new Error('Failed to remove conversation');
    }
    return { status: 'ok' };
  },

  exportConversations() {
    return storage.exportConversations();
  },

  async importConversations(payload) {
    if (!payload || Array.isArray(payload) || !Array.isArray(payload.conversations)) {
      throw new Error('Invalid import file');
    }
    const imported = await storage.importConversations(payload.conversations);
    return { imported };
  },

  async sendMessageStream(conversationId, content, images = [], files = [], onEvent) {
    const conversation = await storage.getConversation(conversationId);
    if (!conversation) throw new Error('Conversation not found');

    const isFirst = conversation.messages.length === 0;
    const prepared = prepareCouncilQuery(conversation, content, images, files);
    const msgIndex = await storage.addUserTurn(
      conversationId,
      content,
      images,
      files,
      prepared.followUpTo,
    );
    await runEvents(sendEvents({
      conversationId,
      msgIndex,
      isFirst,
      prepared,
    }), onEvent);
  },

  async retryStage(conversationId, stage, messageIndex, onEvent) {
    const conversation = await storage.getConversation(conversationId);
    if (!conversation) throw new Error('Conversation not found');
    const messages = conversation.messages || [];
    if (messageIndex < 0 || messageIndex >= messages.length) {
      throw new Error('Invalid message index');
    }

    const assistant = messages[messageIndex];
    if (assistant.role !== 'assistant') {
      throw new Error('Message is not an assistant message');
    }

    if (stage === 1) {
      const rebuilt = requireUserQuery(conversation, messageIndex);
      await runEvents(retryStage1Events({
        conversationId,
        msgIndex: messageIndex,
        userMessage: rebuilt.userMessage,
        queryText: rebuilt.queryText,
        existingStage1: assistant.stage1 || [],
        existingFailures: assistant.stage1_failures || [],
      }), onEvent);
      return;
    }

    if (stage === 2) {
      if (!assistant.stage1?.length) {
        throw new Error('Stage 1 results not available. Retry Stage 1 first.');
      }
      const rebuilt = requireUserQuery(conversation, messageIndex);
      await runEvents(retryStage2Events({
        conversationId,
        msgIndex: messageIndex,
        queryText: rebuilt.queryText,
        stage1Results: assistant.stage1,
      }), onEvent);
      return;
    }
    if (stage === 3) {
      if (!assistant.stage1?.length) {
        throw new Error('Stage 1 results not available. Retry Stage 1 first.');
      }
      if (!assistant.stage2?.length) {
        throw new Error('Stage 2 results not available. Retry Stage 2 first.');
      }
      const rebuilt = requireUserQuery(conversation, messageIndex);
      await runEvents(retryStage3Events({
        conversationId,
        msgIndex: messageIndex,
        queryText: rebuilt.queryText,
        stage1Results: assistant.stage1,
        stage2Results: assistant.stage2,
        metadata: assistant.metadata || {},
      }), onEvent);
      return;
    }
    throw new Error(`Failed to retry stage ${stage}`);
  },
};

function requireUserQuery(conversation, messageIndex) {
  const messages = conversation.messages || [];
  const userIndex = messageIndex - 1;
  if (userIndex < 0 || messages[userIndex]?.role !== 'user') {
    throw new Error('Could not find corresponding user message');
  }
  return rebuildCouncilQuery(conversation, userIndex);
}

async function runEvents(generator, onEvent) {
  for await (const event of generator) emitTo(onEvent, event);
}

async function* sendEvents({ conversationId, msgIndex, isFirst, prepared }) {
  let titleState = null;
  const ctx = {
    conversationId,
    msgIndex,
    queryText: prepared.queryText,
    currentStage: null,
  };
  try {
    if (isFirst && prepared.followUpTo == null) titleState = startTitle(prepared.queryText);
    ctx.currentStage = 1;
    yield { type: 'stage1_start' };
    const collected = {};
    try {
      yield* emitStage1(conversationId, msgIndex, prepared.userMessage, collected);
      ctx.stage1Results = collected.results;
    } catch (exc) {
      yield await persistStage1Error(conversationId, msgIndex, exc, collected);
      return;
    }

    const stopped = yield* runFromStage2(ctx);
    if (stopped) return;
    yield* finishTitle(conversationId, titleState);
    titleState = null;
    yield { type: 'complete' };
  } catch (exc) {
    yield await persistGenericError(conversationId, msgIndex, ctx.currentStage, exc);
  } finally {
    if (titleState) await settleTitle(conversationId, titleState);
  }
}

async function* finishTitle(conversationId, titleState) {
  if (!titleState) return;
  try {
    const title = await titleState.promise;
    if (title) {
      await storage.updateConversationTitle(conversationId, title);
      yield { type: 'title_complete', data: { title } };
    }
  } catch {
    // Title generation failed, but continue - not critical.
  }
}

async function* retryStage1Events(input) {
  const ctx = {
    conversationId: input.conversationId,
    msgIndex: input.msgIndex,
    queryText: input.queryText,
    currentStage: 1,
  };
  try {
    await storage.updateStreamingMessage(input.conversationId, input.msgIndex, {
      stage2: null,
      stage3: null,
      metadata: null,
      streaming: true,
      stage1_complete: false,
      stage2_failures: [],
    });
    yield { type: 'stage1_start' };
    const collected = {};
    try {
      yield* emitStage1(
        input.conversationId,
        input.msgIndex,
        input.userMessage,
        collected,
        input.existingStage1,
        input.existingFailures,
      );
      ctx.stage1Results = collected.results;
    } catch (exc) {
      yield await persistStage1Error(input.conversationId, input.msgIndex, exc, collected);
      return;
    }

    const stopped = yield* runFromStage2(ctx);
    if (!stopped) yield { type: 'complete' };
  } catch (exc) {
    yield await persistGenericError(input.conversationId, input.msgIndex, ctx.currentStage, exc);
  }
}

async function* retryStage2Events(input) {
  const ctx = {
    conversationId: input.conversationId,
    msgIndex: input.msgIndex,
    queryText: input.queryText,
    stage1Results: input.stage1Results,
    currentStage: 2,
  };
  try {
    await storage.updateStreamingMessage(input.conversationId, input.msgIndex, {
      stage2: null,
      stage3: null,
      metadata: null,
      streaming: true,
      stage2_failures: [],
    });
    const stopped = yield* runFromStage2(ctx);
    if (!stopped) yield { type: 'complete' };
  } catch (exc) {
    yield await persistGenericError(input.conversationId, input.msgIndex, ctx.currentStage, exc);
  }
}

async function* retryStage3Events(input) {
  try {
    await storage.updateStreamingMessage(input.conversationId, input.msgIndex, {
      stage3: null,
      streaming: true,
    });
    const stopped = yield* emitRedTeamAndStage3({
      conversationId: input.conversationId,
      msgIndex: input.msgIndex,
      queryText: input.queryText,
      stage1Results: input.stage1Results,
      stage2Results: input.stage2Results,
      labelToModel: input.metadata.label_to_model,
    });
    if (!stopped) yield { type: 'complete' };
  } catch (exc) {
    yield await persistGenericError(input.conversationId, input.msgIndex, 3, exc);
  }
}
