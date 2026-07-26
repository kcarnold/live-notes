import type { ReactNode } from 'react';
import { useMap, useYDoc } from '@y-sweet/react';
import { useStrings, resolveLocale } from './useLocale';
import type { AppStrings } from './strings';
import { getDocId } from './getDocId';
import { TranscriptHealth } from './TranscriptHealth';
import { useLiveAudioStatus } from './liveAudioStatus';
import type { LiveAudioState, LiveAudioStatus, TranslationInfoView } from './liveAudioStatus';

/**
 * Session status / admin page.
 *
 * Part of issue #72 (component heartbeats + web status view + preflight canary).
 * What's wired today:
 *
 *   - Health: live tiles for the pieces the *server* can see — is it reachable, is a
 *     broadcaster live, which translator bridges are running, how many people are
 *     listening — polled from /api/livekit/translate/status. This is what lets an
 *     operator read translator and listener counts without a broadcaster page open.
 *   - Transcripts: real end-to-end liveness read from the transcript Y.Texts.
 *
 * Still placeholders: the `status` Y.Map heartbeats (for components the server can't
 * poll — the Proclaim service and the macOS ingest app, which live behind NAT on
 * someone's Mac and can only report through the doc), and the preflight canary.
 *
 * The pure component takes plain props so it's testable without Yjs or fetch; the
 * container wires it to the doc and the poll.
 */

/** How a tile reads at a glance. */
type Tone = 'unknown' | 'ok' | 'warn' | 'bad';

interface HealthTile {
  key: string;
  name: string;
  detail: string;
  tone: Tone;
}

const TONE_DOT: Record<Tone, string> = {
  unknown: 'bg-gray-300 dark:bg-gray-600',
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
};

/** Format a server-side epoch-ms stamp as an age, or "never" for 0. */
function formatStamp(at: number, s: AppStrings): string {
  if (!at) return s.statusNever;
  // Server clock vs browser clock: close enough for "seconds ago", and the alternative
  // (server-computed ages) would go stale in the client between polls anyway.
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  return new Intl.RelativeTimeFormat(resolveLocale(), { numeric: 'auto' }).format(
    -seconds,
    'second',
  );
}

/**
 * The health tiles, derived from one poll of the live-audio status endpoint.
 *
 * Exported for direct testing: the tone rules are the whole point of the panel, and a
 * few of them are judgement calls worth pinning down — notably that "no broadcaster"
 * and "nobody listening" are amber/grey rather than red (before a service starts,
 * that's simply the normal state), while an unreachable server is red.
 */
export function computeHealthTiles(
  state: LiveAudioState,
  liveAudio: LiveAudioStatus | null,
  s: AppStrings,
): HealthTile[] {
  const unknown = (key: string, name: string): HealthTile => ({
    key,
    name,
    detail: state === 'unconfigured' ? s.statusLiveKitUnconfigured : s.statusNotReporting,
    tone: 'unknown',
  });

  // A 503 means the server answered — it just has no LiveKit. Only a failed or
  // unfinished request leaves the server itself in doubt.
  const server: HealthTile = {
    key: 'server',
    name: s.statusComponentServer,
    detail:
      state === 'loading'
        ? s.statusNotReporting
        : state === 'error'
          ? s.statusServerUnreachable
          : s.statusServerReachable,
    tone: state === 'loading' ? 'unknown' : state === 'error' ? 'bad' : 'ok',
  };

  // Awaits the `status` Y.Map — the server has no way to poll it.
  const proclaim: HealthTile = {
    key: 'proclaim',
    name: s.statusComponentProclaim,
    detail: s.statusNotReporting,
    tone: 'unknown',
  };

  const presence = liveAudio?.presence ?? null;
  if (state !== 'ok' || !presence) {
    return [
      server,
      proclaim,
      unknown('bridges', s.statusComponentBridges),
      unknown('broadcaster', s.statusComponentBroadcaster),
      unknown('listeners', s.statusComponentListeners),
    ];
  }

  const translations = liveAudio?.translations ?? [];
  const active = translations.filter((t) => t.status === 'active');
  const bridgeTone: Tone = translations.some((t) => t.status === 'error')
    ? 'bad'
    : translations.length === 0
      ? 'unknown'
      : active.length < translations.length
        ? 'warn'
        : 'ok';

  return [
    server,
    proclaim,
    {
      key: 'bridges',
      name: s.statusComponentBridges,
      detail:
        translations.length === 0
          ? s.statusBridgesNone
          : `${active.length}/${translations.length} ${s.statusBridgesRunning}`,
      tone: bridgeTone,
    },
    {
      key: 'broadcaster',
      name: s.statusComponentBroadcaster,
      detail: presence.broadcasterPresent ? s.statusBroadcasterLive : s.statusBroadcasterOffline,
      tone: presence.broadcasterPresent ? 'ok' : 'warn',
    },
    {
      key: 'listeners',
      name: s.statusComponentListeners,
      detail:
        presence.listeners.length === 0
          ? s.statusListenersNone
          : `${presence.listeners.length} ${s.listeners}`,
      tone: presence.listeners.length === 0 ? 'unknown' : 'ok',
    },
  ];
}

/** Per-language bridge detail: who's listening and whether the Gemini leg is well. */
function BridgeRow({ info }: { info: TranslationInfoView }) {
  const s = useStrings();
  const health = info.health;
  return (
    <li className="flex items-baseline justify-between gap-2 text-sm">
      <span className="uppercase font-medium">{info.language}</span>
      <span className="text-xs text-gray-500 dark:text-gray-400 text-right">
        {info.subscriberCount} {s.listeners} · {info.status}
        {health ? ` · ${s.statusGemini} ${health.gemini}` : ''}
        {health ? ` · ${s.statusLastAudio} ${formatStamp(health.lastOutputFrameAt, s)}` : ''}
      </span>
    </li>
  );
}

export interface StatusViewProps {
  /** The session's doc id (drives the export link). */
  docId: string;
  /**
   * Raw entries from the `status` Y.Map (#72), keyed by component id. Empty until
   * components start heartbeating; the skeleton only reports the count for now.
   */
  statusEntries: Record<string, unknown>;
  /**
   * Live-transcript liveness tiles, injected by the container (they need per-Y.Text
   * observers). Kept as a slot so the pure component stays testable without Yjs.
   */
  liveTranscripts?: ReactNode;
  /** Poll state for the live-audio status endpoint; defaults to "not loaded yet". */
  liveAudioState?: LiveAudioState;
  /** Latest live-audio status payload, if any. */
  liveAudio?: LiveAudioStatus | null;
}

export function StatusView({
  docId,
  statusEntries,
  liveTranscripts,
  liveAudioState = 'loading',
  liveAudio = null,
}: StatusViewProps) {
  const s = useStrings();
  const exportHref = `/api/session/export?doc=${encodeURIComponent(docId)}`;
  const reportingCount = Object.keys(statusEntries).length;
  const tiles = computeHealthTiles(liveAudioState, liveAudio, s);
  const translations = liveAudio?.translations ?? [];
  const presence = liveAudio?.presence ?? null;

  const sectionClass =
    'bg-white/80 dark:bg-gray-800/80 rounded shadow p-4 flex flex-col gap-3';
  const sectionTitleClass = 'font-semibold text-lg';
  const placeholderClass = 'text-sm text-gray-500 dark:text-gray-400';

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-100 to-gray-300 dark:from-gray-950 dark:to-gray-900 text-black dark:text-gray-200 overflow-auto">
      <div className="max-w-2xl mx-auto px-4 py-8 flex flex-col gap-6">
        <header className="flex items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold">{s.statusTitle}</h1>
          <code className="text-xs text-gray-500 dark:text-gray-400">{docId}</code>
        </header>

        {/* Health — live tiles for what the server can see; Y.Map heartbeats still pending. */}
        <section className={sectionClass}>
          <h2 className={sectionTitleClass}>{s.statusHealthTitle}</h2>
          <div className="grid grid-cols-2 gap-2">
            {tiles.map((tile) => (
              <div
                key={tile.key}
                className="rounded border border-gray-200 dark:border-gray-700 p-2 flex items-center gap-2"
              >
                <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${TONE_DOT[tile.tone]}`} />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium">{tile.name}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{tile.detail}</span>
                </div>
              </div>
            ))}
          </div>

          {translations.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-300">
                {s.activeTranslations}
              </h3>
              <ul className="flex flex-col gap-1">
                {translations.map((t) => (
                  <BridgeRow key={t.language} info={t} />
                ))}
              </ul>
            </div>
          )}

          {/* Presence can be served from cache during a LiveKit read failure, so say how
              old it is rather than letting a frozen snapshot read as live. */}
          {presence && presence.snapshotAgeMs > 15_000 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {s.statusPresenceSnapshot}: {formatStamp(Date.now() - presence.snapshotAgeMs, s)}
            </p>
          )}

          <p className={placeholderClass}>
            {s.statusHealthPlaceholder}
            {reportingCount > 0 ? ` (${reportingCount})` : ''}
          </p>
        </section>

        {/* Live transcripts — real end-to-end liveness, read from the transcript Y.Texts. */}
        <section className={sectionClass}>
          <h2 className={sectionTitleClass}>{s.statusTranscriptsTitle}</h2>
          {liveTranscripts ?? (
            <p className={placeholderClass}>{s.statusTranscriptsEmpty}</p>
          )}
        </section>

        {/* Preflight canary — placeholder until #72. */}
        <section className={sectionClass}>
          <h2 className={sectionTitleClass}>{s.statusCanaryTitle}</h2>
          <p className={placeholderClass}>{s.statusCanaryPlaceholder}</p>
        </section>

        {/* Session export — the one working admin action, moved off the viewer screens. */}
        <section className={sectionClass}>
          <h2 className={sectionTitleClass}>{s.statusExportTitle}</h2>
          <p className={placeholderClass}>{s.statusExportDescription}</p>
          <a
            href={exportHref}
            download
            className="self-start px-4 py-2 rounded bg-blue-500 text-white hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700 transition text-sm shadow hover:shadow-lg"
          >
            ⬇️ {s.downloadSession}
          </a>
        </section>

        <a
          href="/"
          className="text-sm underline text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
        >
          {s.goHome}
        </a>
      </div>
    </div>
  );
}

/** Yjs + poll connector: reads the `status` Y.Map and the live-audio status endpoint. */
export function StatusViewContainer() {
  useYDoc(); // Ensure this renders within the session's YDocProvider.
  const statusMap = useMap('status');
  const docId = getDocId();
  const { state, status } = useLiveAudioStatus(docId);
  const statusEntries: Record<string, unknown> = {};
  statusMap.forEach((value, key) => {
    statusEntries[key] = value;
  });
  return (
    <StatusView
      docId={docId}
      statusEntries={statusEntries}
      liveTranscripts={<TranscriptHealth />}
      liveAudioState={state}
      liveAudio={status}
    />
  );
}

export default StatusView;
