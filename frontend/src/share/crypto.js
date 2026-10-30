/**
 * Share envelopes are compressed, then encrypted in the browser.
 * The key never goes to the host that stores the ciphertext.
 */

export const SHARE_FORMAT = 'consensus-ai-share';
export const SHARE_VERSION = 1;
export const MAX_SHARE_BYTES = 20 * 1024 * 1024;

const TEXT = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function bytesToBase64Url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const parts = [];
  const size = 0x8000;
  for (let index = 0; index < view.length; index += size) {
    parts.push(String.fromCharCode.apply(null, view.subarray(index, index + size)));
  }
  return btoa(parts.join('')).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64UrlToBytes(text) {
  if (typeof text !== 'string' || !text || /[^A-Za-z0-9_-]/.test(text)) {
    throw new Error('Invalid share encoding.');
  }
  const padded = text.replaceAll('-', '+').replaceAll('_', '/')
    + '='.repeat((4 - (text.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('Invalid share encoding.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function generateKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function exportKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bytesToBase64Url(new Uint8Array(raw));
}

export async function importKey(encoded) {
  const raw = base64UrlToBytes(encoded);
  if (raw.byteLength !== 32) throw new Error('Invalid share key.');
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
}

async function readLimited(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error('This share is too large to open.');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // cancel() already released the reader.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function throughStream(bytes, Stream, limit = MAX_SHARE_BYTES) {
  const stream = new Blob([bytes]).stream().pipeThrough(new Stream('deflate-raw'));
  return readLimited(stream, limit);
}

export async function encryptPayload(value, key) {
  const plain = TEXT.encode(JSON.stringify(value));
  if (plain.byteLength > MAX_SHARE_BYTES) {
    throw new Error('This conversation is too large to share. Try again without attachments.');
  }
  const compressed = await throughStream(plain, CompressionStream, plain.byteLength + 65536);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed);
  return {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    alg: 'AES-GCM',
    iv: bytesToBase64Url(iv),
    data: bytesToBase64Url(new Uint8Array(cipher)),
  };
}

export async function decryptPayload(envelope, keyMaterial) {
  if (!envelope || typeof envelope !== 'object' || envelope.format !== SHARE_FORMAT) {
    throw new Error('This is not a consensus.ai share.');
  }
  if (envelope.version !== SHARE_VERSION) {
    throw new Error(`Unsupported share version: ${envelope.version}.`);
  }
  if (envelope.alg !== 'AES-GCM') {
    throw new Error('Unsupported share encryption.');
  }
  const key = typeof keyMaterial === 'string' ? await importKey(keyMaterial) : keyMaterial;
  let compressed;
  try {
    compressed = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlToBytes(envelope.iv) },
      key,
      base64UrlToBytes(envelope.data),
    ));
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid share encoding.') throw error;
    throw new Error('Could not decrypt this share. The link key is missing or wrong.');
  }
  try {
    const plain = await throughStream(compressed, DecompressionStream);
    return JSON.parse(TEXT_DECODER.decode(plain));
  } catch (error) {
    if (error instanceof Error && error.message === 'This share is too large to open.') throw error;
    throw new Error('Could not read this share. The data is damaged.');
  }
}

export function parseEnvelope(text) {
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/, '').trim());
  } catch {
    throw new Error('The stored share is not valid JSON.');
  }
}
