import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useScrollToBottom } from './reactUtils';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A fake scroll-parent element that tracks scrollTo calls and reports a fixed
 * rect. Returns the mock separately so assertions target a plain mock (not an
 * HTMLElement method, which trips @typescript-eslint/unbound-method).
 */
function makeParent(bottom = 100, scrollTop = 50) {
  const scrollTo = vi.fn();
  const el = {
    scrollTop,
    scrollTo,
    getBoundingClientRect: () => ({ bottom }) as DOMRect,
  } as unknown as HTMLElement;
  return { el, scrollTo };
}

/** A fake target element that reports a fixed rect. */
function makeTarget(bottom = 200) {
  return {
    getBoundingClientRect: () => ({ bottom }) as DOMRect,
  } as unknown as HTMLElement;
}

describe('useScrollToBottom', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scrolls the parent so the target sits at the bottom after the debounce', () => {
    const { el, scrollTo } = makeParent(100, 50);
    const parentRef = { current: el };
    const targetRef = { current: makeTarget(200) };

    renderHook(({ deps }) => useScrollToBottom(parentRef, targetRef, deps, true), {
      initialProps: { deps: [0] as unknown[] },
    });

    // Debounced: nothing fires immediately.
    expect(scrollTo).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(100);
    });

    // scrollTop (50) + (targetBottom 200 - parentBottom 100) = 150
    expect(scrollTo).toHaveBeenCalledWith({ top: 150, behavior: 'smooth' });
  });

  it('does not scroll when disabled', () => {
    const { el, scrollTo } = makeParent();
    const parentRef = { current: el };
    const targetRef = { current: makeTarget() };

    renderHook(({ deps }) => useScrollToBottom(parentRef, targetRef, deps, false), {
      initialProps: { deps: [0] as unknown[] },
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('coalesces rapid dependency changes into a single scroll', () => {
    const { el, scrollTo } = makeParent();
    const parentRef = { current: el };
    const targetRef = { current: makeTarget() };

    const { rerender } = renderHook(
      ({ deps }) => useScrollToBottom(parentRef, targetRef, deps, true),
      { initialProps: { deps: [0] as unknown[] } },
    );

    // Several dependency changes land inside the 100ms debounce window.
    rerender({ deps: [1] });
    rerender({ deps: [2] });
    rerender({ deps: [3] });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('does nothing (and does not throw) when refs are missing', () => {
    const parentRef = { current: null as HTMLElement | null };
    const targetRef = { current: null as HTMLElement | null };

    renderHook(({ deps }) => useScrollToBottom(parentRef, targetRef, deps, true), {
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
      ({ deps }) => useScrollToBottom(parentRef, targetRef, deps, true),
      { initialProps: { deps: [0] as unknown[] } },
    );

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
});
