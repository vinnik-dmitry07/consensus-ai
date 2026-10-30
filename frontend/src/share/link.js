/**
 * The encryption key lives only in the URL fragment, which hosts do not receive.
 */

import { canonicalShareId } from './providers.js';

const SHARE_REF = /^(gist|dpaste):([A-Za-z0-9]+)$/;

function fragmentKey(location) {
  const hash = String(location.hash || '').replace(/^#/, '');
  if (!hash) return '';
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

export function shareBase(location) {
  return `${location.origin}${location.pathname}`;
}

export function formatShareLink(base, provider, id, key) {
  const safeId = canonicalShareId(provider, id);
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error('Invalid share key.');
  }
  // Keep the colon readable. searchParams.set would encode it as %3A.
  return `${shareBase(new URL(base))}?share=${provider}:${safeId}#${key}`;
}

export function parseShareLocation(location) {
  const params = new URLSearchParams(location.search || '');
  if (!params.has('share')) return null;
  const match = SHARE_REF.exec(params.get('share') || '');
  if (!match) return { error: 'This share link is not valid.' };
  const provider = match[1];
  let id = match[2];
  try {
    id = canonicalShareId(provider, id);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'This share link is not valid.' };
  }
  const key = fragmentKey(location);
  if (!key) {
    return { provider, id, key: '', error: 'This share link is missing its key.' };
  }
  return { provider, id, key };
}

export function isLocalShareBase(location) {
  const host = location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function sameShareRef(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.error || right.error) {
    return left.error === right.error
      && left.provider === right.provider
      && left.id === right.id;
  }
  return left.provider === right.provider && left.id === right.id && left.key === right.key;
}
