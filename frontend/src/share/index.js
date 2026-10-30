/**
 * Publish and open a conversation without sending the plaintext anywhere.
 */

import { decryptPayload, encryptPayload, exportKey, generateKey, parseEnvelope } from './crypto.js';
import { formatShareLink, shareBase } from './link.js';
import { fetchShareText, publishShare, removeShare } from './providers.js';
import { buildShareSnapshot, snapshotToConversation } from './snapshot.js';
import { forgetShareLink, getGithubToken, rememberShareLink } from './settings.js';

export { isLocalShareBase, parseShareLocation, sameShareRef } from './link.js';

export async function shareConversation(conversation, options = {}) {
  const provider = options.provider;
  const snapshot = buildShareSnapshot(conversation, {
    includeAttachments: options.includeAttachments !== false,
  });
  const key = await generateKey();
  const envelope = await encryptPayload(snapshot, key);
  const published = await publishShare(provider, JSON.stringify(envelope), {
    token: getGithubToken(),
    expiryDays: options.expiryDays,
  });
  const location = options.location || window.location;
  const link = formatShareLink(
    shareBase(location),
    provider,
    published.id,
    await exportKey(key),
  );
  const record = {
    provider,
    id: published.id,
    link,
    conversation_id: conversation.id || null,
    created_at: new Date().toISOString(),
    expires_at: published.expires_at,
  };
  try {
    return rememberShareLink(record);
  } catch {
    return { ...record, remembered: false };
  }
}

export async function openShare(ref) {
  if (!ref || ref.error) {
    throw new Error(ref?.error || 'This share link is not valid.');
  }
  const text = await fetchShareText(ref.provider, ref.id);
  const snapshot = await decryptPayload(parseEnvelope(text), ref.key);
  return snapshotToConversation(snapshot);
}

export async function deleteShare(provider, id) {
  await removeShare(provider, id, { token: getGithubToken() });
  forgetShareLink(provider, id);
}
