import { describe, expect, it } from 'vitest';

import { formatShareLink, isLocalShareBase, parseShareLocation, sameShareRef, shareBase } from './link.js';

const GIST_ID = 'ab'.repeat(16);
const KEY = 'abcdefghijklmnopqrstuvwxyz012345-_';

describe('share links', () => {
  it('keeps the key in the fragment and out of the query', () => {
    const base = shareBase(new URL('https://example.github.io/consensus-ai/?c=old#gone'));
    const link = formatShareLink(base, 'gist', GIST_ID, KEY);
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe('https://example.github.io/consensus-ai/');
    expect(link).toContain(`?share=gist:${GIST_ID}#${KEY}`);
    expect(url.searchParams.get('share')).toBe(`gist:${GIST_ID}`);
    expect(url.searchParams.get('c')).toBeNull();
    expect(url.search).not.toContain(KEY);
    expect(url.hash).toBe(`#${KEY}`);

    const parsed = parseShareLocation(url);
    expect(parsed).toEqual({ provider: 'gist', id: GIST_ID, key: KEY });
  });

  it('reads the key only from the fragment', () => {
    const id = 'H45WFZKTR';
    const missing = parseShareLocation(new URL(
      `https://example.github.io/consensus-ai/?share=dpaste:${id}&key=${KEY}`,
    ));
    expect(missing.error).toMatch(/missing its key/i);
    expect(missing.key).toBe('');
    expect(missing.provider).toBe('dpaste');

    const present = parseShareLocation(new URL(
      `https://example.github.io/consensus-ai/?share=dpaste:${id.toLowerCase()}&key=ignored#${KEY}`,
    ));
    expect(present).toEqual({ provider: 'dpaste', id, key: KEY });
  });

  it('treats only loopback hosts as local links', () => {
    expect(isLocalShareBase(new URL('http://localhost:5173/'))).toBe(true);
    expect(isLocalShareBase(new URL('http://127.0.0.1:4173/'))).toBe(true);
    expect(isLocalShareBase(new URL('https://example.github.io/consensus-ai/'))).toBe(false);
  });

  it('rejects a share parameter that is not a known provider and id', () => {
    expect(parseShareLocation(new URL('https://example.github.io/consensus-ai/?c=1'))).toBeNull();
    expect(parseShareLocation(new URL('https://example.github.io/?share=nope:abcdef')).error)
      .toMatch(/not valid/i);
    expect(parseShareLocation(new URL('https://example.github.io/?share=gist:short')).error)
      .toMatch(/not valid/i);
    expect(parseShareLocation(new URL('https://example.github.io/?share=dpaste:ABC10')).error)
      .toMatch(/not valid/i);
  });

  it('treats the same provider, id, and key as one share', () => {
    const link = formatShareLink('https://example.github.io/consensus-ai/', 'gist', GIST_ID, KEY);
    const parsed = parseShareLocation(new URL(link));
    expect(sameShareRef(parsed, { ...parsed })).toBe(true);
    expect(sameShareRef(parsed, { ...parsed, key: 'other-key-value' })).toBe(false);
    expect(sameShareRef(parsed, null)).toBe(false);
    expect(sameShareRef(null, null)).toBe(true);
  });
});
