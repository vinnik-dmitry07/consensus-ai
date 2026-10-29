const memory = new Map();

function memoryStorage() {
  return {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
    clear: () => memory.clear(),
    key: (index) => [...memory.keys()][index] ?? null,
    get length() {
      return memory.size;
    },
  };
}

export function installBrowserShims() {
  if (typeof globalThis.localStorage === 'undefined' || globalThis.localStorage === null) {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: memoryStorage(),
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
