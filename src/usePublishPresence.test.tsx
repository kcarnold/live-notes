import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { ClientPresence } from './presence';
import { PresencePublisher } from './usePublishPresence';

// The hook only needs the presence setter from the provider; stubbing it keeps
// this a test of *what we publish and when*, with no Y-Sweet connection involved.
const setPresence = vi.fn();
vi.mock('@y-sweet/react', () => ({
  usePresenceSetter: () => setPresence,
}));

/** The presence object from the Nth publish. */
function published(n: number): ClientPresence {
  return setPresence.mock.calls[n][0] as ClientPresence;
}

function navigateInPlace(url: string) {
  // What App.tsx's language selector does: rewrite the URL with no event and no
  // remount. This is the case a one-shot read at mount would miss.
  window.history.replaceState(null, '', url);
}

describe('PresencePublisher', () => {
  beforeEach(() => {
    setPresence.mockClear();
    window.history.replaceState(null, '', '/translatedText-French');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes the current page, role, and device on mount', () => {
    render(<PresencePublisher />);
    expect(setPresence).toHaveBeenCalledTimes(1);
    const presence = published(0);
    expect(presence.url).toBe('/translatedText-French');
    expect(presence.role).toBe('viewer');
    expect(presence.device.kind).toBeDefined();
    expect(presence.connectedSince).toBeGreaterThan(0);
  });

  it('re-publishes after an in-place URL change', () => {
    render(<PresencePublisher />);
    act(() => {
      navigateInPlace('/translatedText-Spanish');
      vi.advanceTimersByTime(2500);
    });
    expect(setPresence.mock.calls.length).toBeGreaterThan(1);
    expect(published(setPresence.mock.calls.length - 1).url).toBe('/translatedText-Spanish');
  });

  it('keeps connectedSince fixed across re-publishes', () => {
    // A ticking field would re-broadcast to every peer on every change; the age is
    // the viewer's job to compute. See presence.ts.
    render(<PresencePublisher />);
    const first = published(0).connectedSince;
    act(() => {
      navigateInPlace('/sourceText');
      vi.advanceTimersByTime(2500);
    });
    expect(published(setPresence.mock.calls.length - 1).connectedSince).toBe(first);
  });

  it('does not re-publish while the URL is unchanged', () => {
    render(<PresencePublisher />);
    setPresence.mockClear();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(setPresence).not.toHaveBeenCalled();
  });

  it('picks up hash changes', () => {
    render(<PresencePublisher />);
    act(() => {
      navigateInPlace('/sourceText#editor');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(published(setPresence.mock.calls.length - 1).url).toBe('/sourceText#editor');
  });
});
