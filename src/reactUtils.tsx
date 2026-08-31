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
// How close to a smooth scroll's target counts as having arrived.
const SCROLL_ARRIVAL_PX = 2;

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
  // `pinned` is the reader's *intent* — "keep me at the latest" — not a live
  // reading of where the container sits. Only a scroll the reader caused can
  // change it. Appending content moves the bottom away without any scroll, and
  // must not be mistaken for the reader walking back through the history: that
  // conflation is what used to both stop the auto-scroll and (since nothing
  // ever set `pinned` false) hide the jump-to-latest pill that should have
  // offered the way back.
  const [pinned, setPinned] = React.useState(true);
  const pinnedRef = React.useRef(true);
  const userScrollingRef = React.useRef(false);
  const holdoffTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const scrollTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  // Set while a smooth scroll we started is still gliding, so its intermediate
  // positions can be told apart from the reader's own scrolling.
  const glideRef = React.useRef<{ target: number; last: number } | null>(null);
  const didInitialScrollRef = React.useRef(false);

  const updatePinned = React.useCallback((next: boolean) => {
    pinnedRef.current = next;
    setPinned(next);
  }, []);

  // Where the container actually sits right now, read live from the DOM.
  const isNearBottom = React.useCallback(() => {
    const el = scrollParentRef.current;
    return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleScroll = React.useCallback(() => {
    const el = scrollParentRef.current;
    if (!el) return;

    const glide = glideRef.current;
    if (glide) {
      const distance = Math.abs(el.scrollTop - glide.target);
      const previousDistance = Math.abs(glide.last - glide.target);
      glide.last = el.scrollTop;
      // Still closing on the target: this is our own scroll mid-flight and says
      // nothing about where the reader wants to be, so don't unpin on it.
      // Arriving, or moving *away* from the target (the reader grabbed the
      // scrollbar mid-glide), ends the glide and hands control back.
      if (distance > SCROLL_ARRIVAL_PX && distance <= previousDistance) return;
      glideRef.current = null;
      if (distance <= SCROLL_ARRIVAL_PX) {
        // Landed exactly where we asked to be. Content that arrived mid-glide has
        // moved the bottom on without us, so this can finish short of it — but
        // that is our scroll to catch up on, not the reader walking away, and
        // reading position here would unpin them and stop the chase for good.
        updatePinned(true);
        return;
      }
    }

    updatePinned(isNearBottom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNearBottom, updatePinned]);

  const markUserScrolling = React.useCallback(() => {
    userScrollingRef.current = true;
    // An unambiguous gesture always wins over a scroll of ours still in flight.
    glideRef.current = null;
    if (holdoffTimeoutRef.current) clearTimeout(holdoffTimeoutRef.current);
    holdoffTimeoutRef.current = setTimeout(() => {
      userScrollingRef.current = false;
    }, USER_SCROLL_HOLDOFF_MS);
  }, []);

  // The scroll container can mount *after* this hook does: a caller showing an
  // empty state until its content syncs in (BilingualBlockViewer returns early,
  // rendering neither the container nor the sentinel) hands us a null ref on the
  // first render. Binding once on mount would therefore bind to nothing and,
  // since the handlers are stable, never re-run — leaving the reader unable to
  // unpin at all: no jump-to-latest pill, and no way to scroll away from a view
  // that keeps chasing the bottom. So re-check whenever tracked content changes,
  // and rebind if the element we're holding isn't the one on screen.
  const listeningToRef = React.useRef<HTMLElement | null>(null);

  const bindScrollListeners = React.useCallback(() => {
    const el = scrollParentRef.current;
    const previous = listeningToRef.current;
    if (el === previous) return;
    if (previous) {
      previous.removeEventListener('scroll', handleScroll);
      previous.removeEventListener('wheel', markUserScrolling);
      previous.removeEventListener('touchmove', markUserScrolling);
    }
    listeningToRef.current = el;
    if (!el) return;
    // 'scroll' also fires for our own scrollToEnd(), which handleScroll filters
    // out. Only wheel/touch input marks the reader as actively scrolling, since
    // those are unambiguously user-initiated.
    el.addEventListener('scroll', handleScroll, { passive: true });
    el.addEventListener('wheel', markUserScrolling, { passive: true });
    el.addEventListener('touchmove', markUserScrolling, { passive: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleScroll, markUserScrolling]);

  React.useEffect(bindScrollListeners, [bindScrollListeners, ...deps]);

  const scrollToEnd = React.useCallback((behavior: ScrollBehavior = 'smooth') => {
    const scrollParent = scrollParentRef.current;
    const target = targetRef.current;
    if (!scrollParent || !target) return;

    // Scroll so the target is at the bottom of the scroll parent
    const targetRect = target.getBoundingClientRect();
    const parentRect = scrollParent.getBoundingClientRect();
    const scrollTop = scrollParent.scrollTop + (targetRect.bottom - parentRect.bottom);

    // Only a smooth scroll needs tracking: it emits scroll events from every
    // intermediate position on the way down, and taking those at face value
    // would unpin the reader (flashing the pill) during our own glide. An
    // instant scroll lands in one step, at a position worth believing.
    glideRef.current =
      behavior === 'smooth' ? { target: scrollTop, last: scrollParent.scrollTop } : null;

    scrollParent.scrollTo({ top: scrollTop, behavior });
    updatePinned(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatePinned]);

  // Start at the latest content, once there is content to start at. A viewer
  // opening a session that already has a long transcript mounts *empty* — the
  // Yjs doc syncs a moment later — so a plain mount effect fires against an
  // empty container and does nothing, and by the time the history arrives it has
  // already been spent. Hence a latch rather than a one-shot, held until there is
  // actually something to scroll: that, rather than the sentinel merely existing,
  // is the condition we mean, and it keeps the latch unspent for content that
  // arrives too short to overflow the container.
  // Instant ('auto') so there's no long smooth glide down through the whole history.
  React.useLayoutEffect(() => {
    const el = scrollParentRef.current;
    if (didInitialScrollRef.current || !el || !targetRef.current) return;
    if (el.scrollHeight <= el.clientHeight) return; // nothing to scroll yet
    didInitialScrollRef.current = true;
    scrollToEnd('auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // When tracked content grows, re-stick to the bottom. Throttled (schedule
  // only when nothing is already queued) so a burst of dependency changes
  // coalesces into a single scroll instead of resetting the timer forever.
  // Gated on `pinned` re-read at fire time, not on a value captured when the
  // scroll was queued, so a reader who scrolled away in between isn't yanked
  // back down.
  React.useEffect(() => {
    if (scrollTimeoutRef.current || userScrollingRef.current || !pinnedRef.current) return;
    scrollTimeoutRef.current = setTimeout(() => {
      scrollTimeoutRef.current = null;
      if (!userScrollingRef.current && pinnedRef.current) scrollToEnd('smooth');
    }, AUTO_SCROLL_THROTTLE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  React.useEffect(
    () => () => {
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      if (holdoffTimeoutRef.current) clearTimeout(holdoffTimeoutRef.current);
      const el = listeningToRef.current;
      if (el) {
        el.removeEventListener('scroll', handleScroll);
        el.removeEventListener('wheel', markUserScrolling);
        el.removeEventListener('touchmove', markUserScrolling);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return { pinned, scrollToEnd };
}

// How long chrome stays visible after the last tap before fading out.
const CHROME_HIDE_DELAY_MS = 3000;

/**
 * Drives auto-hiding UI chrome (nav controls, status widgets) that's rarely
 * used but needs to stay discoverable: visible on load and after any tap
 * anywhere on the page, faded out after a few seconds of inactivity so it
 * stops sitting over content. `pointerdown` (not click) so it reveals on the
 * same gesture that scrolls or presses a button underneath, and the listener
 * never calls preventDefault/stopPropagation, so that gesture still reaches
 * whatever it was aimed at — this only ever adds a reveal, never blocks one.
 */
export function useAutoHideChrome(delayMs: number = CHROME_HIDE_DELAY_MS) {
  const [visible, setVisible] = React.useState(true);

  React.useEffect(() => {
    let hideTimeout: ReturnType<typeof setTimeout>;
    const reveal = () => {
      setVisible(true);
      clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => setVisible(false), delayMs);
    };
    reveal();
    window.addEventListener('pointerdown', reveal, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', reveal);
      clearTimeout(hideTimeout);
    };
  }, [delayMs]);

  return visible;
}
