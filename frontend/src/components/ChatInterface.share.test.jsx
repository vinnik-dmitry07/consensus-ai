import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import ChatInterface from './ChatInterface';
import ShareDialog from './ShareDialog';
import { snapshotToConversation } from '../share/snapshot.js';
import { rememberShareLink } from '../share/settings.js';

function renderChat({ readOnly = false, assistant }) {
  return renderToStaticMarkup(
    <ChatInterface
      conversation={{
        id: 'chat-1',
        title: 'Shared title',
        messages: [
          { role: 'user', content: 'Question' },
          { role: 'assistant', ...assistant },
        ],
      }}
      onSendMessage={() => {}}
      onRetryStage={() => {}}
      isLoading={false}
      readOnly={readOnly}
    />,
  );
}

describe('sharing and read-only chat', () => {
  it('offers Share for a finished answer and hides it while a run is open', () => {
    const finished = renderChat({
      assistant: {
        stage1: [{ model: 'openai/gpt', response: 'one answer' }],
        stage3: { model: 'anthropic/claude', response: 'final answer' },
        loading: { stage1: false, stage2: false, stage3: false },
      },
    });
    expect(finished).toContain('share-open-button');
    expect(finished).toContain('Share');
    expect(finished).toContain('class="input-form"');

    const running = renderChat({
      assistant: {
        stage1: [{ model: 'openai/gpt', response: 'partial' }],
        streaming: true,
        loading: { stage1: true },
      },
    });
    expect(running).not.toContain('share-open-button');
  });

  it('hides the composer, retry buttons, and Share in a read-only view', () => {
    const html = renderChat({
      readOnly: true,
      assistant: {
        stage1: [{ model: 'openai/gpt', response: 'kept answer' }],
        error: { stage: 1, message: 'Stage failed' },
        loading: { stage1: false },
      },
    });
    expect(html).toContain('kept answer');
    expect(html).toContain('Stage failed');
    expect(html).not.toContain('class="input-form"');
    expect(html).not.toContain('retry-button');
    expect(html).not.toContain('share-open-button');
    expect(html).not.toContain('Ask your question');
  });

  it('renders a hostile share after the snapshot is cleaned', () => {
    const opened = snapshotToConversation({
      version: 1,
      conversation: {
        title: 'Hostile',
        messages: [
          {
            role: 'user',
            content: 'See ![x](https://evil.test/p.png)',
            images: 'https://evil.test/p.png',
          },
          {
            role: 'assistant',
            stage2: [{
              model: 'openai/gpt',
              ranking: 'judge text',
              parsed_ranking: 'Response 1',
              label_to_index: { '(a+)+$': 0, 'Response 1': 0 },
            }],
            stage3: { model: 'anthropic/claude', response: 'final answer' },
            metadata: {
              label_to_model: { 'Response 1': 'openai/gpt' },
              aggregate_rankings: [{ model: 'openai/gpt', score: 1, rankings_count: 1 }],
              consensus: { level: 'HIGH', reasons: 'not-a-list' },
            },
          },
        ],
      },
    });
    const html = renderToStaticMarkup(
      <ChatInterface
        conversation={opened}
        onSendMessage={() => {}}
        onRetryStage={() => {}}
        isLoading={false}
        readOnly
      />,
    );
    expect(html).toContain('judge text');
    expect(html).toContain('final answer');
    expect(html).toContain('[image: x]');
    expect(html).not.toContain('evil.test');
    expect(html).not.toContain('class="input-form"');
  });

  it('lets a dpaste link be removed from this device and keeps the key warning', () => {
    rememberShareLink({
      provider: 'dpaste',
      id: 'H45WFZKTR',
      link: 'https://example.github.io/consensus-ai/?share=dpaste:H45WFZKTR#abc',
      conversation_id: 'chat-1',
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-02-01T00:00:00.000Z',
    });
    const html = renderToStaticMarkup(
      <ShareDialog
        conversation={{ id: 'chat-1', title: 'Shared title', messages: [] }}
        locked
        onClose={() => {}}
      />,
    );
    expect(html).toContain('including the key');
    expect(html).toContain('Wait until the current answer finishes');
    expect(html).toContain('>Remove<');
    expect(html).not.toContain('>Delete<');
  });
});
