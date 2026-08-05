// BroadcastControl: the speaker side of live translation. Shown to the editor;
// joins the session's LiveKit room as the organizer, publishes the microphone,
// and shows which languages are being translated and how many are listening.
// Self-contained and opt-in, mirroring ListenViewer's isolation.
import { useCallback, useEffect, useState } from "react";
import { useAtom } from "jotai";
import {
  LiveKitRoom,
  TrackToggle,
  useLocalParticipant,
  useRemoteParticipants,
  useTrackVolume,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { LocalAudioTrack, Track } from "livekit-client";
import { isEditorAtom } from "./configAtoms";
import { useStrings } from "./useLocale";
import { LiveTranscript } from "./LiveTranscript";
import { FontSizeControls } from "./FontSizeControls";
import { getDocId } from "./getDocId";
import { apiFetch } from "./writeKey";

// The default/primary translator bridge transcribes the speaker's own audio and
// writes it to the shared Yjs doc under this code, so the broadcaster can read
// back exactly what's being captured.
const SOURCE_TRANSCRIPT_CODE = "en";

interface TranslationInfo {
  language: string;
  translatorIdentity: string;
  status: string;
  subscriberCount: number;
}

interface StatusResp {
  translations?: TranslationInfo[];
  error?: string;
}
interface TokenResp {
  token?: string;
  serverUrl?: string;
  error?: string;
}

const ORGANIZER_IDENTITY = "organizer-host";

// A live level meter for the speaker's own microphone, so they can confirm their
// audio is actually being captured before/while broadcasting.
function MicLevelMeter() {
  const s = useStrings();
  const { isMicrophoneEnabled, microphoneTrack } = useLocalParticipant();
  const track = microphoneTrack?.track;
  const volume = useTrackVolume(track instanceof LocalAudioTrack ? track : undefined);
  // useTrackVolume returns ~0..1; scale up so normal speech fills the meter.
  const pct = isMicrophoneEnabled ? Math.min(100, Math.round(volume * 140)) : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-gray-600 dark:text-gray-300 whitespace-nowrap">{s.micLevel}</span>
      <div className="flex-1 h-2 rounded bg-gray-200 dark:bg-gray-700 overflow-hidden">
        <div
          className={`h-full transition-[width] duration-75 ${
            isMicrophoneEnabled ? "bg-green-500" : "bg-gray-400"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function BroadcastDashboard({ docId }: { docId: string }) {
  const s = useStrings();
  const remoteParticipants = useRemoteParticipants();
  const [translations, setTranslations] = useState<TranslationInfo[]>([]);

  // Count human listeners, not translator bots.
  const listenerCount = remoteParticipants.filter(
    (p) => !p.identity.startsWith("translator-")
  ).length;

  // Poll active translations for the dashboard.
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const data = (await fetch(
          `/api/livekit/translate/status?sessionId=${encodeURIComponent(docId)}`
        ).then((r) => r.json())) as StatusResp;
        if (active) setTranslations(data.translations ?? []);
      } catch {
        // transient; next poll retries
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [docId]);

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      <div className="flex items-center justify-between gap-2">
        <TrackToggle
          source={Track.Source.Microphone}
          className="px-3 py-1.5 rounded bg-blue-500 text-white text-sm hover:bg-blue-600"
        />
        <span className="text-xs text-gray-600 dark:text-gray-300">
          {listenerCount} {s.listeners}
        </span>
      </div>
      <MicLevelMeter />
      <div className="flex items-center">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-300">
          {s.englishTranscript}
        </h3>
        <FontSizeControls />
      </div>
      <LiveTranscript langCode={SOURCE_TRANSCRIPT_CODE} />
      <div className="overflow-auto max-h-40">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-300 mb-1">
          {s.activeTranslations}
        </h3>
        {translations.length === 0 ? (
          <p className="text-xs italic text-gray-400">{s.noActiveTranslations}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {translations.map((t) => (
              <li
                key={t.language}
                className="flex items-center justify-between text-sm"
              >
                <span className="uppercase">{t.language}</span>
                <span className="text-xs text-gray-500">
                  {t.subscriberCount} · {t.status}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="text-center mt-4">
          All remote participants:
          <ul className="text-xs text-gray-500 mt-1">
            {remoteParticipants.map((p) => (
              <li key={p.sid}>
                {p.identity} {p.isSpeaking ? "🔊" : ""}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function BroadcastControl() {
  const s = useStrings();
  const [isEditor] = useAtom(isEditorAtom);
  const docId = getDocId();
  const [conn, setConn] = useState<{ token: string; serverUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const start = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const tk = (await apiFetch("/api/livekit/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room: docId,
          identity: ORGANIZER_IDENTITY,
          role: "organizer",
        }),
      }).then((r) => r.json())) as TokenResp;
      if (tk.error) throw new Error(tk.error);
      if (!tk.token || !tk.serverUrl) throw new Error("Incomplete response from server");
      setConn({ token: tk.token, serverUrl: tk.serverUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, [docId]);

  if (!isEditor) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-500 text-center px-4">
        {s.broadcastEditorOnly}
      </div>
    );
  }

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
          className="px-4 py-2 rounded-full bg-red-500 text-white hover:bg-red-600 disabled:opacity-60 shadow"
          onClick={() => void start()}
        >
          {connecting ? s.connecting : `🎙️ ${s.startBroadcast}`}
        </button>
      </div>
    );
  }

  return (
    <LiveKitRoom
      video={false}
      audio={true}
      token={conn.token}
      serverUrl={conn.serverUrl}
      onError={(e) => setError(e.message)}
      className="flex flex-col flex-1 min-h-0"
    >
      <BroadcastDashboard docId={docId} />
    </LiveKitRoom>
  );
}
