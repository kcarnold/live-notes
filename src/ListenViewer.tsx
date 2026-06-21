// ListenViewer: a self-contained pane that lets a viewer hear live
// speech-to-speech translated audio for a single language, produced by a Gemini
// Live translator bot in the session's LiveKit room. Kept deliberately isolated
// (lazy LiveKit import, own error/empty states) so any failure here is contained
// to this pane and never disturbs the outline / slide views.
//
// The transcript is read from the shared Yjs doc (`liveTranscript-{code}`), which
// the server-side translator bridge writes. That gives late joiners the full
// history and keeps the text visually stable; only the in-progress (interim) line
// arrives ephemerally over the LiveKit data channel.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
  useRemoteParticipants,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { Track, RoomEvent } from "livekit-client";
import { LANGUAGE_BCP47, useStrings } from "./useLocale";
import { useAsPlainText } from "./yjsUtils";
import { LISTEN_ORIGINAL_CODE, DEFAULT_LISTEN_CODE } from "./listenLanguages";
import { getDocId } from "./getDocId";

const ORGANIZER_PREFIX = "organizer-";

interface ConnectInfo {
  token: string;
  serverUrl: string;
  // The translator bot to hear, or null when listening to the original audio.
  translatorIdentity: string | null;
}

interface TranslateResp {
  translatorIdentity?: string;
  status?: string;
  targetLanguage?: string;
  error?: string;
}
interface TokenResp {
  token?: string;
  serverUrl?: string;
  error?: string;
}
interface TranscriptionMsg {
  type?: string;
  language?: string;
  text?: string;
  interim?: boolean;
}

// One finalized transcript paragraph. Mounting fresh (only appended segments do)
// plays a one-shot highlight animation, so new text is gently emphasized without
// any diffing — the Yjs text is append-only.
function TranscriptSegment({ text, isNew }: { text: string; isNew: boolean }) {
  return (
    <p className={`my-2 ${isNew ? "transcript-new" : ""}`}>{text}</p>
  );
}

// Runs inside <LiveKitRoom>: subscribe only to the chosen audio (translator bot,
// or the speaker's original mic), render the stable transcript, and report whether
// the speaker is present.
function ListenInner({
  docId,
  langCode,
  releaseTarget,
  translatorIdentity,
  isOriginal,
}: {
  docId: string;
  langCode: string;
  releaseTarget: string;
  translatorIdentity: string | null;
  isOriginal: boolean;
}) {
  const s = useStrings();
  const room = useRoomContext();
  const remoteParticipants = useRemoteParticipants();
  const [finalized] = useAsPlainText(`liveTranscript-${langCode}`);
  const [interim, setInterim] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  const speakerPresent = remoteParticipants.some((p) =>
    p.identity.startsWith(ORGANIZER_PREFIX)
  );

  // Subscribe to the audio we want: the translator bot for a translation, or the
  // speaker's raw mic for "Original / English". autoSubscribe is off, so we drive
  // this explicitly. Re-running on participant changes is essential for late
  // joiners — the track is already published, so no per-track event fires for us.
  useEffect(() => {
    if (!room) return;
    for (const participant of remoteParticipants) {
      const wanted = isOriginal
        ? participant.identity.startsWith(ORGANIZER_PREFIX)
        : participant.identity === translatorIdentity;
      for (const [, pub] of participant.trackPublications) {
        if (pub.kind === Track.Kind.Audio) pub.setSubscribed(wanted);
      }
    }
  }, [room, translatorIdentity, isOriginal, remoteParticipants]);

  // The in-progress line is ephemeral: replace (don't append) on each message,
  // and clear when the bridge sends an empty interim at turn completion.
  useEffect(() => {
    if (!room) return;
    const handleData = (
      payload: Uint8Array,
      _participant: unknown,
      _kind: unknown,
      topic: string | undefined
    ) => {
      if (topic !== "transcription") return;
      try {
        const data = JSON.parse(new TextDecoder().decode(payload)) as TranscriptionMsg;
        if (data.type !== "transcription" || data.language !== langCode) return;
        setInterim(data.text ?? "");
      } catch {
        // ignore non-transcription payloads
      }
    };
    room.on(RoomEvent.DataReceived, handleData);
    return () => {
      room.off(RoomEvent.DataReceived, handleData);
    };
  }, [room, langCode]);

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

  // Decrement the listener count when this pane goes away (unmount or tab close)
  // so idle translator bots tear down. (Best-effort; the server's presence reaper
  // is the authoritative teardown.)
  useEffect(() => {
    const release = () => {
      const body = JSON.stringify({ sessionId: docId, targetLanguage: releaseTarget });
      navigator.sendBeacon(
        "/api/livekit/translate/unsubscribe",
        new Blob([body], { type: "application/json" })
      );
    };
    window.addEventListener("beforeunload", release);
    return () => {
      window.removeEventListener("beforeunload", release);
      release();
    };
  }, [docId, releaseTarget]);

  const hasContent = segments.length > 0 || interim;

  return (
    <>
      <RoomAudioRenderer />
      <div className="flex items-center gap-2 text-xs">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            speakerPresent ? "bg-green-500 animate-pulse" : "bg-gray-400"
          }`}
        />
        <span className="text-gray-600 dark:text-gray-300">
          {speakerPresent ? s.liveListening : s.waitingForSpeaker}
        </span>
      </div>
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
            {interim && (
              <p className="my-2 italic text-gray-400 dark:text-gray-500">{interim}</p>
            )}
          </div>
        ) : (
          <span className="italic text-gray-400">{s.waitingForSpeech}</span>
        )}
      </div>
    </>
  );
}

export function ListenViewer({ language }: { language: string }) {
  const s = useStrings();
  // `language` is a BCP-47 code from the picker; tolerate a legacy display name.
  const langCode = LANGUAGE_BCP47[language] ?? language;
  const isOriginal = langCode === LISTEN_ORIGINAL_CODE;
  // For original audio we don't run a bot of our own — we keep the default bridge
  // alive (it produces the English transcript) and listen to the speaker directly.
  const translateTarget = isOriginal ? DEFAULT_LISTEN_CODE : langCode;
  const docId = getDocId();
  const [conn, setConn] = useState<ConnectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const start = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      // Ask the server to spin up (or reuse) the translator bot. For original
      // audio this just ensures the default bridge (and its transcript) is running.
      const tr = (await fetch("/api/livekit/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: docId, targetLanguage: translateTarget }),
      }).then((r) => r.json())) as TranslateResp;
      if (tr.error) throw new Error(tr.error);

      const identity = `attendee-${Math.random().toString(36).slice(2, 8)}`;
      const tk = (await fetch("/api/livekit/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: docId, identity, role: "attendee" }),
      }).then((r) => r.json())) as TokenResp;
      if (tk.error) throw new Error(tk.error);
      if (!tk.token || !tk.serverUrl) {
        throw new Error("Incomplete response from server");
      }
      if (!isOriginal && !tr.translatorIdentity) {
        throw new Error("Incomplete response from server");
      }

      setConn({
        token: tk.token,
        serverUrl: tk.serverUrl,
        translatorIdentity: isOriginal ? null : tr.translatorIdentity ?? null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, [docId, translateTarget, isOriginal]);

  if (error) {
    return (
      <div className="flex flex-col gap-2 items-start text-sm">
        <p className="text-red-600 dark:text-red-400">{s.liveAudioError}</p>
        <p className="text-xs text-gray-500">{error}</p>
        <button
          type="button"
          className="px-3 py-1 rounded bg-blue-500 text-white text-xs hover:bg-blue-600"
          onClick={() => void start()}
        >
          {s.retry}
        </button>
      </div>
    );
  }

  if (!conn) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <button
          type="button"
          disabled={connecting}
          className="px-4 py-2 rounded-full bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-60 shadow"
          onClick={() => void start()}
        >
          {connecting ? s.connecting : `🔊 ${s.listenLive}`}
        </button>
      </div>
    );
  }

  return (
    <LiveKitRoom
      video={false}
      audio={false}
      token={conn.token}
      serverUrl={conn.serverUrl}
      connectOptions={{ autoSubscribe: false }}
      onError={(e) => setError(e.message)}
      className="flex flex-col gap-2 flex-1 min-h-0"
    >
      <ListenInner
        docId={docId}
        langCode={langCode}
        releaseTarget={translateTarget}
        translatorIdentity={conn.translatorIdentity}
        isOriginal={isOriginal}
      />
    </LiveKitRoom>
  );
}
