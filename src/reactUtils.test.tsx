import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useStickToBottom } from './reactUtils';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A fake scroll-parent element that tracks scrollTo calls, reports a fixed
 * rect/size, and supports addEventListener/removeEventListener so the hook's
 * scroll/wheel/touchmove listeners can be driven via `fire()`. Returns the
 * scrollTo mock separately so assertions target a plain mock (not an
 * HTMLElement method, which trips @typescript-eslint/unbound-method).
 */
function makeParent({
  bottom = 100,
  scrollTop = 50,
  scrollHeight = 950,
  clientHeight = 900,
} = {}) {
  const scrollTo = vi.fn();
  const listeners: Record<string, (() => void)[]> = {};
  const el = {
    scrollTop,
    scrollHeight,
    clientHeight,
    scrollTo,
    getBoundingClientRect: () => ({ bottom }) as DOMRect,
    addEventListener: (type: string, cb: () => void) => {
      (listeners[type] ??= []).push(cb);
    },
    removeEventListener: (type: string, cb: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== cb);
    },
  } as unknown as HTMLElement;
  const fire = (type: string) => listeners[type]?.forEach((cb) => cb());
  return { el, scrollTo, fire };
}

/** A fake target element that reports a fixed rect. */
function makeTarget(bottom = 200) {
  return {
    getBoundingClientRect: () => ({ bottom }) as DOMRect,
  } as unknown as HTMLElement;
}

describe('useStickToBottom', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scrolls the parent so the target sits at the bottom after the debounce', () => {
    const { el, scrollTo } = makeParent({ bottom: 100, scrollTop: 50 });
    const parentRef = { current: el };
    const targetRef = { current: makeTarget(200) };

    renderHook(({ deps }) => useStickToBottom(parentRef, targetRef, deps), {
      initialProps: { deps: [0] as unknown[] },
    });
    scrollTo.mockClear(); // discard the one-time initial mount scroll

    // Debounced: nothing fires immediately.
    expect(scrollTo).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(100);
    });

    // scrollTop (50) + (targetBottom 200 - parentBottom 100) = 150
    expect(scrollTo).toHaveBeenCalledWith({ top: 150, behavior: 'smooth' });
  });

  // Regression: a late joiner mounts with a full transcript already present, so
  // the container starts scrolled to the top (far from the bottom). The initial
  // mount must jump to the latest content immediately — instantly ('auto', not a
  // long smooth glide) and without waiting for any dependency change — otherwise
  // the growth effect never fires for them (it bails while not near bottom).
  it('jumps to the bottom on mount for a late joiner starting at the top', () => {
    const { el, scrollTo } = makeParent({
      bottom: 100,
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 900,
    });
    const parentRef = { current: el };
    const targetRef = { current: makeTarget(200) };

    const { result } = renderHook(() =>
      useStickToBottom(parentRef, targetRef, [0]),
    );

    // Fires synchronously on mount (layout effect), before any timer advance,
    // with instant behavior. scrollTop (0) + (targetBottom 200 - parentBottom 100) = 100.
    expect(scrollTo).toHaveBeenCalledWith({ top: 100, behavior: 'auto' });
    expect(result.current.pinned).toBe(true);
  });

  it('does not auto-scroll once the reader has scrolled away from the bottom', () => {
    const { el, scrollTo, fire } = makeParent({
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 900,
    });
    const parentRef = { current: el };
    const targetRef = { current: makeTarget() };

    const { result, rerender } = renderHook(
      ({ deps }) => useStickToBottom(parentRef, targetRef, deps),
      { initialProps: { deps: [0] as unknown[] } },
    );
    scrollTo.mockClear(); // discard the one-time initial mount scroll

    // Reader scrolls up: 1000 - 0 - 900 = 100px from bottom (past the 80px threshold).
    act(() => fire('scroll'));
    expect(result.current.pinned).toBe(false);

    rerender({ deps: [1] });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('holds off auto-scrolling while the reader is mid-gesture (wheel/touch)', () => {
    const { el, scrollTo, fire } = makeParent();
    const parentRef = { current: el };
    const targetRef = { current: makeTarget() };

    const { rerender } = renderHook(
      ({ deps }) => useStickToBottom(parentRef, targetRef, deps),
      { initialProps: { deps: [0] as unknown[] } },
    );
    scrollTo.mockClear(); // discard the one-time initial mount scroll

    act(() => fire('wheel'));
    rerender({ deps: [1] });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    // Still within the post-gesture holdoff window: no scroll yet.
    expect(scrollTo).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ deps: [2] });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    // Holdoff has elapsed and the reader never left the bottom, so it resumes.
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('scrollToEnd jumps immediately and re-pins', () => {
    const { el, scrollTo, fire } = makeParent({
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 900,
    });
    const parentRef = { current: el };
    const targetRef = { current: makeTarget() };

    const { result } = renderHook(() => useStickToBottom(parentRef, targetRef, [0]));
    scrollTo.mockClear(); // discard the one-time initial mount scroll

    act(() => fire('scroll'));
    expect(result.current.pinned).toBe(false);

    act(() => result.current.scrollToEnd());

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(result.current.pinned).toBe(true);
  });

  it('coalesces rapid dependency changes into a single scroll', () => {
    const { el, scrollTo } = makeParent();
    const parentRef = { current: el };
    const targetRef = { current: makeTarget() };

    const { rerender } = renderHook(
      ({ deps }) => useStickToBottom(parentRef, targetRef, deps),
      { initialProps: { deps: [0] as unknown[] } },
    );
    scrollTo.mockClear(); // discard the one-time initial mount scroll

    // Several dependency changes land inside the 100ms debounce window.
    rerender({ deps: [1] });
    rerender({ deps: [2] });
    rerender({ deps: [3] });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  // Regression: a continuous stream whose deps change faster than the throttle
  // window must still scroll. A reset-on-every-change debounce would push the
  // timer out forever and never fire while the stream is live.
  it('keeps scrolling during a fast delta stream (does not starve)', () => {
    const { el, scrollTo } = makeParent();
    const parentRef = { current: el };
    const targetRef = { current: makeTarget() };

    const { rerender } = renderHook(
      ({ deps }) => useStickToBottom(parentRef, targetRef, deps),
      { initialProps: { deps: [0] as unknown[] } },
    );
    scrollTo.mockClear(); // discard the one-time initial mount scroll

    // Deltas arrive every 40ms (< the 100ms window) for ~400ms.
    for (let i = 1; i <= 10; i++) {
      rerender({ deps: [i] });
      act(() => {
        vi.advanceTimersByTime(40);
      });
    }

    // A throttle fires roughly once per window; a reset-debounce would be 0.
    expect(scrollTo.mock.calls.length).toBeGreaterThan(1);
  });

  it('does nothing (and does not throw) when refs are missing', () => {
    const parentRef = { current: null as HTMLElement | null };
    const targetRef = { current: null as HTMLElement | null };

    renderHook(({ deps }) => useStickToBottom(parentRef, targetRef, deps), {
      initialProps: { deps: [0] as unknown[] },
    });

    expect(() =>
      act(() => {
        vi.advanceTimersByTime(100);
      }),
    ).not.toThrow();
  });

  // Regression: if the pending timeout fires while a ref is transiently null, the
  // callback must not leave the internal timeout handle stuck non-null — otherwise
  // every subsequent scroll is permanently blocked for the component's lifetime.
  it('recovers after a timeout fires with a missing ref (does not wedge)', () => {
    const { el, scrollTo } = makeParent();
    const parentRef = { current: el };
    const targetRef = { current: makeTarget() as HTMLElement | null };

    const { rerender } = renderHook(
      ({ deps }) => useStickToBottom(parentRef, targetRef, deps),
      { initialProps: { deps: [0] as unknown[] } },
    );
    scrollTo.mockClear(); // discard the one-time initial mount scroll

    // Target detaches right before the scheduled timeout fires.
    targetRef.current = null;
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(scrollTo).not.toHaveBeenCalled();

    // Target reattaches and new content arrives.
    targetRef.current = makeTarget();
    rerender({ deps: [1] });
    act(() => {
      vi.advanceTimersByTime(100);
    });

    // Auto-scroll must resume, not stay wedged.
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  // Coverage for the real DOM path: the other tests hand the hook a fake `el`
  // with a mock scrollTo, so they can't catch that jsdom lacks Element.scrollTo.
  // This drives the hook against an actual node, so the genuine scroll path
  // (getBoundingClientRect, scrollHeight, scrollTo) runs on every test run —
  // it fails outright if the test-setup scrollTo stub ever goes missing.
  it('scrolls a real DOM element (covers the real scrollTo path)', () => {
    const parent = document.createElement('div');
    const target = document.createElement('div');
    parent.appendChild(target);
    document.body.appendChild(parent);
    const scrollTo = vi.spyOn(parent, 'scrollTo');

    renderHook(
      ({ deps }) =>
        useStickToBottom({ current: parent }, { current: target }, deps),
      { initialProps: { deps: [0] as unknown[] } },
    );
    scrollTo.mockClear(); // discard the one-time initial mount scroll

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(scrollTo).toHaveBeenCalledTimes(1);
    document.body.removeChild(parent);
  });
});
