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
