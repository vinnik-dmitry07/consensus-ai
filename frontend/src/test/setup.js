import 'fake-indexeddb/auto';
import { beforeEach, vi } from 'vitest';

import { clearModelsCache, resetFreeQueueForTests, setQueryHook } from '../engine/browser/openrouter.js';
import { clearBlockedIds, clearModelCooldowns } from '../engine/browser/roster.js';
import { resetSettingsState } from '../engine/browser/settings.js';
import { resetShareSettingsForTests } from '../share/settings.js';
import { resetStorageForTests } from '../engine/browser/storage.js';
import { createOverlayStorage } from '../../eval/questionScope.js';

const overlay = createOverlayStorage();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: overlay.storage,
});

beforeEach(async () => {
  overlay.clearGlobal();
  resetSettingsState();
  resetShareSettingsForTests();
  clearBlockedIds();
  clearModelCooldowns();
  resetFreeQueueForTests();
  clearModelsCache();
  setQueryHook(null);
  vi.restoreAllMocks();
  await resetStorageForTests();
});
