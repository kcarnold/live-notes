import React from 'react';

// Reader is considered "pinned" to the bottom (and thus eligible for
// auto-scroll) when within this many px of it.
const NEAR_BOTTOM_PX = 80;
// How long after a wheel/touch gesture we still treat the reader as
// "actively scrolling" and hold off auto-scrolling, so our own scroll
// doesn't fight their gesture mid-motion.
const USER_SCROLL_HOLDOFF_MS = 150;
// Auto-scroll fires at most once per this window. This is a throttle, not a
// reset-on-every-change debounce: a fast delta stream (deps changing faster
// than we scroll) must not perpetually push the timer out and starve the
// scroll — it should keep the bottom in view instead.
const AUTO_SCROLL_THROTTLE_MS = 100;

/**
 * Keeps a scroll container stuck to a bottom sentinel element as content is
 * appended (new transcript segments, new translated blocks, etc.) — but only
 * while the reader hasn't scrolled away to read something earlier. Returns
 * `pinned` so callers can show a "jump to latest" affordance when it's false,
 * and `scrollToEnd` to jump back down (e.g. from that affordance's onClick).
 */
export function useStickToBottom(
  scrollParentRef: React.RefObject<HTMLElement | null>,
  targetRef: React.RefObject<HTMLElement | null>,
  deps: React.DependencyList
) {
  const [pinned, setPinned] = React.useState(true);
  const userScrollingRef = React.useRef(false);
  const holdoffTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const scrollTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  // Ground truth for "is the reader at the bottom", read live from the DOM.
  // `pinned` is just this measurement surfaced as state (for the pill); the
  // scheduled auto-scroll re-reads this at fire time rather than trusting a
  // value captured when it was queued, so a reader who has since scrolled away
  // (by any means — wheel, touch, keyboard, scrollbar) isn't yanked back down.
  const isNearBottom = React.useCallback(() => {
    const el = scrollParentRef.current;
    return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updatePinned = React.useCallback(() => {
    setPinned(isNearBottom());
  }, [isNearBottom]);

  const markUserScrolling = React.useCallback(() => {
    userScrollingRef.current = true;
    if (holdoffTimeoutRef.current) clearTimeout(holdoffTimeoutRef.current);
    holdoffTimeoutRef.current = setTimeout(() => {
      userScrollingRef.current = false;
    }, USER_SCROLL_HOLDOFF_MS);
  }, []);

  React.useEffect(() => {
    const el = scrollParentRef.current;
    if (!el) return;
    // 'scroll' also fires for our own programmatic scrollToEnd(), so it only
    // updates `pinned`. Only wheel/touch input marks the reader as actively
    // scrolling, since those are unambiguously user-initiated.
    el.addEventListener('scroll', updatePinned, { passive: true });
    el.addEventListener('wheel', markUserScrolling, { passive: true });
    el.addEventListener('touchmove', markUserScrolling, { passive: true });
    return () => {
      el.removeEventListener('scroll', updatePinned);
      el.removeEventListener('wheel', markUserScrolling);
      el.removeEventListener('touchmove', markUserScrolling);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatePinned, markUserScrolling]);

  const scrollToEnd = React.useCallback((behavior: ScrollBehavior = 'smooth') => {
    const scrollParent = scrollParentRef.current;
    const target = targetRef.current;
    if (!scrollParent || !target) return;

    // Scroll so the target is at the bottom of the scroll parent
    const targetRect = target.getBoundingClientRect();
    const parentRect = scrollParent.getBoundingClientRect();
    const scrollTop = scrollParent.scrollTop + (targetRect.bottom - parentRect.bottom);

    scrollParent.scrollTo({ top: scrollTop, behavior });
    setPinned(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On first mount, jump straight to the bottom so a late joiner who already
  // has a full transcript starts at the latest content. Without this, the
  // growth effect below never fires for them: it bails while `isNearBottom()`
  // is false, and an already-scrolled-to-top container reads as "not near
  // bottom" from the very first render, so nothing scrolls until the reader
  // manually scrolls down. Instant ('auto') so there's no long smooth glide
  // from the top; no-op when there's no content yet (targetRef is unmounted).
  React.useLayoutEffect(() => {
    scrollToEnd('auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When tracked content grows, re-stick to the bottom. Throttled (schedule
  // only when nothing is already queued) so a burst of dependency changes
  // coalesces into a single scroll instead of resetting the timer forever.
  React.useEffect(() => {
    if (scrollTimeoutRef.current || userScrollingRef.current || !isNearBottom()) return;
    scrollTimeoutRef.current = setTimeout(() => {
      scrollTimeoutRef.current = null;
      if (!userScrollingRef.current && isNearBottom()) scrollToEnd('smooth');
    }, AUTO_SCROLL_THROTTLE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  React.useEffect(
    () => () => {
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      if (holdoffTimeoutRef.current) clearTimeout(holdoffTimeoutRef.current);
    },
    []
  );

  return { pinned, scrollToEnd };
}
