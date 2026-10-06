import { describe, expect, it } from 'vitest';

import { settings } from './settings.js';
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

  it('does not clear the api key when the update is blank', () => {
    settings.apiKey = 'sk-keep';
    settings.updateFromDict({ api_key: '   ' });
    expect(settings.apiKey).toBe('sk-keep');
    settings.updateFromDict({ red_team_model: '' });
    expect(settings.redTeamModel).toBeNull();
  });
});
