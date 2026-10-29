import { describe, expect, it, vi } from 'vitest';

import { browserEngine } from './engine.js';
import * as openrouter from './openrouter.js';
import { settings, STORAGE_KEY } from './settings.js';
import {
  addAssistantMessage,
  addUserMessage,
  appendStage1Result,
  createConversation,
  createStreamingAssistantMessage,
  exportConversations,
  getConversation,
  importConversations,
  listConversations,
  removeConversation,
  updateStreamingMessage,
} from './storage.js';

const FINAL = { model: 'chair', response: 'STALE FINAL ANSWER', usage: {} };

async function seed() {
  const id = crypto.randomUUID();
  await createConversation(id);
  await addUserMessage(id, 'hello');
  await addAssistantMessage(
    id,
    [{ model: 'a', response: 'old answer' }],
    [{ model: 'b', ranking: '1. Response 1' }],
    FINAL,
    { label_to_model: { 'Response 1': 'a' } },
  );
  return id;
}

describe('storage', () => {
  it('hides a bad id and a removed conversation', async () => {
    expect(await getConversation('../etc/passwd')).toBeNull();
    expect(await getConversation('not-a-uuid')).toBeNull();
    const id = await seed();
    await removeConversation(id);
    expect(await listConversations()).toEqual([]);
    expect((await getConversation(id)).removed).toBe(true);
  });

  it('leaves omitted fields alone and clears an explicit null', async () => {
    const id = await seed();
    await updateStreamingMessage(id, 1, { streaming: true });
    let message = (await getConversation(id)).messages[1];
    expect(message.stage3.response).toBe('STALE FINAL ANSWER');
    expect(message.stage2).toHaveLength(1);

    await updateStreamingMessage(id, 1, { stage3: null, streaming: false });
    message = (await getConversation(id)).messages[1];
    expect(message.stage3).toBeNull();
    expect(message.stage2).toHaveLength(1);
  });

  it('clears a stored error when a later update omits one', async () => {
    const id = await seed();
    await updateStreamingMessage(id, 1, {
      error: { stage: 3, message: 'boom' },
      streaming: false,
    });
    await updateStreamingMessage(id, 1, { streaming: true });
    const message = (await getConversation(id)).messages[1];
    expect(message.error).toBeUndefined();
  });

  it('does not drop parallel appends', async () => {
    const id = crypto.randomUUID();
    await createConversation(id);
    await addUserMessage(id, 'hello');
    const index = await createStreamingAssistantMessage(id);
    await Promise.all([
      appendStage1Result(id, index, { model: 'a', response: '1' }),
      appendStage1Result(id, index, { model: 'b', response: '2' }),
    ]);
    const message = (await getConversation(id)).messages[index];
    expect(message.stage1.map((row) => row.response).sort()).toEqual(['1', '2']);
  });

  it('round-trips an export', async () => {
    const id = await seed();
    const payload = await exportConversations();
    expect(payload.version).toBe(1);
    expect(payload.conversations.map((row) => row.id)).toContain(id);
    await removeConversation(id);
    const imported = await importConversations(payload.conversations);
    expect(imported).toContain(id);
    expect(await listConversations()).toHaveLength(1);
  });
});

describe('settings', () => {
  it('clamps samples and keeps the api key on reset', () => {
    settings.apiKey = 'sk-or-v1-secret';
    settings.nSamples = 99;
    settings.topK = 0;
    expect(settings.nSamples).toBe(10);
    expect(settings.topK).toBe(1);
    expect(settings.maskedApiKey).toBe('sk-o...cret');
    settings.resetToDefaults();
    expect(settings.nSamples).toBe(3);
    expect(settings.apiKey).toBe('sk-or-v1-secret');
    expect(settings.toDict().has_api_key).toBe(true);
  });

  it('applies one sample after resetSettings when the catalogue has free models', async () => {
    settings.councilModels = ['openai/gpt-4.1'];
    settings.chairmanModel = 'openai/gpt-4.1';
    settings.nSamples = 3;
    vi.spyOn(openrouter, 'getModelsPricing').mockResolvedValue({
      'test/alpha-100b:free': { name: 'Alpha', description: '' },
      'test/bravo-90b:free': { name: 'Bravo', description: '' },
    });
    const reset = await browserEngine.resetSettings();
    expect(reset.n_samples).toBe(1);
    expect(settings.nSamples).toBe(1);
    expect(settings.councilModels).toEqual(['test/alpha-100b:free', 'test/bravo-90b:free']);
  });

  it('does not store a shared key when the personal key is absent', () => {
    settings.clearApiKey();
    const snapshot = settings.toDict();
    const stored = localStorage.getItem(STORAGE_KEY) || '';
    expect(snapshot.has_api_key).toBe(false);
    expect(snapshot.masked_api_key).toBeNull();
    expect(JSON.stringify(snapshot).includes('sk-or-v1-')).toBe(false);
    expect(stored.includes('sk-or-v1-')).toBe(false);
  });

  it('keeps a skip list when the update omits it and clears on an empty array', async () => {
    const id = await seed();
    const note = { model: 'a/skip', error: { message: 'Skipped' } };
    await updateStreamingMessage(id, 1, {
      stage1_skipped: [note],
      stage2_skipped: [note],
      streaming: false,
    });
    await updateStreamingMessage(id, 1, { streaming: true });
    let message = (await getConversation(id)).messages[1];
    expect(message.stage1_skipped).toEqual([note]);
    expect(message.stage2_skipped).toEqual([note]);
    await updateStreamingMessage(id, 1, {
      stage1_skipped: [],
      stage2_skipped: [],
      streaming: false,
    });
    message = (await getConversation(id)).messages[1];
    expect(message.stage1_skipped).toEqual([]);
    expect(message.stage2_skipped).toEqual([]);
    expect(message.stage1).toEqual([{ model: 'a', response: 'old answer' }]);
  });

  it('does not clear the api key when the update is blank', () => {
    settings.apiKey = 'sk-keep';
    settings.updateFromDict({ api_key: '   ' });
    expect(settings.apiKey).toBe('sk-keep');
    settings.updateFromDict({ red_team_model: '' });
    expect(settings.redTeamModel).toBeNull();
  });
});
