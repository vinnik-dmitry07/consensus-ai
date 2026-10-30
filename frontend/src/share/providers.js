/**
 * Hosts that store only ciphertext. Gist can be deleted with the token
 * that created it. An anonymous dpaste expires and cannot be revoked.
 */

export const GIST_DESCRIPTION = 'consensus.ai shared conversation (encrypted)';
export const GIST_FILENAME = 'share.json';
export const DPASTE_MAX_CHARS = 50000;
export const DPASTE_EXPIRY_DAYS = [7, 30, 365];
export const DEFAULT_DPASTE_EXPIRY_DAYS = 30;

const GITHUB_API = 'https://api.github.com';
const DPASTE_API = 'https://dpaste.com/api/v2/';
const GIST_ID = /^[a-f0-9]{20,64}$/i;
const DPASTE_ID = /^[A-Z2-9]{5,16}$/;

export function canonicalGistId(id) {
  const text = String(id || '');
  if (!GIST_ID.test(text)) throw new Error('This share link is not valid.');
  return text.toLowerCase();
}

export function canonicalDpasteId(id) {
  const text = String(id || '').trim().toUpperCase();
  if (!DPASTE_ID.test(text)) throw new Error('This share link is not valid.');
  return text;
}

export function parseDpasteId(value) {
  if (!value) return null;
  const text = String(value).trim();
  const fromUrl = text.match(/dpaste\.com\/([A-Za-z0-9]+)/i);
  const raw = (fromUrl ? fromUrl[1] : text).replace(/\.txt$/i, '');
  try {
    return canonicalDpasteId(raw);
  } catch {
    return null;
  }
}

export function canonicalShareId(provider, id) {
  if (provider === 'gist') return canonicalGistId(id);
  if (provider === 'dpaste') return canonicalDpasteId(id);
  throw new Error('Unknown share provider.');
}

export function normalizeExpiryDays(value) {
  const days = Number(value);
  return DPASTE_EXPIRY_DAYS.includes(days) ? days : DEFAULT_DPASTE_EXPIRY_DAYS;
}

function tooLargeMessage(provider) {
  const limit = provider === 'dpaste'
    ? ` dpaste accepts at most ${DPASTE_MAX_CHARS.toLocaleString('en-US')} characters.`
    : '';
  return `This conversation is too large to share.${limit} Try again without attachments.`;
}

async function responseDetail(response) {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.message === 'string') return parsed.message;
      if (typeof parsed.error === 'string') return parsed.error;
    } catch {
      // The host answered with plain text.
    }
    return text.trim();
  } catch {
    return '';
  }
}

async function shareHttpError(response, provider, { reading = false } = {}) {
  const status = response.status;
  const detail = await responseDetail(response);
  if (status === 401) return new Error('GitHub rejected the token. Check it in Settings.');
  if (status === 403) {
    if (provider === 'gist' && reading) {
      return new Error('GitHub is rate-limiting gist reads. Wait and try again.');
    }
    return new Error(provider === 'gist'
      ? 'GitHub refused the request. The token needs Gists read and write, or the rate limit was reached.'
      : 'The share host refused the request.');
  }
  if (status === 404) {
    return new Error('This share was not found. It may have been deleted or it has expired.');
  }
  if (status === 413 || /too large|entity too large|payload too large/i.test(detail)) {
    return new Error(tooLargeMessage(provider));
  }
  if (status === 429) return new Error('The share host is rate-limiting requests. Wait and try again.');
  const short = detail && detail.length <= 180 ? detail : '';
  return new Error(short || `Share request failed (${status}).`);
}

const MAX_ENVELOPE_BYTES = 32 * 1024 * 1024;

export async function readBoundedText(response, limit = MAX_ENVELOPE_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error('This share is too large to open.');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (text.length > limit) throw new Error('This share is too large to open.');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error('This share is too large to open.');
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // cancel() already released the reader.
    }
  }
  text += decoder.decode();
  return text;
}

async function request(url, init) {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new Error('Could not reach the share host. Check the network and try again.');
  }
}

function githubHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function allowedRawUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'gist.githubusercontent.com';
  } catch {
    return false;
  }
}

async function publishGist(text, { token } = {}) {
  if (!token) throw new Error('Add a GitHub token in Settings to share through Gist.');
  const response = await request(`${GITHUB_API}/gists`, {
    method: 'POST',
    headers: githubHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      description: GIST_DESCRIPTION,
      public: false,
      files: {
        [GIST_FILENAME]: { content: text },
      },
    }),
  });
  if (!response.ok) throw await shareHttpError(response, 'gist');
  const body = await response.json();
  if (!body.id) throw new Error('GitHub did not return a gist id.');
  return { id: canonicalGistId(body.id), expires_at: null };
}

async function fetchGist(id) {
  const safeId = canonicalGistId(id);
  const response = await request(`${GITHUB_API}/gists/${safeId}`, {
    headers: githubHeaders(),
  });
  if (!response.ok) throw await shareHttpError(response, 'gist', { reading: true });
  let body;
  try {
    body = JSON.parse(await readBoundedText(response));
  } catch (error) {
    if (error instanceof Error && error.message === 'This share is too large to open.') throw error;
    throw new Error('The stored share is not valid JSON.');
  }
  const file = body.files?.[GIST_FILENAME] || Object.values(body.files || {})[0];
  if (file?.truncated) {
    if (!allowedRawUrl(file.raw_url)) {
      throw new Error('This gist is too large to read back.');
    }
    const raw = await request(file.raw_url);
    if (!raw.ok) throw await shareHttpError(raw, 'gist', { reading: true });
    return readBoundedText(raw);
  }
  if (typeof file?.content !== 'string' || !file.content) {
    throw new Error('This gist has no share file.');
  }
  return file.content;
}

async function removeGist(id, { token } = {}) {
  if (!token) throw new Error('Add a GitHub token in Settings to delete a Gist share.');
  const safeId = canonicalGistId(id);
  const response = await request(`${GITHUB_API}/gists/${safeId}`, {
    method: 'DELETE',
    headers: githubHeaders(token),
  });
  if (response.ok) return;
  if (response.status !== 404) throw await shareHttpError(response, 'gist');
  const check = await request(`${GITHUB_API}/gists/${safeId}`, {
    headers: githubHeaders(),
  });
  if (check.status === 404) return;
  if (check.ok) {
    await check.body?.cancel?.();
    throw new Error('This token did not delete the Gist. The link is still live.');
  }
  throw await shareHttpError(check, 'gist', { reading: true });
}

function expiryFromDays(expiryDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + expiryDays);
  return date.toISOString();
}

async function publishDpaste(text, { expiryDays } = {}) {
  if (text.length > DPASTE_MAX_CHARS) throw new Error(tooLargeMessage('dpaste'));
  const days = normalizeExpiryDays(expiryDays);
  const body = new URLSearchParams();
  body.set('content', text);
  body.set('syntax', 'text');
  body.set('expiry_days', String(days));
  const response = await request(DPASTE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) throw await shareHttpError(response, 'dpaste');
  const raw = (await response.text()).trim();
  const id = parseDpasteId(raw) || parseDpasteId(response.headers.get('Location'));
  if (!id) throw new Error('dpaste did not return a paste id.');
  return {
    id,
    expires_at: expiryFromDays(days),
  };
}

async function fetchDpaste(id) {
  const safeId = canonicalDpasteId(id);
  const response = await request(`https://dpaste.com/${safeId}.txt`);
  if (!response.ok) throw await shareHttpError(response, 'dpaste', { reading: true });
  return readBoundedText(response);
}

const PROVIDERS = {
  gist: {
    publish: publishGist,
    fetchText: fetchGist,
    remove: removeGist,
  },
  dpaste: {
    publish: publishDpaste,
    fetchText: fetchDpaste,
  },
};

export function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error('Unknown share provider.');
  return provider;
}

export function publishShare(provider, text, options) {
  return getProvider(provider).publish(text, options || {});
}

export function fetchShareText(provider, id) {
  return getProvider(provider).fetchText(id);
}

export async function removeShare(provider, id, options) {
  const impl = getProvider(provider);
  if (!impl.remove) throw new Error('This share cannot be deleted.');
  return impl.remove(id, options || {});
}
