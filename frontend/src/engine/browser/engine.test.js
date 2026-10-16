import { beforeEach, describe, expect, it, vi } from 'vitest';

import { API_KEY_REQUIRED, browserEngine, pipeline } from './engine.js';
import * as openrouter from './openrouter.js';
import { composeFollowUpQuery } from './query.js';
import { selectedCatalogueIds } from './roster.js';
import { resetSettingsState, settings } from './settings.js';
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

describe('skipped model progress and storage', () => {
  it.each([true, false])('preserves progress with skipped=%s and stores only real failures', async (skipped) => {
    settings.councilModels = ['a/keep', 'b/refused:free'];
    settings.chairmanModel = 'a/keep';
    settings.nSamples = 1;
    const id = await staleThread();
    vi.spyOn(openrouter, 'queryModelResult').mockImplementation(async (model) => {
      if (model === 'b/refused:free') {
        return {
          ok: false,
          skipped,
          error: { status: skipped ? 429 : 500, message: 'unavailable', detail: '' },
        };
      }
      return {
        ok: true,
        content: 'Response 1:\nCorrectness: 8/10\nFINAL RANKING:\n1. Response 1',
        usage: {},
      };
    });
    const { events, onEvent } = collectEvents();
    await browserEngine.retryStage(id, 1, 1, onEvent);

    const message = (await getConversation(id)).messages[1];
    for (const stage of [1, 2]) {
      const failed = events.find((item) => item.type === `stage${stage}_model_failed`);
      expect(failed.event.data.model).toBe('b/refused:free');
      expect(Boolean(failed.event.data.skipped)).toBe(skipped);
      const progress = events.filter((item) => (
        item.type === `stage${stage}_model_complete`
        || item.type === `stage${stage}_model_failed`
      ));
      expect(progress).toHaveLength(2);
      const expectedFailures = skipped ? [] : ['b/refused:free'];
      const completion = events.find((item) => item.type === `stage${stage}_complete`);
      expect(completion.event.failures.map((failure) => failure.model)).toEqual(expectedFailures);
      expect(message[`stage${stage}_failures`].map((failure) => failure.model)).toEqual(expectedFailures);
    }
    expect(events.some((item) => item.type === 'complete')).toBe(true);
    expect(message.stage3.response).toBeTruthy();
    expect(message.streaming).toBe(false);
  });

  it('surfaces a Stage 2 error when every judge is skipped without creating failure rows', async () => {
    settings.councilModels = ['a/keep'];
    settings.chairmanModel = 'a/keep';
    settings.nSamples = 1;
    const id = await staleThread();
    vi.spyOn(openrouter, 'queryModelResult').mockResolvedValue({
      ok: false,
      skipped: true,
      error: { status: 429, message: 'cooling down', detail: '' },
    });
    const { events, onEvent } = collectEvents();
    await browserEngine.retryStage(id, 2, 1, onEvent);

    expect(events.find((item) => item.type === 'stage2_model_failed').event.data.skipped).toBe(true);
    const error = events.find((item) => item.type === 'stage2_error').event;
    expect(error.message).toBe('All models failed to respond in Stage 2');
    expect(error.failures).toEqual([]);
    expect(events.some((item) => item.type === 'stage2_complete')).toBe(false);
    const message = (await getConversation(id)).messages[1];
    expect(message.error.stage).toBe(2);
    expect(message.stage2_failures).toEqual([]);
    expect(message.stage3).toBeNull();
    expect(message.streaming).toBe(false);
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
