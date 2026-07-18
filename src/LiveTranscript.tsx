// LiveTranscript: renders the live transcript for one language code, read
// straight from the shared Yjs doc (`liveTranscript-{code}`). The server-side
// translator bridge writes that text one delta at a time as a continuous,
// append-only stream, so this is the single source of truth and gives late
// joiners the full history.
//
// Deliberately free of any LiveKit dependency: the transcript shows immediately
// for any viewer — a listener (whether or not they've started audio) or the
// broadcaster — because reading it needs only the Yjs connection, not the audio
// room.
import { useMemo, useRef, useState } from "react";
import { useStrings } from "./useLocale";
import { useAsPlainText } from "./yjsUtils";
import { useStickToBottom } from "./reactUtils";

// One finalized transcript paragraph. Mounting fresh (only appended segments do)
// plays a one-shot highlight animation, so new text is gently emphasized without
// any diffing — the Yjs text is append-only.
function TranscriptSegment({ text, isNew }: { text: string; isNew: boolean }) {
  return <p className={`my-2 ${isNew ? "transcript-new" : ""}`}>{text}</p>;
}

export function LiveTranscript({ langCode }: { langCode: string }) {
  const s = useStrings();
  const [finalized] = useAsPlainText(`liveTranscript-${langCode}`);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentEndRef = useRef<HTMLDivElement | null>(null);

  const segments = useMemo(
    () => finalized.split("\n\n").map((t) => t.trim()).filter(Boolean),
    [finalized]
  );

  // Segments present at first render aren't animated; only later-appended ones are.
  // Captured once via a lazy initializer (reading a ref during render is unsafe).
  const [baselineCount] = useState(() => segments.length);

  // Key on the raw text, not segments.length: deltas stream into the *current*
  // paragraph without adding a segment, so keying on the count would only
  // re-stick at sentence boundaries and let mid-sentence text scroll off-screen.
  const { pinned, scrollToEnd } = useStickToBottom(scrollRef, contentEndRef, [finalized]);

  const hasContent = segments.length > 0;

  return (
    <div className="relative flex-1 flex flex-col min-h-0">
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto text-gray-800 dark:text-gray-100"
      >
        {hasContent ? (
          <div className="mx-auto max-w-[60ch] text-lg leading-relaxed">
            {segments.map((seg, i) => (
              <TranscriptSegment
                key={`${i}-${seg.slice(0, 16)}`}
                text={seg}
                isNew={i >= baselineCount}
              />
            ))}
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
