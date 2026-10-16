import 'fake-indexeddb/auto';
import { beforeEach, vi } from 'vitest';

import { clearModelsCache, resetFreeQueueForTests } from '../engine/browser/openrouter.js';
import { clearBlockedIds, clearModelCooldownsForTests } from '../engine/browser/roster.js';
import { resetSettingsState } from '../engine/browser/settings.js';
import { resetStorageForTests } from '../engine/browser/storage.js';

const memory = new Map();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
    clear: () => memory.clear(),
  },
});

beforeEach(async () => {
  memory.clear();
  resetSettingsState();
  clearBlockedIds();
  clearModelCooldownsForTests();
  resetFreeQueueForTests();
  clearModelsCache();
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Unmocked fetch is disabled in offline tests');
  }));
  await resetStorageForTests();
});
