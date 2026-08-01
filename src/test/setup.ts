import '@testing-library/jest-dom';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock Audio globally for tests
global.Audio = vi.fn().mockImplementation(() => ({
  play: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  load: vi.fn(),
}));

// jsdom doesn't implement Element.scrollTo. Components using scroll-to-bottom
// hooks (useStickToBottom) fire a throttled scrollTo on a real element during
// tests; without this stub that throws asynchronously and fails the run.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = vi.fn();
}

// jsdom exposes `window.localStorage` as an accessor that returns undefined, so the
// `in globalThis` guard style used elsewhere in this file doesn't detect it — the
// property exists, its value doesn't. Anything reading storage (the write key, and
// `atomWithStorage` behind fontSizeAtom) therefore sees nothing at all under test.
// Override it outright with a Map-backed stand-in.
{
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      // `?? null` would turn a stored empty string into a miss; Storage keeps it.
      getItem: (key: string) => {
        const value = store.get(key);
        return value === undefined ? null : value;
      },
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

// jsdom doesn't implement ResizeObserver. The text auto-fit hook (useFitText)
// observes its container; without this stub construction throws. jsdom also has
// no layout, so clientHeight/clientWidth are 0 and the hook skips the fit — the
// stub just needs to exist.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
