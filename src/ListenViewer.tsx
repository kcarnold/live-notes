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
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
  useRemoteParticipants,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { Track } from "livekit-client";
import { LANGUAGE_BCP47, useStrings } from "./useLocale";
import { useSourceLanguage } from "./useSourceLanguage";
import { LiveTranscript } from "./LiveTranscript";
import { getDocId } from "./getDocId";
import { apiFetch } from "./writeKey";

const ORGANIZER_PREFIX = "organizer-";
const TRANSLATOR_PREFIX = "translator-";

// How often to re-request a missing translator bot (and the grace we give a
// just-requested one to appear before the first re-request).
const ENSURE_TRANSLATOR_INTERVAL_MS = 10_000;

// The ladder of waits between automatic reconnect attempts, one rung per consecutive
// failure.
//
// A listener on a phone loses this connection routinely: locking the screen backgrounds
// the tab, Android throttles the timers livekit-client reconnects on, and the signalling
// socket times out — reported, unhelpfully, as the generic "Abort handler called". That
// used to latch into a terminal error with a Retry button, so a phone that slept for
// thirty seconds stayed silent until its owner noticed and tapped. Retrying ourselves is
// what makes the recovery automatic.
//
// Bounded rather than endless, because each attempt re-requests the translator bot, and
// a bot requested with nobody broadcasting is a Gemini session held open for no one.
// After the last rung the pane gives up and waits — for the Retry button, or for the
// listener to come back to the tab, which resets the ladder (see the wake effect below).
// That leaves the attempts tied to something a person actually did.
const RECONNECT_DELAYS_MS = [1_000, 3_000, 8_000, 20_000, 30_000, 30_000];

// How long a connection has to hold before it counts as recovered rather than as a flap.
const STABLE_CONNECTION_MS = 30_000;

/** A failed connect attempt, and how many have failed in a row. */
interface ConnectFailure {
  /** What went wrong, when the failure came with a diagnostic worth showing. */
  message: string | null;
  count: number;
}

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
      void apiFetch("/api/livekit/translate", {
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
  // bot for a translation, or the speaker's raw mic on "Original".
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
  const sourceLanguage = useSourceLanguage();
  // The bot this pane needs, or null for original audio — where we listen to the
  // speaker directly and read a transcript the server already writes for every live
  // broadcaster. Null is the whole "original" special case: no /translate request, no
  // demand attribute, nothing to re-request. It used to claim the default language for
  // all three, which spun up a bridge we didn't need and counted us on the broadcaster
  // dashboard as a listener of a language we weren't hearing.
  //
  // "Original" means the language actually being spoken, whatever that is — asking to
  // be translated into it would be asking a bot to repeat the speaker back to us.
  const translatorLanguage = langCode === sourceLanguage ? null : langCode;
  const docId = getDocId();
  const [conn, setConn] = useState<ConnectInfo | null>(null);
  // The last failed attempt, or null while things are fine. Non-null does not mean we
  // have given up: until the ladder runs out, the retry effect below is holding a timer.
  const [failure, setFailure] = useState<ConnectFailure | null>(null);
  // The listener has opted into live audio (pressed "Listen Live"). Until then we
  // never touch LiveKit — no room join, no bot spin-up. Once true it stays true;
  // `audioOn` handles muting without dropping the connection.
  const [wantLive, setWantLive] = useState(false);
  // Whether translated audio is actually playing. Toggled by play/stop once
  // connected; the transcript flows regardless.
  const [audioOn, setAudioOn] = useState(false);
  // Bumped by the retry ladder and the retry button to re-run the connect effect.
  const [attempt, setAttempt] = useState(0);

  // Whether a room we still believe in is mounted. Tearing that room down is how we
  // start a fresh attempt, and the teardown itself fires Disconnected — so the flag is
  // cleared first, and a Disconnected that arrives after it must not be counted as a
  // second failure and skip a rung of the ladder.
  const roomLiveRef = useRef(false);

  // The ladder position. A ref rather than a field of `failure`, because a successful
  // connect clears `failure` for the UI but must not by itself put us back on the first
  // rung: a room that accepts us and drops us a second later has not recovered, and
  // restarting there would flap at one attempt a second, re-requesting a bot each time.
  // It resets when a connection has actually held (the effect below), and when a person
  // intervenes — Retry, or coming back to the tab.
  const failureCountRef = useRef(0);

  const noteFailure = useCallback((message: string | null) => {
    roomLiveRef.current = false;
    failureCountRef.current += 1;
    setConn(null);
    setFailure({ message, count: failureCountRef.current });
  }, []);

  // A failure reported by the room rather than by our own fetches. Ignored unless it is
  // about the connection we currently believe in (see roomLiveRef).
  const noteRoomFailure = useCallback(
    (message: string | null) => {
      if (!roomLiveRef.current) return;
      noteFailure(message);
    },
    [noteFailure]
  );

  const exhausted = failure !== null && failure.count > RECONNECT_DELAYS_MS.length;

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
          const tr = (await apiFetch("/api/livekit/translate", {
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
        const tk = (await apiFetch("/api/livekit/token", {
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
        roomLiveRef.current = true;
        setConn({ token: tk.token, serverUrl: tk.serverUrl, translatorIdentity });
        setFailure(null);
      } catch (e) {
        if (!cancelled) noteFailure(e instanceof Error ? e.message : String(e));
      }
    };
    void connect();
    return () => {
      cancelled = true;
    };
  }, [docId, translatorLanguage, attempt, wantLive, noteFailure]);

  // The retry ladder. Every recorded failure is a new object, so this re-arms once per
  // failure and never stacks timers; a success clears `failure` and with it the timer.
  useEffect(() => {
    if (!wantLive || !failure || exhausted) return;
    const delay = RECONNECT_DELAYS_MS[failure.count - 1];
    const id = setTimeout(() => setAttempt((a) => a + 1), delay);
    return () => clearTimeout(id);
  }, [wantLive, failure, exhausted]);

  // A connection that has held for a while really did recover, so the next unrelated
  // drop deserves the fast rungs again.
  useEffect(() => {
    if (!conn) return;
    const id = setTimeout(() => {
      failureCountRef.current = 0;
    }, STABLE_CONNECTION_MS);
    return () => clearTimeout(id);
  }, [conn]);

  // Coming back to the tab is the signal the ladder can't derive for itself: the phone
  // that just unlocked has a radio again, and whatever wait was pending — or the ladder
  // having already run out — is answering a question about a network that no longer
  // exists. Reset to the first rung so audio returns a second after the screen does.
  useEffect(() => {
    if (!wantLive) return;
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      failureCountRef.current = 0;
      setFailure((prev) => (prev ? { ...prev, count: 1 } : prev));
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, [wantLive]);

  // The control bar reflects state: before opt-in, a "Listen Live" button that joins on
  // demand; then the live audio controls once connected, a connecting hint, a
  // reconnecting notice between automatic attempts, or — only once those run out — an
  // error the listener has to answer. The transcript is always shown below it, since it
  // reads Yjs and needs no LiveKit connection.
  const retryNow = () => {
    roomLiveRef.current = false;
    failureCountRef.current = 0;
    setFailure(null);
    setConn(null);
    setAttempt((a) => a + 1);
  };

  let controls: React.ReactElement;
  if (exhausted && failure) {
    controls = (
      <div className="flex flex-col gap-1 items-start text-sm">
        <p className="text-red-600 dark:text-red-400">{s.liveAudioError}</p>
        {failure.message && <p className="text-xs text-gray-500">{failure.message}</p>}
        <button
          type="button"
          className="px-3 py-1 rounded bg-blue-500 text-white text-xs hover:bg-blue-600"
          onClick={retryNow}
        >
          {s.retry}
        </button>
      </div>
    );
  } else if (failure) {
    // Between attempts. Deliberately not the error state: nothing is required of the
    // listener, and the transcript below is still live, so this says what is happening
    // and offers the button to anyone who doesn't want to wait out the current rung.
    controls = (
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
        <span className="text-gray-600 dark:text-gray-300">{s.reconnecting}</span>
        <div className="flex-1" />
        <button
          type="button"
          className="px-3 py-1 rounded bg-blue-500 text-white text-xs hover:bg-blue-600"
          onClick={retryNow}
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
        onError={(e) => noteRoomFailure(e.message)}
        // Not just onError: that only fires when `connect()` itself rejects. A room that
        // connected and *then* died — livekit-client exhausting its own reconnect ladder
        // while the phone was asleep — arrives here instead, and used to leave the pane
        // showing a green "live" dot over a dead connection.
        onDisconnected={() => noteRoomFailure(null)}
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
