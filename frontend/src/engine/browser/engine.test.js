import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_KEY_REQUIRED, browserEngine, modelsFromPricing, pipeline } from './engine.js';
import * as council from './council.js';
import * as openrouter from './openrouter.js';
import { FREE_TIER_API_KEY, resetFreeQueueForTests } from './openrouter.js';
import { composeFollowUpQuery } from './query.js';
import {
  freeTierDefaultRoster,
  readBlockedIds,
  RosterEmpty,
  runAllowedBySettings,
  selectedCatalogueIds,
} from './roster.js';
import {
  DEFAULT_CHAIRMAN_MODEL,
  DEFAULT_COUNCIL_MODELS,
  DEFAULT_N_SAMPLES,
  resetSettingsState,
  settings,
  STORAGE_KEY,
} from './settings.js';
import {
  addAssistantMessage,
  addUserMessage,
  createConversation,
  getConversation,
  updateStreamingMessage,
} from './storage.js';

function finalAnswer(text) {
  return { model: 'chair', response: text, usage: {} };
}

async function followUpThread() {
  const id = crypto.randomUUID();
  await createConversation(id);
  await addUserMessage(id, 'What is the capital of France?');
  await addAssistantMessage(
    id,
    [{ model: 'a', response: 'Paris' }],
    [{ model: 'b', ranking: '1. Response 1' }],
    finalAnswer('The capital of France is Paris.'),
    { label_to_model: { 'Response 1': 'a' } },
  );
  await addUserMessage(id, 'What about its population?', null, null, 1);
  await addAssistantMessage(
    id,
    [{ model: 'a', response: 'about 2.1M' }],
    [{ model: 'b', ranking: '1. Response 1' }],
    finalAnswer('Roughly 2.1 million.'),
    { label_to_model: { 'Response 1': 'a' } },
  );
  return id;
}

async function staleThread() {
  const id = crypto.randomUUID();
  await createConversation(id);
  await addUserMessage(id, 'hello');
  await addAssistantMessage(
    id,
    [{ model: 'a/keep', response: 'kept' }, { model: 'gone/removed', response: 'stale' }],
    [{ model: 'b', ranking: '1. Response 1' }],
    finalAnswer('STALE FINAL ANSWER'),
    { label_to_model: { 'Response 1': 'gone/removed' } },
  );
  return id;
}

beforeEach(() => {
  settings.apiKey = 'sk-test';
  vi.spyOn(openrouter, 'getModelsPricing').mockImplementation(async () => {
    const pricing = {};
    for (const id of selectedCatalogueIds()) pricing[id] = { name: id };
    return pricing;
  });
});

function collectEvents() {
  const events = [];
  const onEvent = (type, event) => events.push({ type, event });
  return { events, onEvent };
}

function failQuery() {
  const contents = [];
  vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (_model, messages) => {
    const content = messages?.[0]?.content;
    contents.push(typeof content === 'string' ? content : JSON.stringify(content));
    return { ok: false, error: { status: null, message: 'nope', detail: '' } };
  });
  return contents;
}

describe('follow-up retries', () => {
  it('recompose stage 3 against the earlier answer', async () => {
    settings.councilModels = ['anthropic/claude-opus-4.1'];
    settings.nSamples = 1;
    const id = await followUpThread();
    const contents = failQuery();
    const { onEvent } = collectEvents();
    await browserEngine.retryStage(id, 3, 3, onEvent);
    const composed = composeFollowUpQuery(
      'The capital of France is Paris.',
      'What about its population?',
    );
    expect(contents.some((text) => text.includes(composed))).toBe(true);
  });

  it('recompose stage 2 against the earlier answer', async () => {
    settings.councilModels = ['anthropic/claude-opus-4.1'];
    settings.nSamples = 1;
    const id = await followUpThread();
    const contents = failQuery();
    await browserEngine.retryStage(id, 2, 3, () => {});
    expect(contents.some((text) => text.includes('The capital of France is Paris.'))).toBe(true);
    expect(contents.some((text) => text.includes('What about its population?'))).toBe(true);
  });

  it('recompose stage 1 against the earlier answer', async () => {
    settings.councilModels = ['anthropic/claude-opus-4.1'];
    settings.nSamples = 1;
    const id = await followUpThread();
    const contents = failQuery();
    await browserEngine.retryStage(id, 1, 3, () => {});
    expect(contents[0]).toBe(composeFollowUpQuery(
      'The capital of France is Paris.',
      'What about its population?',
    ));
  });

  it('does not compose a plain message', async () => {
    settings.councilModels = ['anthropic/claude-opus-4.1'];
    settings.nSamples = 1;
    const id = await followUpThread();
    const contents = failQuery();
    await browserEngine.retryStage(id, 3, 1, () => {});
    expect(contents.some((text) => text.includes('Previous council answer'))).toBe(false);
    expect(contents.some((text) => text.includes('What is the capital of France?'))).toBe(true);
  });

  it('rejects a retry when the earlier answer is gone', async () => {
    const id = await followUpThread();
    await updateStreamingMessage(id, 1, { stage3: null, streaming: false });
    await expect(browserEngine.retryStage(id, 3, 3, () => {})).rejects.toThrow(
      /Retry that message first/,
    );
  });
});

describe('stale stage clearing', () => {
  it('clears stage 2 and 3 when a stage 1 retry fails', async () => {
    settings.councilModels = ['missing/model'];
    settings.nSamples = 1;
    const id = await staleThread();
    failQuery();
    await browserEngine.retryStage(id, 1, 1, () => {});
    const message = (await getConversation(id)).messages[1];
    expect(message.stage2).toBeNull();
    expect(message.stage3).toBeNull();
    expect(message.metadata).toBeNull();
    expect(message.stage1_complete).toBe(false);
  });

  it('clears stage 3 when a stage 2 retry fails', async () => {
    settings.councilModels = ['a/keep'];
    settings.nSamples = 1;
    const id = await staleThread();
    failQuery();
    await browserEngine.retryStage(id, 2, 1, () => {});
    const message = (await getConversation(id)).messages[1];
    expect(message.stage3).toBeNull();
  });

  it('clears stage 3 when the chairman fails', async () => {
    settings.councilModels = ['a/keep'];
    settings.chairmanModel = 'google/gemini-pro-latest';
    settings.nSamples = 1;
    const id = await staleThread();
    failQuery();
    await browserEngine.retryStage(id, 3, 1, () => {});
    const message = (await getConversation(id)).messages[1];
    expect(message.stage3).toBeNull();
  });
});

describe('stage 1 resume writeback', () => {
  it('persists only samples that are still on the council', async () => {
    settings.councilModels = ['a/keep'];
    settings.nSamples = 1;
    const id = await staleThread();
    const calls = [];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      calls.push(model);
      return { ok: false, error: { message: 'stop after stage 1' } };
    });
    await browserEngine.retryStage(id, 1, 1, () => {});
    const message = (await getConversation(id)).messages[1];
    expect(message.stage1).toEqual([{ model: 'a/keep', response: 'kept' }]);
    expect(calls).toEqual(['a/keep']);
  });
});

describe('retry errors', () => {
  it('stores a successful stage 3 retry and clears the error', async () => {
    settings.councilModels = ['a/keep'];
    settings.chairmanModel = 'google/gemini-pro-latest';
    settings.nSamples = 1;
    const id = crypto.randomUUID();
    await createConversation(id);
    await addUserMessage(id, 'hello');
    await addAssistantMessage(
      id,
      [{ model: 'a/keep', response: 'one' }],
      [{ model: 'b', ranking: '1. Response 1', ranked_indices: [0], label_to_index: { 'Response 1': 0 } }],
      null,
      { label_to_model: { 'Response 1': 'a/keep' } },
    );
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (_model, messages) => {
      const content = messages[0].content;
      if (content.startsWith('You are an adversarial')) {
        return { ok: true, content: 'Fine.\nVERDICT: UPHELD\nCONFIDENCE: 8', usage: {} };
      }
      return { ok: true, content: 'final', usage: {} };
    });
    const { events, onEvent } = collectEvents();
    await browserEngine.retryStage(id, 3, 1, onEvent);
    expect(events.some((item) => item.type === 'stage3_complete')).toBe(true);
    const assistant = (await getConversation(id)).messages[1];
    expect(assistant.streaming).toBe(false);
    expect(assistant.stage3.response).toBe('final');
    expect(assistant.error ?? null).toBeNull();
  });

  it('persists a stage 3 outer error with the stage number', async () => {
    settings.councilModels = ['a/keep'];
    settings.nSamples = 1;
    const id = crypto.randomUUID();
    await createConversation(id);
    await addUserMessage(id, 'hello');
    await addAssistantMessage(
      id,
      [{ model: 'a/keep', response: 'one' }],
      [{ model: 'b', ranking: '1. Response 1' }],
      null,
      { label_to_model: { 'Response 1': 'a/keep' } },
    );
    vi.spyOn(pipeline, 'runAndSavePostRanking').mockRejectedValue(new Error('boom'));
    const { events, onEvent } = collectEvents();
    await browserEngine.retryStage(id, 3, 1, onEvent);
    const errorEvent = events.find((item) => item.type === 'error');
    expect(errorEvent.event.stage).toBe(3);
    expect(errorEvent.event.message).toBe('boom');
    const assistant = (await getConversation(id)).messages[1];
    expect(assistant.streaming).toBe(false);
    expect(assistant.error).toEqual({ stage: 3, message: 'boom' });
  });

  it('persists a stage 1 outer error as stage 2', async () => {
    settings.councilModels = ['a/keep'];
    settings.nSamples = 1;
    const id = await staleThread();
    vi.spyOn(openrouter, 'queryModelResult').mockResolvedValue({
      ok: true,
      content: 'Response 1:\nCorrectness: 9/10\nIssues: none\n\nFINAL RANKING:\n1. Response 1',
      usage: {},
    });
    vi.spyOn(pipeline, 'runAndSavePostRanking').mockRejectedValue(new Error('boom'));
    const { events, onEvent } = collectEvents();
    await browserEngine.retryStage(id, 1, 1, onEvent);
    const errorEvent = events.find((item) => item.type === 'error');
    expect(errorEvent.event.stage).toBe(2);
    const assistant = (await getConversation(id)).messages[1];
    expect(assistant.streaming).toBe(false);
    expect(assistant.error).toEqual({ stage: 2, message: 'boom' });
  });

  it('persists a stage 2 outer error as stage 2', async () => {
    settings.councilModels = ['a/keep'];
    settings.nSamples = 1;
    const id = await staleThread();
    vi.spyOn(openrouter, 'queryModelResult').mockResolvedValue({
      ok: true,
      content: 'Response 1:\nCorrectness: 9/10\nIssues: none\n\nFINAL RANKING:\n1. Response 1',
      usage: {},
    });
    vi.spyOn(pipeline, 'runAndSavePostRanking').mockRejectedValue(new Error('boom'));
    const { events, onEvent } = collectEvents();
    await browserEngine.retryStage(id, 2, 1, onEvent);
    const errorEvent = events.find((item) => item.type === 'error');
    expect(errorEvent.event.stage).toBe(2);
    const assistant = (await getConversation(id)).messages[1];
    expect(assistant.streaming).toBe(false);
    expect(assistant.error).toEqual({ stage: 2, message: 'boom' });
  });
});

describe('api key required', () => {
  it('does not send or store a turn when no key is configured', async () => {
    settings.clearApiKey();
    const created = await browserEngine.createConversation();
    await expect(
      browserEngine.sendMessageStream(created.id, 'hello', [], [], () => {}),
    ).rejects.toThrow(API_KEY_REQUIRED);
    expect((await getConversation(created.id)).messages).toEqual([]);
  });

  it('does not retry when no key is configured', async () => {
    settings.clearApiKey();
    const id = await staleThread();
    const before = await getConversation(id);
    await expect(browserEngine.retryStage(id, 1, 1, () => {})).rejects.toThrow(API_KEY_REQUIRED);
    expect(await getConversation(id)).toEqual(before);
  });
});

describe('send', () => {
  it('saves the first-message title and the final answer', async () => {
    settings.apiKey = 'sk-test-12345678';
    settings.councilModels = ['google/gemini-pro-latest'];
    settings.chairmanModel = 'anthropic/claude-opus-4.1';
    settings.nSamples = 1;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Capital Question' } }],
      usage: {},
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (_model, messages) => {
      const content = messages?.[0]?.content || '';
      if (content.startsWith('Generate a very short title')) {
        return { ok: true, content: 'Capital Question', usage: {} };
      }
      if (content.startsWith('You are evaluating')) {
        return {
          ok: true,
          content: 'Response 1:\nCorrectness: 9/10\nIssues: none\n\nFINAL RANKING:\n1. Response 1',
          usage: {},
        };
      }
      if (content.startsWith('You are an adversarial')) {
        return { ok: true, content: 'ok\nVERDICT: UPHELD\nCONFIDENCE: 9', usage: {} };
      }
      if (content.startsWith('You are the Chairman')) {
        return { ok: true, content: 'final answer', usage: {} };
      }
      return { ok: true, content: 'paris', usage: {} };
    });
    try {
      const created = await browserEngine.createConversation();
      const { events, onEvent } = collectEvents();
      await browserEngine.sendMessageStream(
        created.id,
        'What is the capital of France?',
        [],
        [],
        onEvent,
      );
      expect(events.map((item) => item.type)).toContain('complete');
      const titleEvent = events.find((item) => item.type === 'title_complete');
      expect(titleEvent.event.data.title).toBe('Capital Question');
      const stored = await getConversation(created.id);
      expect(stored.title).toBe('Capital Question');
      expect(stored.messages[1].stage3.response).toBe('final answer');
      expect(stored.messages[0].content).toBe('What is the capital of France?');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not store a turn when every council model is delisted', async () => {
    settings.councilModels = ['apodex/apodex-1.1-mini:free'];
    settings.chairmanModel = 'apodex/apodex-1.1-mini:free-reasoning-high';
    openrouter.getModelsPricing.mockResolvedValue({
      'google/gemma-4-31b-it:free': { name: 'Gemma' },
    });
    const query = vi.spyOn(openrouter, 'queryModelResult');
    const created = await browserEngine.createConversation();
    await expect(
      browserEngine.sendMessageStream(created.id, 'hello', [], [], () => {}),
    ).rejects.toThrow(/OpenRouter will not serve apodex\/apodex-1\.1-mini:free/);
    expect((await getConversation(created.id)).messages).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(settings.nSamples).toBe(3);
    expect(settings.councilModels).toEqual(['apodex/apodex-1.1-mini:free']);
  });
});

function priceCatalogue(ids) {
  const pricing = {};
  for (const id of ids) pricing[id] = { name: id };
  openrouter.getModelsPricing.mockResolvedValue(pricing);
}

function answerQuery() {
  return vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async () => ({
    ok: true,
    content: 'Correctness: 8/10\nFINAL RANKING:\n1. Response 1\n',
    usage: {},
  }));
}

describe('all-free sample cap', () => {
  beforeEach(() => {
    vi.spyOn(openrouter, 'unknownCatalogueIds').mockResolvedValue([]);
  });

  it('persists one sample for a saved all-free council', async () => {
    settings.councilModels = ['a/one:free', 'b/two:free'];
    settings.chairmanModel = 'openai/gpt-4.1';
    settings.nSamples = 3;
    const saved = await browserEngine.updateSettings({ n_samples: 3 });
    expect(saved.n_samples).toBe(1);
    resetSettingsState();
    expect(settings.nSamples).toBe(1);
    expect(settings.councilModels).toEqual(['a/one:free', 'b/two:free']);
  });

  it('forces one sample when the patch changes the roster and the count together', async () => {
    priceCatalogue(['a/one:free', 'b/two:free', 'openai/gpt-4.1']);
    const saved = await browserEngine.updateSettings({
      council_models: ['a/one:free', 'b/two:free'],
      chairman_model: 'openai/gpt-4.1',
      n_samples: 3,
    });
    expect(saved.n_samples).toBe(1);
    resetSettingsState();
    expect(settings.nSamples).toBe(1);
  });

  it('keeps three samples for a mixed council', async () => {
    priceCatalogue(['a/one:free', 'openai/gpt-4.1']);
    const saved = await browserEngine.updateSettings({
      council_models: ['a/one:free', 'openai/gpt-4.1'],
      chairman_model: 'openai/gpt-4.1',
      n_samples: 3,
    });
    expect(saved.n_samples).toBe(3);
    resetSettingsState();
    expect(settings.nSamples).toBe(3);
  });

  it('treats a reasoning suffix as the free catalogue id', async () => {
    priceCatalogue(['google/gemma:free', 'openai/gpt-4.1']);
    const saved = await browserEngine.updateSettings({
      council_models: ['google/gemma:free-reasoning-high'],
      chairman_model: 'openai/gpt-4.1',
      n_samples: 3,
    });
    expect(saved.n_samples).toBe(1);
    expect(saved.council_models).toEqual(['google/gemma:free-reasoning-high']);
  });

  it('caps samples after pruning leaves only free models', async () => {
    settings.councilModels = ['gone/dead:free', 'google/gemma:free'];
    settings.chairmanModel = 'openai/gpt-4.1';
    settings.nSamples = 3;
    priceCatalogue(['google/gemma:free', 'openai/gpt-4.1']);
    answerQuery();
    const created = await browserEngine.createConversation();
    await browserEngine.sendMessageStream(created.id, 'q', [], [], () => {});
    expect(settings.councilModels).toEqual(['google/gemma:free']);
    expect(settings.nSamples).toBe(1);
    const stage1 = (await getConversation(created.id)).messages[1].stage1;
    expect(stage1).toEqual([{ model: 'google/gemma:free', response: expect.any(String), usage: {} }]);
    expect(stage1).toHaveLength(1);
  });

  it('does not make an empty council valid', async () => {
    settings.councilModels = ['gone/dead:free'];
    settings.chairmanModel = 'gone/dead:free';
    settings.nSamples = 3;
    priceCatalogue(['google/gemma:free']);
    const created = await browserEngine.createConversation();
    await expect(
      browserEngine.sendMessageStream(created.id, 'q', [], [], () => {}),
    ).rejects.toThrow(/OpenRouter will not serve/);
    expect(settings.nSamples).toBe(3);
    expect(settings.councilModels).toEqual(['gone/dead:free']);
    expect((await getConversation(created.id)).messages).toEqual([]);
  });

  it('resume keeps one stored sample for an all-free council', async () => {
    settings.councilModels = ['google/gemma:free'];
    settings.chairmanModel = 'openai/gpt-4.1';
    settings.nSamples = 3;
    priceCatalogue(['google/gemma:free', 'openai/gpt-4.1']);
    const stage1Queries = [];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model, messages) => {
      const content = messages?.[0]?.content;
      if (content === 'q') stage1Queries.push(model);
      return {
        ok: true,
        content: 'Correctness: 8/10\nFINAL RANKING:\n1. Response 1\n',
        usage: {},
      };
    });
    const id = crypto.randomUUID();
    await createConversation(id);
    await addUserMessage(id, 'q');
    await addAssistantMessage(
      id,
      [
        { model: 'google/gemma:free', response: 'first' },
        { model: 'google/gemma:free', response: 'second' },
        { model: 'google/gemma:free', response: 'third' },
      ],
      [{ model: 'google/gemma:free', ranking: '1. Response 1' }],
      finalAnswer('old'),
    );
    await browserEngine.retryStage(id, 1, 1, () => {});
    const stage1 = (await getConversation(id)).messages[1].stage1;
    expect(stage1).toEqual([
      { model: 'google/gemma:free', response: 'first' },
    ]);
    expect(stage1Queries).toEqual([]);
    expect(settings.nSamples).toBe(1);
  });
});

function answerAll() {
  return vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (_model, messages) => {
    const content = messages?.[0]?.content || '';
    if (String(content).startsWith('You are evaluating')) {
      return {
        ok: true,
        content: 'Response 1:\nCorrectness: 9/10\nIssues: none\n\nFINAL RANKING:\n1. Response 1',
        usage: {},
      };
    }
    if (String(content).startsWith('You are an adversarial')) {
      return { ok: true, content: 'ok\nVERDICT: UPHELD\nCONFIDENCE: 9', usage: {} };
    }
    if (String(content).startsWith('You are the Chairman')) {
      return { ok: true, content: 'final answer', usage: {} };
    }
    return { ok: true, content: 'paris', usage: {} };
  });
}

describe('free roster without a personal key', () => {
  const saved = {};

  beforeEach(() => {
    saved.council = [...settings.councilModels];
    saved.chairman = settings.chairmanModel;
    saved.redTeam = settings.redTeamModel;
    saved.samples = settings.nSamples;
    saved.key = settings.apiKey;
  });

  afterEach(() => {
    settings.councilModels = saved.council;
    settings.chairmanModel = saved.chairman;
    settings.redTeamModel = saved.redTeam;
    settings.nSamples = saved.samples;
    if (saved.key) settings.apiKey = saved.key;
    else settings.clearApiKey();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetFreeQueueForTests();
  });

  function useFreeRoster(redTeam = null) {
    settings.clearApiKey();
    settings.councilModels = ['a/one:free', 'b/two:free'];
    settings.chairmanModel = 'a/one:free';
    settings.redTeamModel = redTeam;
    settings.nSamples = 1;
  }

  it('sends and stores a turn, and does not call the paid title model', async () => {
    useFreeRoster();
    const query = answerAll();
    const created = await browserEngine.createConversation();
    const { events, onEvent } = collectEvents();
    await browserEngine.sendMessageStream(created.id, 'What is rain?', [], [], onEvent);
    expect(events.map((item) => item.type)).toContain('complete');
    const title = events.find((item) => item.type === 'title_complete');
    expect(title.event.data.title).toBe('New Conversation');
    const stored = await getConversation(created.id);
    expect(stored.title).toBe('New Conversation');
    expect(stored.messages).toHaveLength(2);
    expect(stored.messages[1].stage3.response).toBe('final answer');
    const prompts = query.mock.calls.map((call) => String(call[1]?.[0]?.content || ''));
    expect(prompts.some((prompt) => prompt.startsWith('Generate a very short title'))).toBe(false);
    expect(prompts.length).toBeGreaterThan(0);
  });

  it.each([1, 2, 3])('retries stage %s on a free roster', async (stage) => {
    useFreeRoster();
    answerAll();
    const id = crypto.randomUUID();
    await createConversation(id);
    await addUserMessage(id, 'hello');
    await addAssistantMessage(
      id,
      [
        { model: 'a/one:free', response: 'one' },
        { model: 'b/two:free', response: 'two' },
      ],
      [{
        model: 'b/two:free',
        ranking: 'FINAL RANKING:\n1. Response 1\n2. Response 2',
        label_to_index: { 'Response 1': 0, 'Response 2': 1 },
      }],
      finalAnswer('old'),
      { label_to_model: { 'Response 1': 'a/one:free', 'Response 2': 'b/two:free' } },
    );
    const { events, onEvent } = collectEvents();
    await browserEngine.retryStage(id, stage, 1, onEvent);
    expect(events.map((item) => item.type)).toContain('complete');
    const stored = await getConversation(id);
    expect(stored.messages[1].stage3.response).toBe('final answer');
  });

  it('refuses a roster that becomes paid while the catalogue loads', async () => {
    useFreeRoster();
    openrouter.getModelsPricing.mockImplementation(async () => {
      settings.chairmanModel = 'openai/gpt-4.1';
      return {
        'a/one:free': { name: 'one' },
        'b/two:free': { name: 'two' },
        'openai/gpt-4.1': { name: 'gpt' },
      };
    });
    const created = await browserEngine.createConversation();
    await expect(
      browserEngine.sendMessageStream(created.id, 'again', [], [], () => {}),
    ).rejects.toThrow(API_KEY_REQUIRED);
    expect((await getConversation(created.id)).messages).toEqual([]);

    const id = crypto.randomUUID();
    await createConversation(id);
    await addUserMessage(id, 'hello');
    await addAssistantMessage(
      id,
      [
        { model: 'a/one:free', response: 'one' },
        { model: 'b/two:free', response: 'two' },
      ],
      [{ model: 'b/two:free', ranking: '1. Response 1' }],
      finalAnswer('old'),
    );
    const before = await getConversation(id);
    for (const stage of [1, 2, 3]) {
      settings.chairmanModel = 'a/one:free';
      await expect(
        browserEngine.retryStage(id, stage, 1, () => {}),
      ).rejects.toThrow(API_KEY_REQUIRED);
      expect(await getConversation(id)).toEqual(before);
    }
  });

  it('leaves the conversation unchanged when a paid red team still requires a key', async () => {
    useFreeRoster('openai/gpt-4.1');
    const query = vi.spyOn(openrouter, 'queryModelResult');
    const id = crypto.randomUUID();
    await createConversation(id);
    await addUserMessage(id, 'hello');
    await addAssistantMessage(id, [{ model: 'a/one:free', response: 'one' }], [], finalAnswer('old'));
    const before = await getConversation(id);
    await expect(browserEngine.sendMessageStream(id, 'again', [], [], () => {})).rejects.toThrow(API_KEY_REQUIRED);
    await expect(browserEngine.retryStage(id, 3, 1, () => {})).rejects.toThrow(API_KEY_REQUIRED);
    expect(await getConversation(id)).toEqual(before);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not post the free key for a paid model remembered in an old ranking', async () => {
    useFreeRoster();
    resetFreeQueueForTests();
    const posts = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      posts.push({
        model: body.model,
        freeKey: init.headers.Authorization === `Bearer ${FREE_TIER_API_KEY}`,
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok\nVERDICT: UPHELD\nCONFIDENCE: 4' } }],
        usage: {},
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const id = crypto.randomUUID();
    await createConversation(id);
    await addUserMessage(id, 'hello');
    await addAssistantMessage(
      id,
      [
        { model: 'a/one:free', response: 'free answer' },
        { model: 'openai/gpt-4.1', response: 'paid answer' },
      ],
      [{
        model: 'b/two:free',
        ranking: 'FINAL RANKING:\n1. Response 1\n2. Response 2',
        label_to_index: { 'Response 1': 0, 'Response 2': 1 },
      }],
      finalAnswer('old'),
      { label_to_model: { 'Response 1': 'a/one:free' } },
    );
    const { events, onEvent } = collectEvents();
    await browserEngine.retryStage(id, 3, 1, onEvent);
    expect(events.map((item) => item.type)).toContain('complete');
    expect(posts.some((post) => post.model === 'openai/gpt-4.1')).toBe(false);
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((post) => post.freeKey)).toBe(true);
    const stored = await getConversation(id);
    expect(stored.messages[1].metadata.red_team.model).toBe('openai/gpt-4.1');
    expect(stored.messages[1].metadata.red_team.error.message).toBe('No API key configured');
  });
});

function freeCataloguePricing() {
  return {
    'test/alpha-100b:free': { name: 'Alpha', description: '' },
    'test/bravo-90b:free': { name: 'Bravo', description: '' },
    'test/charlie-80b:free': { name: 'Charlie', description: '' },
    'test/delta-70b:free': { name: 'Delta', description: '' },
  };
}

function expectedFreeRoster(pricing = freeCataloguePricing()) {
  return freeTierDefaultRoster(modelsFromPricing(pricing), readBlockedIds());
}

function writeStoredSettings(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  resetSettingsState();
}

function paidStorageDocument(extra = {}) {
  return {
    council_models: [...DEFAULT_COUNCIL_MODELS],
    n_samples: DEFAULT_N_SAMPLES,
    chairman_model: DEFAULT_CHAIRMAN_MODEL,
    top_k: 3,
    red_team_model: null,
    self_exclusion: true,
    api_key: null,
    ...extra,
  };
}

describe('free tier default roster', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSettingsState();
    vi.spyOn(openrouter, 'getModelsPricing').mockResolvedValue(freeCataloguePricing());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies Top 10 Free on unset storage so a run needs no personal key', async () => {
    const expected = expectedFreeRoster();
    const saved = await browserEngine.getSettings();
    expect(openrouter.getModelsPricing).not.toHaveBeenCalled();
    expect(saved.council_models).toEqual(DEFAULT_COUNCIL_MODELS);
    expect(settings.useFreeTierDefault).toBe(true);
    const data = await browserEngine.getPricing();
    expect(data.council_models).toEqual(expected.councilModels);
    expect(data.chairman_model).toBe(expected.chairmanModel);
    expect(data.chairman_model.endsWith('-reasoning-high')).toBe(true);
    expect(data.n_samples).toBe(1);
    const savedAfter = await browserEngine.getSettings();
    expect(savedAfter.has_api_key).toBe(false);
    expect(runAllowedBySettings(savedAfter)).toBe(true);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(stored.use_free_tier_default).not.toBe(true);
    expect(stored.council_models).toEqual(expected.councilModels);
  });

  it('keeps a saved paid council that has no pending flag', async () => {
    writeStoredSettings(paidStorageDocument());
    const data = await browserEngine.getSettings();
    expect(data.council_models).toEqual(DEFAULT_COUNCIL_MODELS);
    expect(data.chairman_model).toBe(DEFAULT_CHAIRMAN_MODEL);
    expect(data.n_samples).toBe(DEFAULT_N_SAMPLES);
    expect(settings.useFreeTierDefault).toBe(false);
    expect(runAllowedBySettings(data)).toBe(false);
  });

  it('replaces a factory roster that is still marked pending-free', async () => {
    writeStoredSettings(paidStorageDocument({ use_free_tier_default: true }));
    const expected = expectedFreeRoster();
    const data = await browserEngine.getPricing();
    expect(data.council_models).toEqual(expected.councilModels);
    expect(data.chairman_model).toBe(expected.chairmanModel);
    expect(data.n_samples).toBe(1);
    expect(settings.useFreeTierDefault).toBe(false);
  });

  it('does not overwrite after a council setter clears the flag', async () => {
    settings.councilModels = ['openai/gpt-4.1'];
    settings.chairmanModel = 'openai/gpt-4.1';
    expect(settings.useFreeTierDefault).toBe(false);
    const data = await browserEngine.getSettings();
    expect(data.council_models).toEqual(['openai/gpt-4.1']);
    expect(data.chairman_model).toBe('openai/gpt-4.1');
  });

  it('leaves the paid placeholder when the catalogue is empty', async () => {
    openrouter.getModelsPricing.mockResolvedValue({});
    const data = await browserEngine.getSettings();
    expect(settings.useFreeTierDefault).toBe(true);
    expect(data.council_models).toEqual(DEFAULT_COUNCIL_MODELS);
    expect(data.n_samples).toBe(DEFAULT_N_SAMPLES);
    expect(runAllowedBySettings(data)).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    const created = await browserEngine.createConversation();
    await expect(
      browserEngine.sendMessageStream(created.id, 'hello', [], [], () => {}),
    ).rejects.toThrow(/catalogue unavailable/i);
    expect(settings.useFreeTierDefault).toBe(true);
    expect(settings.councilModels).toEqual(DEFAULT_COUNCIL_MODELS);
  });

  it('applies free models again after resetSettings on a saved paid council', async () => {
    writeStoredSettings(paidStorageDocument());
    const kept = await browserEngine.getSettings();
    expect(kept.council_models).toEqual(DEFAULT_COUNCIL_MODELS);
    const expected = expectedFreeRoster();
    const reset = await browserEngine.resetSettings();
    expect(reset.council_models).toEqual(expected.councilModels);
    expect(reset.chairman_model).toBe(expected.chairmanModel);
    expect(reset.n_samples).toBe(1);
    expect(settings.useFreeTierDefault).toBe(false);
  });

  it('does not start send from the paid eight when the flag is unset', async () => {
    const expected = expectedFreeRoster();
    const queried = [];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      queried.push(model);
      return {
        ok: true,
        content: 'Correctness: 8/10\nFINAL RANKING:\n1. Response 1\n',
        usage: {},
      };
    });
    const created = await browserEngine.createConversation();
    await browserEngine.sendMessageStream(created.id, 'q', [], [], () => {});
    expect(queried.length).toBeGreaterThan(0);
    expect(queried.some((model) => DEFAULT_COUNCIL_MODELS.includes(model))).toBe(false);
    expect(settings.councilModels).toEqual(expected.councilModels);
    expect(settings.nSamples).toBe(1);
    expect((await getConversation(created.id)).messages).toHaveLength(2);
  });

  it('does not apply free models after a same-tab roster write during the catalogue wait', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    openrouter.getModelsPricing.mockImplementation(async () => {
      await gate;
      return freeCataloguePricing();
    });
    const created = await browserEngine.createConversation();
    const pending = browserEngine.sendMessageStream(created.id, 'q', [], [], () => {});
    await vi.waitFor(() => expect(openrouter.getModelsPricing).toHaveBeenCalled());
    settings.councilModels = ['openai/gpt-4.1'];
    settings.chairmanModel = 'openai/gpt-4.1';
    release();
    await expect(pending).rejects.toThrow(API_KEY_REQUIRED);
    expect(settings.councilModels).toEqual(['openai/gpt-4.1']);
    expect(settings.chairmanModel).toBe('openai/gpt-4.1');
    expect(settings.useFreeTierDefault).toBe(false);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(stored.council_models).toEqual(['openai/gpt-4.1']);
    expect(stored.use_free_tier_default).toBe(false);
  });

  it('does not overwrite another tab roster saved during the catalogue wait', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    openrouter.getModelsPricing.mockImplementation(async () => {
      await gate;
      return {
        ...freeCataloguePricing(),
        'openai/gpt-4.1': { name: 'GPT', description: '' },
      };
    });
    vi.spyOn(openrouter, 'queryModelResult').mockResolvedValue({
      ok: true,
      content: 'Correctness: 8/10\nFINAL RANKING:\n1. Response 1\n',
      usage: {},
    });
    const created = await browserEngine.createConversation();
    const pending = browserEngine.sendMessageStream(created.id, 'q', [], [], () => {});
    await vi.waitFor(() => expect(openrouter.getModelsPricing).toHaveBeenCalled());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(paidStorageDocument({
      council_models: ['openai/gpt-4.1'],
      chairman_model: 'openai/gpt-4.1',
      api_key: 'sk-other-tab-key',
      top_k: 4,
      red_team_model: 'openai/gpt-4.1',
      use_free_tier_default: false,
    })));
    release();
    await pending;
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(stored.council_models).toEqual(['openai/gpt-4.1']);
    expect(stored.chairman_model).toBe('openai/gpt-4.1');
    expect(stored.api_key).toBe('sk-other-tab-key');
    expect(stored.top_k).toBe(4);
    expect(stored.red_team_model).toBe('openai/gpt-4.1');
    expect(stored.use_free_tier_default).toBe(false);
    expect(settings.councilModels).toEqual(['openai/gpt-4.1']);
    expect(settings.apiKey).toBe('sk-other-tab-key');
  });

  it('returns the free roster from getPricing on a fresh profile', async () => {
    const expected = expectedFreeRoster();
    const data = await browserEngine.getPricing();
    expect(data.council_models).toEqual(expected.councilModels);
    expect(data.chairman_model).toBe(expected.chairmanModel);
    expect(data.n_samples).toBe(1);
    expect(Object.keys(data.pricing).sort()).toEqual([...expected.councilModels].sort());
  });

  it('prunes a pending factory roster without finishing it when nothing ranks free', async () => {
    settings.apiKey = 'sk-test';
    const kept = DEFAULT_COUNCIL_MODELS[0];
    openrouter.getModelsPricing.mockResolvedValue({
      [kept]: { name: 'Sol' },
      'openai/gpt-4.1': { name: 'GPT' },
    });
    const queried = [];
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      queried.push(model);
      return {
        ok: true,
        content: 'Correctness: 8/10\nFINAL RANKING:\n1. Response 1\n',
        usage: {},
      };
    });
    const created = await browserEngine.createConversation();
    await browserEngine.sendMessageStream(created.id, 'q', [], [], () => {});
    expect(settings.useFreeTierDefault).toBe(true);
    expect(settings.councilModels).toEqual([
      '~openai/gpt-sol-latest',
      '~openai/gpt-sol-latest-reasoning',
    ]);
    expect(settings.chairmanModel).toBe('~openai/gpt-sol-latest-reasoning-high');
    expect(queried.length).toBeGreaterThan(0);
    expect(queried.every((model) => String(model).startsWith(kept))).toBe(true);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(stored.use_free_tier_default).toBe(true);
    expect(stored.council_models).toEqual(settings.councilModels);

    openrouter.getModelsPricing.mockResolvedValue(freeCataloguePricing());
    const later = await browserEngine.getPricing();
    const expected = expectedFreeRoster();
    expect(later.council_models).toEqual(expected.councilModels);
    expect(later.chairman_model).toBe(expected.chairmanModel);
    expect(settings.useFreeTierDefault).toBe(false);
  });

  it('does not finish the pending factory when prune finds no live council id', async () => {
    settings.apiKey = 'sk-test';
    openrouter.getModelsPricing.mockResolvedValue({
      'openai/gpt-4.1': { name: 'GPT' },
      'vendor/coder:free': { name: 'Coder' },
    });
    const created = await browserEngine.createConversation();
    await expect(
      browserEngine.sendMessageStream(created.id, 'hello', [], [], () => {}),
    ).rejects.toThrow(RosterEmpty);
    expect(settings.useFreeTierDefault).toBe(true);
    expect(settings.councilModels).toEqual(DEFAULT_COUNCIL_MODELS);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(stored.use_free_tier_default).toBe(true);
    expect(stored.council_models).toEqual(DEFAULT_COUNCIL_MODELS);
  });

  it('keeps the pending flag when a save does not change the council or chairman', async () => {
    writeStoredSettings(paidStorageDocument({
      use_free_tier_default: true,
      api_key: 'sk-old-key',
    }));
    const pricing = { 'openai/gpt-4.1': { name: 'GPT', description: '' } };
    for (const model of DEFAULT_COUNCIL_MODELS) {
      pricing[String(model).replace(/-reasoning(?:-high)?$/, '')] = {
        name: model,
        description: '',
      };
    }
    openrouter.getModelsPricing.mockResolvedValue(pricing);
    await browserEngine.updateSettings({
      council_models: [...DEFAULT_COUNCIL_MODELS],
      chairman_model: DEFAULT_CHAIRMAN_MODEL,
      n_samples: 2,
      top_k: 2,
      self_exclusion: true,
      red_team_model: null,
      api_key: 'sk-new-key',
    });
    expect(settings.useFreeTierDefault).toBe(true);
    expect(settings.apiKey).toBe('sk-new-key');
    expect(settings.nSamples).toBe(2);
    expect(settings.topK).toBe(2);
    expect(settings.councilModels).toEqual(DEFAULT_COUNCIL_MODELS);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(stored.use_free_tier_default).toBe(true);
    expect(stored.api_key).toBe('sk-new-key');
    expect(stored.top_k).toBe(2);

    await browserEngine.updateSettings({
      council_models: ['openai/gpt-4.1'],
      chairman_model: 'openai/gpt-4.1',
      n_samples: 2,
      top_k: 2,
      self_exclusion: true,
      red_team_model: null,
    });
    expect(settings.useFreeTierDefault).toBe(false);
    expect(settings.apiKey).toBe('sk-new-key');
    expect(settings.councilModels).toEqual(['openai/gpt-4.1']);
  });
});

describe('skip persistence', () => {
  const saved = {};

  beforeEach(() => {
    saved.council = [...settings.councilModels];
    saved.chairman = settings.chairmanModel;
    saved.samples = settings.nSamples;
  });

  afterEach(() => {
    settings.councilModels = saved.council;
    settings.chairmanModel = saved.chairman;
    settings.nSamples = saved.samples;
    vi.restoreAllMocks();
  });

  async function seedResume() {
    const id = crypto.randomUUID();
    await createConversation(id);
    await addUserMessage(id, 'hello');
    await addAssistantMessage(
      id,
      [
        { model: 'a/keep', response: 'first' },
        { model: 'a/keep', response: 'second' },
        { model: 'gone/removed', response: 'stale' },
      ],
      [{ model: 'b', ranking: '1. Response 1' }],
      finalAnswer('old'),
      { label_to_model: { 'Response 1': 'a/keep' } },
    );
    await updateStreamingMessage(id, 1, {
      stage1_skipped: [{
        model: 'old/skip',
        error: { message: 'Temporarily rate-limited upstream' },
      }],
      stage1_failures: [
        { model: 'a/keep', error: { message: 'Model not found (404)' } },
        { model: 'gone/removed', error: { message: 'Model not found (404)' } },
      ],
      stage2_skipped: [{ model: 'old/judge', error: { message: '{"leak":1}' } }],
      streaming: false,
    });
    return id;
  }

  it('clears stored skips before the first stage 1 event and drops samples the council no longer uses', async () => {
    settings.councilModels = ['a/keep', 'c/new'];
    settings.chairmanModel = 'a/keep';
    settings.nSamples = 1;
    const id = await seedResume();
    const seen = {};
    const real = council.stage1CollectResponsesStreaming;
    vi.spyOn(council, 'stage1CollectResponsesStreaming').mockImplementation(async function* (query, options) {
      const before = (await getConversation(id)).messages[1];
      seen.beforeSkips = before.stage1_skipped;
      seen.beforeStage1 = before.stage1;
      seen.beforeFailures = before.stage1_failures;
      const iterator = real(query, options);
      let next = await iterator.next();
      while (!next.done) {
        yield next.value;
        if (next.value[0] === 'model_failed' && next.value[1]?.skipped) {
          seen.midSkips = (await getConversation(id)).messages[1].stage1_skipped;
        }
        next = await iterator.next();
      }
    });
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      if (model === 'c/new') {
        return {
          ok: false,
          skipped: true,
          error: { message: 'Temporarily rate-limited upstream', detail: '' },
        };
      }
      return { ok: false, error: { message: 'stop' } };
    });
    vi.spyOn(council, 'stage2CollectRankingsStreaming').mockImplementation(async function* () {
      seen.stage2Skips = (await getConversation(id)).messages[1].stage2_skipped;
      yield ['init', { total_models: 1, completed: 0 }];
      throw new Error('stop after stage 1');
    });

    await browserEngine.retryStage(id, 1, 1, () => {});
    const message = (await getConversation(id)).messages[1];
    expect(seen.beforeSkips).toEqual([]);
    expect(seen.beforeStage1.map((item) => item.response)).toEqual(['first', 'second', 'stale']);
    expect(seen.beforeFailures.map((item) => item.model)).toEqual(['a/keep']);
    expect(seen.midSkips.map((item) => item.model)).toEqual(['c/new']);
    expect(message.stage1).toEqual([{ model: 'a/keep', response: 'first' }]);
    expect(message.stage1_skipped.map((item) => item.model)).toEqual(['c/new']);
    expect(seen.stage2Skips).toEqual([]);
  });

  it('keeps partial failures when a stage 1 attempt throws before they are known', async () => {
    settings.councilModels = ['a/keep'];
    settings.chairmanModel = 'a/keep';
    settings.nSamples = 1;
    const id = await seedResume();
    const seen = {};
    vi.spyOn(council, 'stage1CollectResponsesStreaming').mockImplementation(async function* () {
      const before = (await getConversation(id)).messages[1];
      seen.beforeSkips = before.stage1_skipped;
      seen.beforeStage1 = before.stage1;
      yield ['model_failed', {
        model: 'c/new',
        error: { message: 'Temporarily rate-limited upstream' },
        skipped: true,
      }];
      yield ['model_failed', {
        model: 'c/new',
        error: { message: 'Temporarily rate-limited upstream' },
        skipped: true,
      }];
      seen.midSkips = (await getConversation(id)).messages[1].stage1_skipped;
      throw new Error('boom');
    });
    const { events, onEvent } = collectEvents();
    await browserEngine.retryStage(id, 1, 1, onEvent);
    const message = (await getConversation(id)).messages[1];
    const errorEvent = events.find((item) => item.type === 'stage1_error').event;
    expect(seen.beforeSkips).toEqual([]);
    expect(seen.beforeStage1).toHaveLength(3);
    expect(seen.midSkips).toHaveLength(2);
    expect(message.stage1.map((item) => item.response)).toEqual(['first', 'second', 'stale']);
    expect(message.stage1_failures.map((item) => item.model)).toEqual(['a/keep']);
    expect(message.stage1_skipped).toHaveLength(2);
    expect(errorEvent.failures).toBeUndefined();
    expect(errorEvent.skipped).toHaveLength(2);
  });

  it('replaces stage 2 skips before a new skip is appended', async () => {
    settings.councilModels = ['a/keep'];
    settings.chairmanModel = 'a/keep';
    settings.nSamples = 1;
    const id = await seedResume();
    await updateStreamingMessage(id, 1, {
      stage1: [{ model: 'a/keep', response: 'first' }],
      streaming: false,
    });
    const seen = {};
    vi.spyOn(council, 'stage2CollectRankingsStreaming').mockImplementation(async function* () {
      seen.before = (await getConversation(id)).messages[1].stage2_skipped;
      yield ['model_failed', {
        model: 'c/new',
        error: { message: 'Temporarily rate-limited upstream' },
        skipped: true,
      }];
      seen.mid = (await getConversation(id)).messages[1].stage2_skipped;
      throw new Error('boom');
    });
    const { events, onEvent } = collectEvents();
    await browserEngine.retryStage(id, 2, 1, onEvent);
    const message = (await getConversation(id)).messages[1];
    const errorEvent = events.find((item) => item.type === 'stage2_error').event;
    expect(seen.before).toEqual([]);
    expect(seen.mid.map((item) => item.model)).toEqual(['c/new']);
    expect(message.stage2_skipped.map((item) => item.model)).toEqual(['c/new']);
    expect(message.stage1[0].response).toBe('first');
    expect(errorEvent.skipped.map((item) => item.model)).toEqual(['c/new']);
  });

  it('clears stage 2 skips when a normal run enters stage 2', async () => {
    settings.councilModels = ['a/keep'];
    settings.chairmanModel = 'a/keep';
    settings.nSamples = 1;
    const id = crypto.randomUUID();
    await createConversation(id);
    vi.spyOn(openrouter, 'queryModel').mockResolvedValue('Title');
    vi.spyOn(council, 'stage1CollectResponsesStreaming').mockImplementation(async function* () {
      yield ['init', { total_models: 1, pending_models: 1, existing_count: 0 }];
      yield ['model_complete', {
        result: { model: 'a/keep', response: 'yes' },
        existing: false,
      }];
      yield ['model_failed', {
        model: 'c/new',
        error: { message: 'Temporarily rate-limited upstream' },
        skipped: true,
      }];
      yield ['all_complete', {
        results: [{ model: 'a/keep', response: 'yes' }],
        failures: [],
      }];
      await updateStreamingMessage(id, 1, {
        stage2_skipped: [{ model: 'old/judge', error: { message: 'old' } }],
      });
    });
    vi.spyOn(council, 'stage2CollectRankingsStreaming').mockImplementation(async function* () {
      const message = (await getConversation(id)).messages[1];
      expect(message.stage2_skipped).toEqual([]);
      expect(message.stage1_skipped.map((item) => item.model)).toEqual(['c/new']);
      yield ['init', { total_models: 1, completed: 0 }];
      throw new Error('stop');
    });
    await browserEngine.sendMessageStream(id, 'hello', [], [], () => {});
    const message = (await getConversation(id)).messages[1];
    expect(message.stage1_skipped.map((item) => item.model)).toEqual(['c/new']);
    expect(message.stage2_skipped).toEqual([]);
  });
});
