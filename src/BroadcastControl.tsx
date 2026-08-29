// BroadcastControl: the speaker side of live translation. Shown to the editor;
// joins the session's LiveKit room as the organizer, publishes the microphone,
// and shows which languages are being translated and how many are listening.
// Self-contained and opt-in, mirroring ListenViewer's isolation.
//
// It is also where the session's *spoken* language is declared — the speaker is the
// only one who knows it, and everything downstream (which code the transcript is filed
// under, what "Original" means in the listen picker, which language the always-on
// bridge translates into) follows from it. See liveAudioConfig.ts.
import { useEffect, useState } from "react";
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
import { useYDoc } from "@y-sweet/react";
import { isEditorAtom } from "./configAtoms";
import { useStrings, resolveLocale } from "./useLocale";
import { LiveTranscript } from "./LiveTranscript";
import { LISTEN_LANGUAGE_CODES } from "./listenLanguages";
import { writeSourceLanguage } from "./liveAudioConfig";
import { useSourceLanguage } from "./useSourceLanguage";
import { getDocId } from "./getDocId";
import { apiFetch } from "./writeKey";

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

function BroadcastDashboard({
  docId,
  sourceLanguage,
}: {
  docId: string;
  sourceLanguage: string;
}) {
  const s = useStrings();
  const locale = resolveLocale();
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
      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-300">
        {s.sourceTranscript} ·{" "}
        {new Intl.DisplayNames([locale], { type: "language" }).of(sourceLanguage) ??
          sourceLanguage}
      </h3>
      {/* The primary bridge transcribes the speaker's own audio under the language
          they declared below, so this is a direct read-back of what's being captured —
          and the fastest way to notice a wrong declaration. */}
      <LiveTranscript langCode={sourceLanguage} />
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
  const locale = resolveLocale();
  const [isEditor] = useAtom(isEditorAtom);
  const docId = getDocId();
  const ydoc = useYDoc();
  const [conn, setConn] = useState<{ token: string; serverUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // What the speaker is about to speak. Follows whatever the session already says
  // until this speaker picks something — so re-opening the pane mid-service shows the
  // language in force rather than resetting the picker to a default that would then be
  // published on the next "Start broadcast".
  const declaredSourceLanguage = useSourceLanguage();
  const [picked, setPicked] = useState<string | null>(null);
  const spokenLanguage = picked ?? declaredSourceLanguage;

  const langDisplayNames = new Intl.DisplayNames([locale], { type: "language" });
  const spokenLanguageOptions = [...LISTEN_LANGUAGE_CODES].sort((a, b) =>
    (langDisplayNames.of(a) ?? a).localeCompare(langDisplayNames.of(b) ?? b, locale)
  );

  const start = async () => {
    setError(null);
    setConnecting(true);
    try {
      // Publish the spoken language before joining, by both routes it travels: the
      // shared doc (what every viewer and every later export reads) and the organizer
      // token (what the translation supervisor reads, since it decides from room
      // presence and can't wait on a doc sync). Doing it here, in the one place a
      // human states the fact, is what keeps the two copies agreeing.
      writeSourceLanguage(ydoc, spokenLanguage);
      const tk = (await apiFetch("/api/livekit/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No identity: the server derives `organizer-host` from the role, and gates the
        // role on a write key. Sending our own would let any caller claim the same seat
        // and evict whoever is speaking.
        body: JSON.stringify({
          room: docId,
          role: "organizer",
          speakLanguage: spokenLanguage,
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
  };

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
        {/* Asked before going live, not after: the language is fixed into the LiveKit
            token, so changing it means reconnecting. It's also the one question whose
            wrong answer is invisible — a mislabelled transcript still scrolls. */}
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          {s.spokenLanguage}
          <select
            className="px-2 py-1 rounded text-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700"
            value={spokenLanguage}
            onChange={(e) => setPicked(e.target.value)}
          >
            {spokenLanguageOptions.map((code) => (
              <option key={code} value={code}>
                {langDisplayNames.of(code) ?? code}
              </option>
            ))}
          </select>
        </label>
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
      <BroadcastDashboard docId={docId} sourceLanguage={spokenLanguage} />
    </LiveKitRoom>
  );
}
