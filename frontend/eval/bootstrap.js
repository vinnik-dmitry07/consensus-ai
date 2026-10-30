import { createOverlayStorage } from './questionScope.js';

export function installBrowserShims() {
  if (typeof globalThis.localStorage === 'undefined' || globalThis.localStorage === null) {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: createOverlayStorage().storage,
    });
  }
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
    };
  }
}
