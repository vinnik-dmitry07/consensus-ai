import { afterEach, describe, expect, it, vi } from 'vitest';

import { openShare, parseShareLocation, shareConversation } from './index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shareConversation', () => {
  it('uploads ciphertext and opens it as a new conversation', async () => {
    let stored = '';
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method === 'POST') {
        stored = new URLSearchParams(init.body).get('content');
        expect(stored).not.toContain('secret question');
        return new Response('https://dpaste.com/H45WFZKTR', {
          status: 201,
          headers: { Expires: 'Wed, 06 Nov 2026 00:00:00 GMT' },
        });
      }
      return new Response(stored, { status: 200 });
    }));

    const sourceId = '11111111-1111-4111-8111-111111111111';
    const record = await shareConversation({
      id: sourceId,
      title: 'Secret title',
      created_at: '2020-01-01T00:00:00.000Z',
      messages: [
        { role: 'user', content: 'secret question', follow_up_to: 0 },
        { role: 'assistant', stage3: { response: 'final' }, loading: { stage3: false } },
      ],
    }, {
      provider: 'dpaste',
      expiryDays: 7,
      location: new URL('https://example.github.io/consensus-ai/?c=old'),
    });

    const url = new URL(record.link);
    expect(url.searchParams.get('share')).toBe('dpaste:H45WFZKTR');
    expect(url.search).not.toContain('secret');
    expect(url.hash.length).toBeGreaterThan(1);

    const opened = await openShare(parseShareLocation(url));
    expect(opened.id).not.toBe(sourceId);
    expect(opened.title).toBe('Secret title');
    expect(opened.messages[0].content).toBe('secret question');
    expect(opened.messages[0].follow_up_to).toBe(0);
    expect(opened.messages[0].loading).toBeUndefined();
    expect(opened.messages[1].stage3.response).toBe('final');
  });

  it('still returns the link when this browser cannot store it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method === 'POST') {
        return new Response('https://dpaste.com/H45WFZKTR', { status: 201 });
      }
      return new Response('unused', { status: 200 });
    }));
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      const record = await shareConversation({
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Secret title',
        messages: [{ role: 'user', content: 'secret question' }],
      }, {
        provider: 'dpaste',
        expiryDays: 7,
        location: new URL('https://example.github.io/consensus-ai/'),
      });
      expect(record.remembered).toBe(false);
      expect(record.link).toContain('?share=dpaste:H45WFZKTR#');
      expect(record.link).not.toContain('secret question');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
