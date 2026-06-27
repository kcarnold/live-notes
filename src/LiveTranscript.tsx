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
import { useEffect, useMemo, useRef, useState } from "react";
import { useStrings } from "./useLocale";
import { useAsPlainText } from "./yjsUtils";

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
  const atBottomRef = useRef(true);

  const segments = useMemo(
    () => finalized.split("\n\n").map((t) => t.trim()).filter(Boolean),
    [finalized]
  );

  // Segments present at first render aren't animated; only later-appended ones are.
  // Captured once via a lazy initializer (reading a ref during render is unsafe).
  const [baselineCount] = useState(() => segments.length);

  // Auto-scroll only when the reader is already near the bottom, so reading older
  // text isn't yanked away when new text arrives. Runs after every render (cheap);
  // it only moves the scroll position when already pinned to the bottom.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  });

  const hasContent = segments.length > 0;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
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
        </div>
      ) : (
        <span className="italic text-gray-400">{s.waitingForSpeech}</span>
      )}
    </div>
  );
}
