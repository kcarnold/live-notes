// Health-tile derivation for the session status page (#72).
//
// Kept out of StatusView.tsx so the component file exports only components, and so the
// tone rules — the whole point of the panel — are directly unit-testable.
import { resolveLocale } from './useLocale';
import type { AppStrings } from './strings';
import type { LiveAudioState, LiveAudioStatus } from './liveAudioStatus';

/** How a tile reads at a glance. */
export type Tone = 'unknown' | 'ok' | 'warn' | 'bad';

export interface HealthTile {
  key: string;
  name: string;
  detail: string;
  tone: Tone;
}

export const TONE_DOT: Record<Tone, string> = {
  unknown: 'bg-gray-300 dark:bg-gray-600',
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
};

/** Format an elapsed duration in ms as "N seconds ago". */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return new Intl.RelativeTimeFormat(resolveLocale(), { numeric: 'auto' }).format(
    -seconds,
    'second',
  );
}

/**
 * Format a server-stamped epoch-ms time as an age relative to when the poll landed,
 * or "never" for 0.
 *
 * Server clock vs browser clock: `at` comes from the bridge process, `receivedAt` from
 * this browser, so the age carries whatever skew exists between them. Close enough for
 * "seconds ago", and measuring against the poll rather than a live clock is what keeps
 * rendering pure — the number changes when new data arrives, not on every re-render.
 */
export function formatStamp(at: number, receivedAt: number, s: AppStrings): string {
  if (!at) return s.statusNever;
  return formatAge(receivedAt - at);
}

/**
 * The health tiles, derived from one poll of the live-audio status endpoint.
 *
 * A few of the tone rules are judgement calls worth pinning down: "no broadcaster" and
 * "nobody listening" are amber/grey rather than red, because before a service starts
 * that is simply the normal state and a panel that cries outage over a quiet room gets
 * ignored by the time it matters. An unreachable server, by contrast, is red.
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

  // Awaits the `status` Y.Map — it runs behind NAT, so the server can't poll it.
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
