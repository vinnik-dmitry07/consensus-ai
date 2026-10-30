import { describe, expect, it } from 'vitest';

import { buildShareSnapshot, snapshotToConversation } from './snapshot.js';

function sampleConversation() {
  return {
    id: 'should-not-appear',
    removed: true,
    title: 'Shared title',
    created_at: '2020-01-01T00:00:00.000Z',
    messages: [
      {
        role: 'user',
        content: 'Question',
        images: ['data:image/png;base64,aaaa'],
        files: [{ name: 'notes.md', content: 'secret file' }],
        follow_up_to: 0,
        loading: { stage1: true },
        streaming: true,
        stage1Progress: { total: 2, completed: 1 },
        stage2Progress: { total: 2, completed: 0 },
      },
      {
        role: 'assistant',
        stage1: [{ model: 'openai/gpt', response: 'answer' }],
        stage3: { model: 'anthropic/claude', response: 'final' },
        loading: { stage3: false },
        streaming: false,
      },
    ],
  };
}

describe('share snapshot', () => {
  it('drops local ids, run state, and attachments when asked', () => {
    const snapshot = buildShareSnapshot(sampleConversation(), { includeAttachments: false });
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain('should-not-appear');
    expect(encoded).not.toContain('data:image');
    expect(encoded).not.toContain('secret file');
    expect(snapshot.conversation.removed).toBeUndefined();
    expect(snapshot.conversation.id).toBeUndefined();
    const user = snapshot.conversation.messages[0];
    expect(user.follow_up_to).toBe(0);
    expect(user.loading).toBeUndefined();
    expect(user.streaming).toBeUndefined();
    expect(user.stage1Progress).toBeUndefined();
    expect(user.stage2Progress).toBeUndefined();
    expect(user.images).toBeUndefined();
    expect(user.files).toBeUndefined();
    expect(snapshot.conversation.messages[1].stage3.response).toBe('final');
    expect(snapshot.conversation.messages[1].loading).toBeUndefined();
  });

  it('keeps attachments by default and assigns a new id on import', () => {
    const snapshot = buildShareSnapshot(sampleConversation());
    expect(snapshot.conversation.messages[0].images).toEqual(['data:image/png;base64,aaaa']);
    expect(snapshot.conversation.messages[0].files[0].name).toBe('notes.md');

    const first = snapshotToConversation(snapshot);
    const second = snapshotToConversation(snapshot);
    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(first.removed).toBe(false);
    expect(first.title).toBe('Shared title');
    expect(first.messages[0].follow_up_to).toBe(0);
    expect(JSON.stringify(first)).not.toContain('should-not-appear');
  });

  it('drops remote images, unknown fields, unfinished answers, and unsafe stage data', () => {
    const opened = snapshotToConversation({
      version: 1,
      conversation: {
        title: 'T',
        messages: [
          {
            role: 'user',
            content: 'See ![x](https://evil.test/p.png)',
            images: 'https://evil.test/p.png',
            files: [{ name: 'notes.md', content: 'kept' }, 'nope'],
            token: 'secret-token',
          },
          {
            role: 'assistant',
            streaming: true,
            stage3: { model: 'openai/gpt', response: 'partial' },
          },
          { role: 'nope', content: 'drop' },
          null,
          {
            role: 'assistant',
            stage2: [{
              model: 'openai/gpt',
              ranking: 'ok',
              parsed_ranking: 'Response 1',
              label_to_index: { '(a+)+': 0, 'Response 1': 0 },
            }],
            stage3: { model: 'anthropic/claude', response: 'final answer' },
            metadata: {
              label_to_model: { 'Response 1': 'openai/gpt', '(a+)+': 'openai/gpt' },
              aggregate_rankings: [{ model: 'openai/gpt', score: 1, rankings_count: 1 }],
              consensus: { level: 'HIGH', reasons: 'not-a-list' },
            },
          },
        ],
      },
    });

    expect(opened.messages).toHaveLength(2);
    expect(opened.messages[0].images).toBeUndefined();
    expect(opened.messages[0].token).toBeUndefined();
    expect(opened.messages[0].content).toBe('See [image: x]');
    expect(opened.messages[0].content).not.toContain('evil.test');
    expect(opened.messages[0].files).toEqual([{ name: 'notes.md', content: 'kept' }]);
    const ranking = opened.messages[1].stage2[0];
    expect(ranking.parsed_ranking).toBeUndefined();
    expect(ranking.label_to_index).toEqual({ 'Response 1': 0 });
    expect(opened.messages[1].metadata.label_to_model).toEqual({ 'Response 1': 'openai/gpt' });
    expect(opened.messages[1].metadata.consensus.level).toBe('HIGH');
    expect(opened.messages[1].metadata.consensus.reasons).toBeUndefined();
    expect(JSON.stringify(opened)).not.toContain('partial');
    expect(JSON.stringify(opened)).not.toContain('secret-token');
  });
});
