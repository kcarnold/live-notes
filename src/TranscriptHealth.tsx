// TranscriptHealth: an operator-facing liveness view of the live speech-translation
// transcripts, for the session status page. It answers "is translation actually
// flowing right now, and into which languages?" by reading the same
// `liveTranscriptSegments-{code}` streams the product itself renders (see
// LiveTranscript.tsx and OBSERVABILITY.md §4 — transcript growth is the one
// end-to-end heartbeat no single component can fake).
//
// Two things worth knowing about the freshness signal:
//   - "updated Ns ago" is measured client-side from when a delta is observed while
//     this view is mounted. It's relative to the page, not absolute wall-clock. (Now
//     that segments carry `startedAt`, the pre-page-load write time *is* recoverable
//     — but a segment's start isn't its last delta, so seeding from it would
//     over-report staleness on a segment that's still streaming. Left alone: for "is
//     it moving now", observing deltas is the right signal.)
//   - The initial sync populate fires one observe with the full backlog; that isn't
//     a live delta, so each tile ignores its first observed value.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useYDoc } from '@y-sweet/react';
import type * as Y from 'yjs';
import { useStrings, resolveLocale } from './useLocale';
import { useTranscriptSegments } from './useTranscriptSegments';
import {
  LIVE_TRANSCRIPT_SOURCE_CODE,
  liveTranscriptCodes,
  liveTranscriptLabel,
  transcriptPlainText,
} from './transcriptKeys';

/** Freshness thresholds (ms) for the staleness dot. */
const FRESH_MS = 8_000;
const RECENT_MS = 30_000;
/** How much of the transcript tail to preview. */
const TAIL_CHARS = 90;

/**
 * The transcript codes present in the doc, kept in sync as new languages appear
 * mid-session. Root types show up in `doc.share` once integrated, so we re-scan on
 * every doc update; the snapshot is a plain comma-joined string so an unchanged set
 * of languages doesn't re-render even as text streams in.
 */
function useLiveTranscriptCodes(doc: Y.Doc): string[] {
  const [codesKey, setCodesKey] = useState(() => liveTranscriptCodes(doc).join(','));
  useEffect(() => {
    const update = () => setCodesKey(liveTranscriptCodes(doc).join(','));
    update(); // doc identity may have changed since the initializer ran
    doc.on('update', update);
    return () => doc.off('update', update);
  }, [doc]);
  return useMemo(() => (codesKey === '' ? [] : codesKey.split(',')), [codesKey]);
}

/** A monotonically re-rendering "now", ticking once a second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Collapse whitespace and take the last TAIL_CHARS for a compact preview. */
function tail(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > TAIL_CHARS ? `…${collapsed.slice(-TAIL_CHARS)}` : collapsed;
}

function TranscriptHealthTile({ code }: { code: string }) {
  const s = useStrings();
  const segments = useTranscriptSegments(code);
  // Flattened for the char count and tail preview — this view is about whether the
  // transcript is *moving*, not about its structure, so the segmentation is noise here.
  const text = useMemo(() => transcriptPlainText(segments), [segments]);
  const isSource = code === LIVE_TRANSCRIPT_SOURCE_CODE;

  // Record when a *live* delta arrives. The first observed value is the initial
  // sync backlog, not a live update, so seed the ref with it without stamping a time.
  const prevRef = useRef<string | null>(null);
  const [lastChangeAt, setLastChangeAt] = useState<number | null>(null);
  useEffect(() => {
    if (prevRef.current === null) {
      prevRef.current = text;
      return;
    }
    if (text !== prevRef.current) {
      prevRef.current = text;
      setLastChangeAt(Date.now());
    }
  }, [text]);

  const now = useNow(lastChangeAt !== null);
  const ageMs = lastChangeAt === null ? null : now - lastChangeAt;

  const dotClass =
    ageMs === null
      ? 'bg-gray-300 dark:bg-gray-600'
      : ageMs < FRESH_MS
        ? 'bg-green-500'
        : ageMs < RECENT_MS
          ? 'bg-amber-500'
          : 'bg-red-500';

  const freshness =
    ageMs === null
      ? s.statusTranscriptNoUpdates
      : new Intl.RelativeTimeFormat(resolveLocale(), { numeric: 'auto' }).format(
          -Math.round(ageMs / 1000),
          'second',
        );

  const preview = tail(text);
  const label = liveTranscriptLabel(code);

  return (
    <div className="rounded border border-gray-200 dark:border-gray-700 p-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${dotClass}`} />
        <span className="text-sm font-medium">{label}</span>
        {isSource && (
          <span className="text-xs text-gray-500 dark:text-gray-400">({s.statusTranscriptSource})</span>
        )}
        <span className="ml-auto text-xs tabular-nums text-gray-500 dark:text-gray-400">
          {text.length.toLocaleString()} chars · {freshness}
        </span>
      </div>
      <p className="text-xs text-gray-600 dark:text-gray-300 line-clamp-2 min-h-8">
        {preview || <span className="italic text-gray-400 dark:text-gray-500">—</span>}
      </p>
    </div>
  );
}

/** Live liveness tiles for every transcript language present in the session doc. */
export function TranscriptHealth() {
  const s = useStrings();
  const doc = useYDoc();
  const codes = useLiveTranscriptCodes(doc);

  if (codes.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{s.statusTranscriptsEmpty}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {codes.map((code) => (
        <TranscriptHealthTile key={code} code={code} />
      ))}
    </div>
  );
}
