// ListenViewer: a self-contained pane that lets a viewer hear live
// speech-to-speech translated audio for a single language, produced by a Gemini
// Live translator bot in the session's LiveKit room. Kept deliberately isolated
// (lazy LiveKit import, own error/empty states) so any failure here is contained
// to this pane and never disturbs the outline / slide views.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
  useRemoteParticipants,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { Track, RoomEvent } from "livekit-client";
import { LANGUAGE_BCP47, useStrings } from "./useLocale";
import { getDocId } from "./getDocId";

interface ConnectInfo {
  token: string;
  serverUrl: string;
  translatorIdentity: string;
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
}

// Runs inside <LiveKitRoom>: subscribe only to the translator bot's audio,
// surface live transcription, and report whether translated audio is flowing.
function ListenInner({
  docId,
  langCode,
  translatorIdentity,
}: {
  docId: string;
  langCode: string;
  translatorIdentity: string;
}) {
  const s = useStrings();
  const room = useRoomContext();
  const remoteParticipants = useRemoteParticipants();
  const [transcript, setTranscript] = useState("");
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const speakerPresent = remoteParticipants.some((p) =>
    p.identity.startsWith("organizer-")
  );

  // Subscribe only to the translator bot's audio (autoSubscribe is off), so the
  // listener hears the translation and not the speaker's original audio.
  useEffect(() => {
    if (!room) return;
    const updateSubscriptions = () => {
      for (const [, participant] of room.remoteParticipants) {
        const isTranslator = participant.identity === translatorIdentity;
        for (const [, pub] of participant.trackPublications) {
          if (pub.kind === Track.Kind.Audio) pub.setSubscribed(isTranslator);
        }
      }
    };
    updateSubscriptions();
    room.on(RoomEvent.TrackPublished, updateSubscriptions);
    room.on(RoomEvent.ParticipantConnected, updateSubscriptions);
    return () => {
      room.off(RoomEvent.TrackPublished, updateSubscriptions);
      room.off(RoomEvent.ParticipantConnected, updateSubscriptions);
    };
  }, [room, translatorIdentity]);

  // Accumulate live transcription published by the translator bot.
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
        if (data.type !== "transcription" || data.language !== langCode || !data.text) return;
        const text = data.text;
        setTranscript((prev) => (prev + text).slice(-2000));
      } catch {
        // ignore non-transcription payloads
      }
    };
    room.on(RoomEvent.DataReceived, handleData);
    return () => {
      room.off(RoomEvent.DataReceived, handleData);
    };
  }, [room, langCode]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  // Decrement the listener count when this pane goes away (unmount or tab close)
  // so idle translator bots tear down.
  useEffect(() => {
    const release = () => {
      const body = JSON.stringify({ sessionId: docId, targetLanguage: langCode });
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
  }, [docId, langCode]);

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
      <div className="flex-1 overflow-auto text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap">
        {transcript || (
          <span className="italic text-gray-400">{s.waitingForSpeech}</span>
        )}
        <div ref={transcriptEndRef} />
      </div>
    </>
  );
}

export function ListenViewer({ language }: { language: string }) {
  const s = useStrings();
  const langCode = LANGUAGE_BCP47[language] ?? language;
  const docId = getDocId();
  const [conn, setConn] = useState<ConnectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const start = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      // Ask the server to spin up (or reuse) a translator bot for this language.
      const tr = (await fetch("/api/livekit/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: docId, targetLanguage: langCode }),
      }).then((r) => r.json())) as TranslateResp;
      if (tr.error) throw new Error(tr.error);

      const identity = `attendee-${Math.random().toString(36).slice(2, 8)}`;
      const tk = (await fetch("/api/livekit/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: docId, identity, role: "attendee" }),
      }).then((r) => r.json())) as TokenResp;
      if (tk.error) throw new Error(tk.error);
      if (!tk.token || !tk.serverUrl || !tr.translatorIdentity) {
        throw new Error("Incomplete response from server");
      }

      setConn({
        token: tk.token,
        serverUrl: tk.serverUrl,
        translatorIdentity: tr.translatorIdentity,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, [docId, langCode]);

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
        <p className="text-xs text-gray-500">{language}</p>
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
        translatorIdentity={conn.translatorIdentity}
      />
    </LiveKitRoom>
  );
}
