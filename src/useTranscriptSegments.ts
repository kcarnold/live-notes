// Reading side of the live transcript store: subscribe to one language's
// `liveTranscriptSegments-{code}` Y.Array and hand components plain segment objects.
// Shared by LiveTranscript (the reader-facing view) and TranscriptHealth (the
// operator one) so both see the same shape; the Yjs contract itself lives in
// transcriptKeys.ts, alongside the writer's half of it.
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { useYDoc } from '@y-sweet/react';
import type * as Y from 'yjs';
import {
  LIVE_TRANSCRIPT_PREFIX,
  readTranscriptSegments,
  segmentsFromArray,
  transcriptSegmentsKey,
  type TranscriptSegment,
} from './transcriptKeys';

/**
 * One language's transcript segments, live. Deltas land inside a segment's nested
 * Y.Text, so this observes deeply rather than just watching the array's length.
 *
 * useSyncExternalStore demands a referentially stable snapshot — returning a freshly
 * mapped array on every read would loop forever — so the projection is memoized and
 * invalidated only when Yjs reports a change. The cache is keyed by the Y.Array it was
 * built from, so switching `code` can't serve the previous language's segments.
 */
export function useTranscriptSegments(code: string): TranscriptSegment[] {
  const doc = useYDoc();
  const yArray = useMemo(
    () => doc.getArray<Y.Map<unknown>>(transcriptSegmentsKey(code)),
    [doc, code],
  );
  // Legacy sessions have no segments array, only the flat Y.Text. It's append-only
  // and no longer written, but observe it too so a viewer opening an old doc renders
  // once it syncs rather than sitting on the empty first read.
  const legacyText = useMemo(() => doc.getText(`${LIVE_TRANSCRIPT_PREFIX}${code}`), [doc, code]);

  const cache = useRef<{ source: Y.Array<Y.Map<unknown>>; value: TranscriptSegment[] } | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const handler = () => {
        cache.current = null;
        onStoreChange();
      };
      yArray.observeDeep(handler);
      legacyText.observe(handler);
      return () => {
        yArray.unobserveDeep(handler);
        legacyText.unobserve(handler);
      };
    },
    [yArray, legacyText],
  );

  const getSnapshot = useCallback(() => {
    if (cache.current?.source !== yArray) {
      // Only the legacy path needs the doc lookup; take the fast path when segments exist.
      const segments = segmentsFromArray(yArray);
      cache.current = {
        source: yArray,
        value: segments.length > 0 ? segments : readTranscriptSegments(doc, code),
      };
    }
    return cache.current.value;
  }, [yArray, doc, code]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
