// BroadcastControl: the speaker side of live translation. Shown to the editor;
// joins the session's LiveKit room as the organizer, publishes the microphone,
// and shows which languages are being translated and how many are listening.
// Self-contained and opt-in, mirroring ListenViewer's isolation.
import { useCallback, useEffect, useState } from "react";
import { useAtom } from "jotai";
import {
  LiveKitRoom,
  TrackToggle,
  useRemoteParticipants,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { Track } from "livekit-client";
import { isEditorAtom } from "./configAtoms";
import { useStrings } from "./useLocale";
import { getDocId } from "./getDocId";

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
      <div className="flex-1 overflow-auto">
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
      const tk = (await fetch("/api/livekit/token", {
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
