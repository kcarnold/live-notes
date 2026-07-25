import { useLayoutEffect, useRef, useState, type DependencyList } from 'react';

export interface UseFitTextOptions {
  /** Smallest font size (px) to shrink to. Content may clip below this. */
  min?: number;
  /** Largest font size (px) to grow to. */
  max?: number;
  /** Binary-search steps. 10 gives sub-pixel precision over the default range. */
  steps?: number;
}

/**
 * Binary-search the largest font size in `[min, max]` at which the measured
 * content still fits `availW × availH`. Pure: `measure(px)` reports the
 * content's natural `{ width, height }` at that font size, so this is unit
 * testable without a real layout engine.
 */
export function fitFontSize(
  availW: number,
  availH: number,
  measure: (px: number) => { width: number; height: number },
  { min = 14, max = 160, steps = 10 }: UseFitTextOptions = {},
): number {
  const fits = (px: number) => {
    const { width, height } = measure(px);
    return height <= availH && width <= availW;
  };

  // Short-circuit the common case (short slide): if the biggest size already
  // fits, use it — and the binary search never tests `max` exactly.
  if (fits(max)) return max;

  let lo = min;
  let hi = max;
  let best = min;
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

/**
 * Auto-fit a block of text to the height (and width) of its container by
 * binary-searching the font size.
 *
 * Two refs on purpose:
 * - `containerRef` is the box the text must fit into. Its `clientHeight` is the
 *   available space, and it carries the resolved `fontSize` so `em`/inherited
 *   child sizes scale with it. It must have a bounded height (e.g. `flex-1
 *   min-h-0`) and `overflow-hidden`.
 * - `textRef` wraps the actual content. We measure *its* `scrollHeight`, which
 *   is the content's natural height independent of how the container centers
 *   it — so `justify-center` on the container doesn't confuse the measurement
 *   the way reading the container's own `scrollHeight` would.
 *
 * Re-fits when `deps` change (new slide text) and when the container resizes.
 *
 * @param deps content identity — re-run the fit when this changes.
 */
export function useFitText<
  C extends HTMLElement = HTMLDivElement,
  T extends HTMLElement = HTMLDivElement,
>(deps: DependencyList, { min = 14, max = 160, steps = 10 }: UseFitTextOptions = {}) {
  const containerRef = useRef<C | null>(null);
  const textRef = useRef<T | null>(null);
  const [fontSize, setFontSize] = useState(max);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;

    const fit = () => {
      const availH = container.clientHeight;
      const availW = container.clientWidth;
      // Not laid out yet (or a non-layout test environment like jsdom, where
      // these are 0). Leave the font size alone rather than collapsing to min.
      if (availH === 0 || availW === 0) return;

      const best = fitFontSize(
        availW,
        availH,
        (px) => {
          // Apply to the container so `em`/inherited child sizes scale, then
          // read the content's natural size.
          container.style.fontSize = `${px}px`;
          return { width: text.scrollWidth, height: text.scrollHeight };
        },
        { min, max, steps },
      );
      container.style.fontSize = `${best}px`;
      setFontSize(best);
    };

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(container);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { containerRef, textRef, fontSize };
}
