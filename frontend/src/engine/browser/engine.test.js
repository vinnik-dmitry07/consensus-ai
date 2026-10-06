import { describe, expect, it, vi } from 'vitest';

import { browserEngine, pipeline } from './engine.js';
import * as openrouter from './openrouter.js';
import { composeFollowUpQuery } from './query.js';
import { settings } from './settings.js';
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
});
