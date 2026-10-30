import { describe, expect, it } from 'vitest';

import {
  decryptPayload,
  encryptPayload,
  exportKey,
  generateKey,
  bytesToBase64Url,
  base64UrlToBytes,
  MAX_SHARE_BYTES,
  SHARE_FORMAT,
  SHARE_VERSION,
} from './crypto.js';

describe('base64url', () => {
  it('round-trips a buffer larger than one encoding chunk', () => {
    const bytes = new Uint8Array(40000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
  });
});

describe('share crypto', () => {
  it('decrypts a payload with the key that encrypted it', async () => {
    const key = await generateKey();
    const original = { version: 1, conversation: { title: 'Private title', messages: [] } };
    const envelope = await encryptPayload(original, key);
    const restored = await decryptPayload(envelope, await exportKey(key));
    expect(restored).toEqual(original);
    expect(JSON.stringify(envelope)).not.toContain('Private title');
  });

  it('rejects a different key and a damaged iv', async () => {
    const key = await generateKey();
    const envelope = await encryptPayload({ ok: true }, key);
    const other = await generateKey();
    await expect(decryptPayload(envelope, other)).rejects.toThrow(/key/i);

    const iv = base64UrlToBytes(envelope.iv);
    iv[0] ^= 0xff;
    const damaged = { ...envelope, iv: bytesToBase64Url(iv) };
    await expect(decryptPayload(damaged, key)).rejects.toThrow(/key/i);
  });

  it('rejects an unknown share version before using the key', async () => {
    const key = await generateKey();
    const envelope = await encryptPayload({ ok: true }, key);
    await expect(decryptPayload({ ...envelope, version: 99 }, key)).rejects.toThrow(
      /Unsupported share version: 99/,
    );
  });

  it('stops a payload that decompresses past the limit', async () => {
    const key = await generateKey();
    const plain = new TextEncoder().encode('x'.repeat(MAX_SHARE_BYTES + 1));
    const compressed = new Uint8Array(await new Response(
      new Blob([plain]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer());
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed);
    const envelope = {
      format: SHARE_FORMAT,
      version: SHARE_VERSION,
      alg: 'AES-GCM',
      iv: bytesToBase64Url(iv),
      data: bytesToBase64Url(new Uint8Array(cipher)),
    };
    await expect(decryptPayload(envelope, key)).rejects.toThrow(/too large to open/i);
  });
});

describe('share encoding', () => {
  it('rejects a truncated base64url key instead of a raw decoder error', () => {
    expect(() => base64UrlToBytes('a')).toThrow(/Invalid share encoding/);
  });
});
