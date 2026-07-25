// ListenViewer: a self-contained pane that lets a viewer follow a live, AI
// speech-to-speech translation for a single language, produced by a Gemini Live
// translator bot in the session's LiveKit room. Kept deliberately isolated (lazy
// LiveKit import, own error/empty states) so any failure here is contained to
// this pane and never disturbs the outline / slide views.
//
// The transcript shows immediately and unconditionally (it reads the shared Yjs
// doc, no LiveKit needed), and the server writes it for any live broadcaster
// whether or not anyone is listening — so a viewer who never presses "Listen Live"
// still reads the talk from its first word, and one who presses it late gets the
// history. Nothing here touches LiveKit until they do press it. Read for free, opt
// in to hear.
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
import { LISTEN_ORIGINAL_CODE } from "./listenLanguages";
import { LiveTranscript } from "./LiveTranscript";
import { getDocId } from "./getDocId";

const ORGANIZER_PREFIX = "organizer-";
const TRANSLATOR_PREFIX = "translator-";

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
  translatorLanguage,
  translatorIdentity,
  audioOn,
  onToggleAudio,
}: {
  docId: string;
  translatorLanguage: string | null;
  translatorIdentity: string | null;
  audioOn: boolean;
  onToggleAudio: () => void;
}) {
  const s = useStrings();
  const room = useRoomContext();
  const remoteParticipants = useRemoteParticipants();

  const speakerPresent = remoteParticipants.some((p) =>
    p.identity.startsWith(ORGANIZER_PREFIX)
  );
  // What this pane depends on beyond the speaker. For a translation it's our own bot
  // (identities are deterministic: translator-<code>). For original audio the speaker's
  // mic is the audio, but the transcript still comes from a bot — the server's default
  // bridge — so *some* translator has to be present for this pane to be fully working.
  // Checking the prefix rather than naming that language keeps the server's choice of
  // default out of the client.
  const translatorPresent = translatorLanguage
    ? remoteParticipants.some((p) => p.identity === `translator-${translatorLanguage}`)
    : remoteParticipants.some((p) => p.identity.startsWith(TRANSLATOR_PREFIX));

  // Self-heal backstop: the server's presence supervisor recreates lost bridges from
  // our `listen` attribute, but if that path is ever wrong or slow, re-requesting
  // here converges too — same reconcile principle, run from both ends. Gated on
  // speaker presence so a pre-broadcast wait doesn't churn against the supervisor's
  // wind-down (docs/live-audio-state-architecture.md, "the waiting-room reap"): the
  // re-request then fires exactly when demand becomes satisfiable, so it sticks.
  const needsTranslator = speakerPresent && !translatorPresent;
  const lastEnsureRef = useRef(0);
  // Stamp mount time (not in render — Date.now is impure there) so the bot the parent
  // just requested gets one full interval to appear before the first re-request.
  useEffect(() => {
    lastEnsureRef.current = Date.now();
  }, []);
  useEffect(() => {
    // Only a translation is ours to re-request. The default bridge that writes the
    // transcript isn't requested by anyone — the supervisor runs it for any live
    // broadcaster — so on original audio there is nothing for us to ensure.
    if (!needsTranslator || !translatorLanguage) return;
    const ensure = () => {
      const now = Date.now();
      if (now - lastEnsureRef.current < ENSURE_TRANSLATOR_INTERVAL_MS) return;
      lastEnsureRef.current = now;
      void fetch("/api/livekit/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: docId, targetLanguage: translatorLanguage }),
      }).catch(() => {
        // Transient; the next tick retries.
      });
    };
    ensure();
    const id = setInterval(ensure, ENSURE_TRANSLATOR_INTERVAL_MS);
    return () => clearInterval(id);
  }, [needsTranslator, docId, translatorLanguage]);

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
        (translatorIdentity
          ? participant.identity === translatorIdentity
          : participant.identity.startsWith(ORGANIZER_PREFIX));
      for (const [, pub] of participant.trackPublications) {
        if (pub.kind === Track.Kind.Audio) pub.setSubscribed(wanted);
      }
    }
  }, [room, translatorIdentity, remoteParticipants, audioOn]);

  // No unload beacon: leaving the LiveKit room IS the unsubscribe signal now — the
  // server's supervisor reads demand from room presence and winds the bridge down
  // after a grace window.

  // Three-light status: gray = no speaker, amber = speaker is live but the bot this
  // pane needs is missing, green = fully wired. Amber covers original audio too: the
  // audio is unaffected there, but a missing transcript writer means half the pane is
  // silently frozen, and green over frozen text is the one reading that leaves a
  // listener staring at a stale paragraph believing it's current.
  const dotClass = !speakerPresent
    ? "bg-gray-400"
    : needsTranslator
      ? "bg-amber-500 animate-pulse"
      : "bg-green-500 animate-pulse";
  const statusText = !speakerPresent
    ? s.waitingForSpeaker
    : needsTranslator
      ? translatorLanguage
        ? s.restartingTranslation
        : s.waitingForTranscript
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
  // The bot this pane needs, or null for original audio — where we listen to the
  // speaker directly and read a transcript the server already writes for every live
  // broadcaster. Null is the whole "original" special case: no /translate request, no
  // demand attribute, nothing to re-request. It used to claim the default language for
  // all three, which spun up a bridge we didn't need and counted us on the broadcaster
  // dashboard as a listener of a language we weren't hearing.
  const translatorLanguage = langCode === LISTEN_ORIGINAL_CODE ? null : langCode;
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
        // Ask the server to spin up (or reuse) our translator bot. Skipped entirely on
        // original audio: we need no bot, and the transcript's bridge is the server's
        // to run.
        let translatorIdentity: string | null = null;
        if (translatorLanguage) {
          const tr = (await fetch("/api/livekit/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: docId, targetLanguage: translatorLanguage }),
          }).then((r) => r.json())) as TranslateResp;
          if (tr.error) throw new Error(tr.error);
          if (!tr.translatorIdentity) throw new Error("Incomplete response from server");
          translatorIdentity = tr.translatorIdentity;
        }

        const identity = `attendee-${Math.random().toString(36).slice(2, 8)}`;
        // listenLanguage rides into the LiveKit token as a participant attribute:
        // it's how the server's translation supervisor reads demand from room
        // presence, so our bridge survives as long as we're in the room — no
        // refcounts, no unload beacon. Sent only when we actually want a bot, so
        // "demand" stays a true statement about what someone is listening to.
        const tk = (await fetch("/api/livekit/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            room: docId,
            identity,
            role: "attendee",
            ...(translatorLanguage ? { listenLanguage: translatorLanguage } : {}),
          }),
        }).then((r) => r.json())) as TokenResp;
        if (tk.error) throw new Error(tk.error);
        if (!tk.token || !tk.serverUrl) {
          throw new Error("Incomplete response from server");
        }

        if (cancelled) return;
        setConn({ token: tk.token, serverUrl: tk.serverUrl, translatorIdentity });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void connect();
    return () => {
      cancelled = true;
    };
  }, [docId, translatorLanguage, attempt, wantLive]);

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
          translatorLanguage={translatorLanguage}
          translatorIdentity={conn.translatorIdentity}
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
