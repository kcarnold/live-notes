// LiveTranscript: renders the live transcript for one language code, read
// straight from the shared Yjs doc (`liveTranscriptSegments-{code}`). The
// server-side translator bridge writes that array one delta at a time as an
// append-only stream of utterances, so this is the single source of truth and gives
// late joiners the full history.
//
// Each segment carries how much silence preceded it, measured server-side at write
// time (see live-audio/transcript-writer.ts). A long enough gap renders as a break
// between utterances, so a reader can tell "the speaker stopped for a while" from
// "these two sentences ran together" — which unbroken text can't express.
//
// Deliberately free of any LiveKit dependency: the transcript shows immediately
// for any viewer — a listener (whether or not they've started audio) or the
// broadcaster — because reading it needs only the Yjs connection, not the audio
// room.
import { Fragment, useRef, useState } from "react";
import { useStrings, resolveLocale } from "./useLocale";
import { useTranscriptSegments } from "./useTranscriptSegments";
import { formatPauseGap, isLongPause, type TranscriptSegment } from "./transcriptKeys";
import { useStickToBottom } from "./reactUtils";

// One finalized transcript segment. Mounting fresh (only appended segments do)
// plays a one-shot highlight animation, so new text is gently emphasized without
// any diffing — the Yjs array is append-only.
function TranscriptSegmentView({ text, isNew }: { text: string; isNew: boolean }) {
  return <p className={`my-2 ${isNew ? "transcript-new" : ""}`}>{text}</p>;
}

// The silence before a segment, as a rule with the duration on it. Rendered between
// utterances rather than attached to one, because that's what it describes.
function PauseDivider({ gapMs }: { gapMs: number }) {
  const s = useStrings();
  const label = `${s.transcriptPause} · ${formatPauseGap(gapMs, resolveLocale())}`;
  return (
    <div
      className="flex items-center gap-3 my-5 select-none"
      role="separator"
      aria-label={label}
    >
      <span className="flex-1 border-t border-dashed border-gray-300 dark:border-gray-600" />
      <span className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500 tabular-nums">
        {label}
      </span>
      <span className="flex-1 border-t border-dashed border-gray-300 dark:border-gray-600" />
    </div>
  );
}

export function LiveTranscript({ langCode }: { langCode: string }) {
  const s = useStrings();
  const segments: TranscriptSegment[] = useTranscriptSegments(langCode);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentEndRef = useRef<HTMLDivElement | null>(null);

  // Segments present at first render aren't animated; only later-appended ones are.
  // Captured once via a lazy initializer (reading a ref during render is unsafe).
  const [baselineCount] = useState(() => segments.length);

  // Key on the total text length, not segments.length: deltas stream into the
  // *current* segment without adding one, so keying on the count would only re-stick
  // at utterance boundaries and let mid-sentence text scroll off-screen.
  const textLength = segments.reduce((n, seg) => n + seg.text.length, 0);
  const { pinned, scrollToEnd } = useStickToBottom(scrollRef, contentEndRef, [textLength]);

  const hasContent = segments.length > 0;

  return (
    <div className="relative flex-1 flex flex-col min-h-0">
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto text-gray-800 dark:text-gray-100"
      >
        {hasContent ? (
          <div className="mx-auto max-w-[60ch] text-lg leading-relaxed">
            {segments.map((seg, i) => {
              // Fragment, not a wrapper element: the paragraphs' vertical margins
              // collapse against each other, and boxing each one would double the gaps.
              const pauseBefore = isLongPause(seg) ? seg.gapMs : undefined;
              return (
                <Fragment key={`${i}-${seg.text.slice(0, 16)}`}>
                  {pauseBefore !== undefined && <PauseDivider gapMs={pauseBefore} />}
                  <TranscriptSegmentView text={seg.text} isNew={i >= baselineCount} />
                </Fragment>
              );
            })}
            <div ref={contentEndRef} />
          </div>
        ) : (
          <span className="italic text-gray-400">{s.waitingForSpeech}</span>
        )}
      </div>

      {hasContent && !pinned && (
        <button
          type='button'
          onClick={() => scrollToEnd()}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-sm font-medium shadow-lg bg-blue-500 text-white hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-500"
        >
          {s.jumpToLatest}
        </button>
      )}
    </div>
  );
}
