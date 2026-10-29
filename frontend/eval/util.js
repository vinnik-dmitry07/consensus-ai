import { createHash } from 'node:crypto';

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromText(text) {
  return Number.parseInt(sha256(text).slice(0, 8), 16);
}

export function hashOrder(seed, ...parts) {
  return sha256([seed, ...parts].join('\n'));
}

export function compareHash(seed, left, right) {
  const a = hashOrder(seed, left);
  const b = hashOrder(seed, right);
  if (a < b) return -1;
  if (a > b) return 1;
  return String(left).localeCompare(String(right));
}
