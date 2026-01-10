import React from 'react';

export function useScrollToBottom(
  scrollParentRef: React.RefObject<HTMLElement | null>,
  targetRef: React.RefObject<HTMLElement | null>,
  deps: React.DependencyList,
  enabled: boolean
) {
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  React.useEffect(() => {
    if (timeoutRef.current || !enabledRef.current) {
      return;
    }
    const scrollParent = scrollParentRef.current;
    const target = targetRef.current;
    if (!scrollParent || !target) return;

    timeoutRef.current = setTimeout(() => {
      const scrollParent = scrollParentRef.current;
      const target = targetRef.current;
      if (!scrollParent || !target || !enabledRef.current) return;

      // Scroll so the target is at the bottom of the scroll parent
      const targetRect = target.getBoundingClientRect();
      const parentRect = scrollParent.getBoundingClientRect();
      const scrollTop = scrollParent.scrollTop + (targetRect.bottom - parentRect.bottom);

      scrollParent.scrollTo({
        top: scrollTop,
        behavior: 'smooth',
      });
      timeoutRef.current = null;
    }, 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
