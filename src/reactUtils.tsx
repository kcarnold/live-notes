import React from 'react';

// Reader is considered "pinned" to the bottom (and thus eligible for
// auto-scroll) when within this many px of it.
const NEAR_BOTTOM_PX = 80;
// How long after a wheel/touch gesture we still treat the reader as
// "actively scrolling" and hold off auto-scrolling, so our own scroll
// doesn't fight their gesture mid-motion.
const USER_SCROLL_HOLDOFF_MS = 150;

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

  const updatePinned = React.useCallback(() => {
    const el = scrollParentRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  React.useEffect(() => {
    if (!pinned || userScrollingRef.current) return;
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => {
      scrollTimeoutRef.current = null;
      if (pinned && !userScrollingRef.current) scrollToEnd('smooth');
    }, 100);
    return () => {
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { pinned, scrollToEnd };
}
