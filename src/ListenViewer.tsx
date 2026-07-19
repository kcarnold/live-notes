// ListenViewer: a self-contained pane that lets a viewer follow a live, AI
// speech-to-speech translation for a single language, produced by a Gemini Live
// translator bot in the session's LiveKit room. Kept deliberately isolated (lazy
// LiveKit import, own error/empty states) so any failure here is contained to
// this pane and never disturbs the outline / slide views.
//
// The transcript shows immediately and unconditionally (it reads the shared Yjs
// doc, no LiveKit needed). Nothing touches LiveKit until the listener presses
// "Listen Live": that join both spins up the translator bot and keeps the session
// healthy. The tradeoff (accepted deliberately) is that the transcript stays dark
// until the first listener in a session opts in — no viewer holds a LiveKit
// connection just to read. In other words: read for free, opt in to hear.
import { useEffect, useRef, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
  useRemoteParticipants,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { Track } from "livekit-client";
import { LANGUAGE_BCP47, useStrings } from "./useLocale";
import { LISTEN_ORIGINAL_CODE, DEFAULT_LISTEN_CODE } from "./listenLanguages";
import { LiveTranscript } from "./LiveTranscript";
import { getDocId } from "./getDocId";

const ORGANIZER_PREFIX = "organizer-";

// How often to re-request a missing translator bot (and the grace we give a
// just-requested one to appear before the first re-request).
const ENSURE_TRANSLATOR_INTERVAL_MS = 10_000;

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

// Runs inside <LiveKitRoom>: report whether the speaker is present, and — only
// while the listener has audio enabled — subscribe to and play the chosen audio
// (the translator bot, or the speaker's original mic). The transcript itself is
// rendered by the parent, outside the room.
function ListenAudio({
  docId,
  releaseTarget,
  translatorIdentity,
  isOriginal,
  audioOn,
  onToggleAudio,
}: {
  docId: string;
  releaseTarget: string;
  translatorIdentity: string | null;
  isOriginal: boolean;
  audioOn: boolean;
  onToggleAudio: () => void;
}) {
  const s = useStrings();
  const room = useRoomContext();
  const remoteParticipants = useRemoteParticipants();

  const speakerPresent = remoteParticipants.some((p) =>
    p.identity.startsWith(ORGANIZER_PREFIX)
  );
  // The bot we depend on (for translated audio, or just the transcript when
  // listening to the original). Identities are deterministic: translator-<code>.
  const translatorPresent = remoteParticipants.some(
    (p) => p.identity === `translator-${releaseTarget}`
  );

  // Self-heal: the server can lose our translator (restart, presence reap, its room
  // connection dropping) and nothing server-side recreates it — so while the speaker
  // is broadcasting without our bot, periodically re-request it. Gated on speaker
  // presence so a pre-broadcast wait doesn't churn against the server's presence
  // reaper (docs/live-audio-state-architecture.md, "the waiting-room reap"): the
  // re-request then fires exactly when the session becomes healthy, so it sticks.
  const needsTranslator = speakerPresent && !translatorPresent;
  const lastEnsureRef = useRef(0);
  // Stamp mount time (not in render — Date.now is impure there) so the bot the parent
  // just requested gets one full interval to appear before the first re-request.
  useEffect(() => {
    lastEnsureRef.current = Date.now();
  }, []);
  useEffect(() => {
    if (!needsTranslator) return;
    const ensure = () => {
      const now = Date.now();
      if (now - lastEnsureRef.current < ENSURE_TRANSLATOR_INTERVAL_MS) return;
      lastEnsureRef.current = now;
      void fetch("/api/livekit/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: docId, targetLanguage: releaseTarget }),
      }).catch(() => {
        // Transient; the next tick retries.
      });
    };
    ensure();
    const id = setInterval(ensure, ENSURE_TRANSLATOR_INTERVAL_MS);
    return () => clearInterval(id);
  }, [needsTranslator, docId, releaseTarget]);

  // Subscribe to the audio we want only while audio is enabled: the translator
  // bot for a translation, or the speaker's raw mic for "Original / English".
  // autoSubscribe is off, so we drive this explicitly. Re-running on participant
  // changes is essential for late joiners — the track is already published, so no
  // per-track event fires for us.
  useEffect(() => {
    if (!room) return;
    for (const participant of remoteParticipants) {
      const wanted =
        audioOn &&
        (isOriginal
          ? participant.identity.startsWith(ORGANIZER_PREFIX)
          : participant.identity === translatorIdentity);
      for (const [, pub] of participant.trackPublications) {
        if (pub.kind === Track.Kind.Audio) pub.setSubscribed(wanted);
      }
    }
  }, [room, translatorIdentity, isOriginal, remoteParticipants, audioOn]);

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

  // Three-light status: gray = no speaker, amber = speaker is live but our
  // translator is missing (being re-requested above), green = fully wired. For
  // original audio the translator only carries the transcript, so its absence
  // doesn't demote the light — the audio the listener chose is unaffected.
  const degraded = needsTranslator && !isOriginal;
  const dotClass = !speakerPresent
    ? "bg-gray-400"
    : degraded
      ? "bg-amber-500 animate-pulse"
      : "bg-green-500 animate-pulse";
  const statusText = !speakerPresent
    ? s.waitingForSpeaker
    : degraded
      ? s.restartingTranslation
      : s.liveListening;

  return (
    <>
      <RoomAudioRenderer />
      <div className="flex items-center gap-2 text-xs">
        <span className={`inline-block w-2 h-2 rounded-full ${dotClass}`} />
        <span className="text-gray-600 dark:text-gray-300">{statusText}</span>
        <div className="flex-1" />
        <button
          type="button"
          aria-pressed={audioOn}
          className={`px-3 py-1 rounded-full text-white shadow ${
            audioOn ? "bg-gray-500 hover:bg-gray-600" : "bg-blue-500 hover:bg-blue-600"
          }`}
          onClick={onToggleAudio}
        >
          {audioOn ? `🔇 ${s.stopAudio}` : `🔊 ${s.listenLive}`}
        </button>
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
  // The listener has opted into live audio (pressed "Listen Live"). Until then we
  // never touch LiveKit — no room join, no bot spin-up. Once true it stays true;
  // `audioOn` handles muting without dropping the connection.
  const [wantLive, setWantLive] = useState(false);
  // Whether translated audio is actually playing. Toggled by play/stop once
  // connected; the transcript flows regardless.
  const [audioOn, setAudioOn] = useState(false);
  // Bumped by the retry button to re-run the connect effect.
  const [attempt, setAttempt] = useState(0);

  // Connect only after the listener opts in. Joining the room spins up the bot and
  // keeps the session healthy, so the transcript starts flowing once someone is
  // listening. No connection is made just to render the transcript.
  useEffect(() => {
    if (!wantLive) return;
    let cancelled = false;
    const connect = async () => {
      try {
        // Ask the server to spin up (or reuse) the translator bot. For original
        // audio this just ensures the default bridge (and its transcript) runs.
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

        if (cancelled) return;
        setConn({
          token: tk.token,
          serverUrl: tk.serverUrl,
          translatorIdentity: isOriginal ? null : tr.translatorIdentity ?? null,
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void connect();
    return () => {
      cancelled = true;
    };
  }, [docId, translateTarget, isOriginal, attempt, wantLive]);

  // The control bar reflects state: before opt-in, a "Listen Live" button that
  // joins on demand; then error (with retry), the live audio controls once
  // connected, or a connecting hint. The transcript is always shown below it,
  // since it reads Yjs and needs no LiveKit connection.
  let controls: React.ReactElement;
  if (error) {
    controls = (
      <div className="flex flex-col gap-1 items-start text-sm">
        <p className="text-red-600 dark:text-red-400">{s.liveAudioError}</p>
        <p className="text-xs text-gray-500">{error}</p>
        <button
          type="button"
          className="px-3 py-1 rounded bg-blue-500 text-white text-xs hover:bg-blue-600"
          onClick={() => {
            setError(null);
            setConn(null);
            setAttempt((a) => a + 1);
          }}
        >
          {s.retry}
        </button>
      </div>
    );
  } else if (!wantLive) {
    // Pre-connection: transcript is rendered below; this opts into live audio,
    // which is what actually joins the room and spins up the translator bot.
    controls = (
      <div className="flex items-center">
        <button
          type="button"
          className="px-3 py-1 rounded-full text-white shadow bg-blue-500 hover:bg-blue-600 text-sm"
          onClick={() => {
            setWantLive(true);
            setAudioOn(true);
          }}
        >
          {`🔊 ${s.listenLive}`}
        </button>
      </div>
    );
  } else if (conn) {
    controls = (
      <LiveKitRoom
        video={false}
        audio={false}
        token={conn.token}
        serverUrl={conn.serverUrl}
        connectOptions={{ autoSubscribe: false }}
        onError={(e) => setError(e.message)}
        className="w-full shrink-0 h-auto"
      >
        <ListenAudio
          docId={docId}
          releaseTarget={translateTarget}
          translatorIdentity={conn.translatorIdentity}
          isOriginal={isOriginal}
          audioOn={audioOn}
          onToggleAudio={() => setAudioOn((v) => !v)}
        />
      </LiveKitRoom>
    );
  } else {
    controls = (
      <div className="flex items-center gap-2 text-xs text-gray-500">{s.connecting}</div>
    );
  }

  return (
    <div className="flex flex-col gap-2 flex-1 min-h-0 h-full">
      <div className="shrink-0">{controls}</div>
      <div className="min-h-0 flex-1 flex flex-col overflow-hidden">
        <LiveTranscript langCode={langCode} />
      </div>
    </div>
  );
}
