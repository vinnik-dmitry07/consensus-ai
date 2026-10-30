import { beforeEach, describe, expect, it } from 'vitest';

import {
  forgetGithubToken,
  forgetShareLink,
  getGithubToken,
  listShareLinks,
  maskToken,
  rememberShareLink,
  resetShareSettingsForTests,
  setGithubToken,
} from './settings.js';

const GIST_ID = 'a'.repeat(32);

function record(overrides = {}) {
  return {
    provider: 'gist',
    id: GIST_ID,
    link: `https://example.github.io/consensus-ai/?share=gist:${GIST_ID}#key`,
    conversation_id: 'chat-1',
    created_at: '2026-10-30T00:00:00.000Z',
    expires_at: null,
    ...overrides,
  };
}

describe('share settings', () => {
  beforeEach(() => {
    resetShareSettingsForTests();
  });

  it('stores, masks, and forgets the GitHub token', () => {
    expect(getGithubToken()).toBeNull();
    setGithubToken('  github_pat_example_token  ');
    expect(getGithubToken()).toBe('github_pat_example_token');
    expect(maskToken(getGithubToken())).toBe('gith...oken');
    expect(maskToken('short')).toBe('****');
    forgetGithubToken();
    expect(getGithubToken()).toBeNull();
  });

  it('lists links for one conversation and drops a deleted one', () => {
    rememberShareLink(record());
    rememberShareLink(record({
      provider: 'dpaste',
      id: 'H45WFZKTR',
      conversation_id: 'chat-2',
      expires_at: '2026-11-06T00:00:00.000Z',
    }));
    expect(listShareLinks('chat-1')).toHaveLength(1);
    expect(listShareLinks('chat-1')[0].id).toBe(GIST_ID);
    expect(listShareLinks('chat-2')[0].expires_at).toBe('2026-11-06T00:00:00.000Z');

    rememberShareLink(record({ link: 'https://example.github.io/consensus-ai/?share=gist:' + GIST_ID + '#new' }));
    expect(listShareLinks('chat-1')).toHaveLength(1);
    expect(listShareLinks('chat-1')[0].link).toContain('#new');

    forgetShareLink('gist', GIST_ID);
    expect(listShareLinks('chat-1')).toEqual([]);
  });
});