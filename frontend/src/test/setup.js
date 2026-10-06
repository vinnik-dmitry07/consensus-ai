import 'fake-indexeddb/auto';
import { beforeEach, vi } from 'vitest';

import { clearModelsCache } from '../engine/browser/openrouter.js';
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
  clearModelsCache();
  vi.restoreAllMocks();
  await resetStorageForTests();
});
