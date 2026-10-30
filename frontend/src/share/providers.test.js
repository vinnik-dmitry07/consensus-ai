import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DPASTE_MAX_CHARS,
  GIST_DESCRIPTION,
  fetchShareText,
  publishShare,
  readBoundedText,
  removeShare,
} from './providers.js';

const GIST_ID = 'a'.repeat(32);
const TITLE = 'My private question';

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gist provider', () => {
  it('publishes a secret gist and does not send the conversation title', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: GIST_ID.toUpperCase() }, 201));
    vi.stubGlobal('fetch', fetchMock);

    const published = await publishShare('gist', 'ciphertext-body', { token: 'github_pat_test' });
    expect(published).toEqual({ id: GIST_ID, expires_at: null });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/gists');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer github_pat_test');
    expect(init.headers.Accept).toBe('application/vnd.github+json');
    expect(init.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    const body = JSON.parse(init.body);
    expect(body.public).toBe(false);
    expect(body.description).toBe(GIST_DESCRIPTION);
    expect(body.files['share.json'].content).toBe('ciphertext-body');
    expect(init.body).not.toContain(TITLE);
  });

  it('loads a truncated gist from its raw url and ignores other hosts', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('gist.githubusercontent.com')) {
        return new Response('FULL-CIPHER', { status: 200 });
      }
      return jsonResponse({
        files: {
          'share.json': {
            content: 'PARTIAL',
            truncated: true,
            raw_url: 'https://gist.githubusercontent.com/octocat/raw/share.json',
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchShareText('gist', GIST_ID)).resolves.toBe('FULL-CIPHER');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      files: {
        'share.json': {
          content: '',
          truncated: true,
          raw_url: 'https://evil.example/steal',
        },
      },
    })));
    await expect(fetchShareText('gist', GIST_ID)).rejects.toThrow(/too large to read back/);
  });

  it('does not blame the token when an anonymous gist read is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    await expect(fetchShareText('gist', GIST_ID)).rejects.toThrow(/rate-limiting gist reads/i);
    await expect(fetchShareText('gist', GIST_ID)).rejects.not.toThrow(/token/i);
  });

  it('drops a gist link only when the gist is gone', async () => {
    const gone = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', gone);
    await expect(removeShare('gist', GIST_ID, { token: 'github_pat_test' })).resolves.toBeUndefined();
    expect(gone).toHaveBeenCalledTimes(2);

    const stillThere = vi.fn(async (url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 404 });
      return jsonResponse({ id: GIST_ID });
    });
    vi.stubGlobal('fetch', stillThere);
    await expect(removeShare('gist', GIST_ID, { token: 'github_pat_other' }))
      .rejects.toThrow(/did not delete/i);

    const deleted = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', deleted);
    await removeShare('gist', GIST_ID, { token: 'github_pat_test' });
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it('turns gist HTTP errors into share messages', async () => {
    const cases = [
      [401, /token/i],
      [403, /Gists|rate limit/i],
      [413, /attachments/i],
      [429, /rate-limiting/i],
    ];
    for (const [status, pattern] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('secret-body', { status })));
      await expect(publishShare('gist', 'ciphertext', { token: 'github_pat_test' }))
        .rejects.toThrow(pattern);
      await expect(publishShare('gist', 'ciphertext', { token: 'github_pat_test' }))
        .rejects.not.toThrow(/secret-body/);
    }
  });
});

describe('dpaste provider', () => {
  it('posts form fields without a title and reads the paste id', async () => {
    const fetchMock = vi.fn(async () => new Response('https://dpaste.com/H45WFZKTR\n', {
      status: 201,
      headers: {
        Location: 'https://dpaste.com/H45WFZKTR',
        Expires: 'Wed, 06 Nov 2026 00:00:00 GMT',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const published = await publishShare('dpaste', 'ciphertext-body', { expiryDays: 365 });
    expect(published.id).toBe('H45WFZKTR');
    const expires = Date.parse(published.expires_at);
    const day = 24 * 60 * 60 * 1000;
    expect(expires).toBeGreaterThan(Date.now() + 364 * day);
    expect(expires).toBeLessThan(Date.now() + 366 * day);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dpaste.com/api/v2/');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers.Authorization).toBeUndefined();
    const params = new URLSearchParams(init.body);
    expect(params.get('content')).toBe('ciphertext-body');
    expect(params.get('syntax')).toBe('text');
    expect(params.get('expiry_days')).toBe('365');
    expect(params.get('title')).toBeNull();
    expect(init.body).not.toMatch(/(^|&)title=/);
    expect(init.body).not.toContain(TITLE);
  });

  it('refuses a payload over the measured character limit before uploading', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(publishShare('dpaste', 'x'.repeat(DPASTE_MAX_CHARS + 1), { expiryDays: 7 }))
      .rejects.toThrow(/50,000/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns dpaste HTTP errors into share messages', async () => {
    const cases = [
      [403, /refused/i],
      [413, /50,000/],
      [429, /rate-limiting/i],
    ];
    for (const [status, pattern] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('secret-body', { status })));
      await expect(publishShare('dpaste', 'ciphertext', { expiryDays: 7 })).rejects.toThrow(pattern);
    }
  });

  it('cannot delete a dpaste share', async () => {
    await expect(removeShare('dpaste', 'H45WFZKTR')).rejects.toThrow(/cannot be deleted/);
  });

  it('stops reading a share body past the size limit', async () => {
    const tooBig = {
      headers: { get: () => '999999999' },
      body: null,
    };
    await expect(readBoundedText(tooBig)).rejects.toThrow(/too large to open/i);

    const streamed = {
      headers: { get: () => null },
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: new Uint8Array([1, 2, 3, 4, 5]) };
            },
            releaseLock() {},
            async cancel() {},
          };
        },
      },
    };
    await expect(readBoundedText(streamed, 4)).rejects.toThrow(/too large to open/i);
  });
});
