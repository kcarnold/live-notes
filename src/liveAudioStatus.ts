// Client-side view of the live-audio status endpoint (#72).
//
// The status page needs translator and listener counts without a broadcaster page open.
// Those numbers live on the server — bridge health is bridge-process memory, and room
// presence comes from LiveKit's server API — so the client polls rather than deriving
// anything locally. See /api/livekit/translate/status in server.ts.
import { useEffect, useState } from 'react';

/** Mirrors BridgeHealth in live-audio/translation-bridge.ts. */
export interface BridgeHealthView {
  status: string;
  gemini: string;
  /** Epoch ms on the *server*, or 0 for never. Ages computed from these carry clock skew. */
  lastInputFrameAt: number;
  lastOutputFrameAt: number;
  reconnects: number;
  bufferedFrames: number;
}

/** Mirrors TranslationInfo in live-audio/translation-session-manager.ts. */
export interface TranslationInfoView {
  language: string;
  translatorIdentity: string;
  status: string;
  subscriberCount: number;
  health?: BridgeHealthView;
}

/** Mirrors RoomPresence in live-audio/translation-session-manager.ts. */
export interface RoomPresenceView {
  broadcasterPresent: boolean;
  broadcasterIdentity: string | null;
  listeners: { identity: string; listenLanguage: string | null }[];
  translatorIdentities: string[];
  snapshotAgeMs: number;
}

export interface LiveAudioStatus {
  translations: TranslationInfoView[];
  /** null when there's nothing to report: room not open yet, or LiveKit unreadable. */
  presence: RoomPresenceView | null;
}

/**
 * Why the view has no data, when it has none.
 *   - loading:      first poll hasn't returned yet.
 *   - unconfigured: the deployment has no LiveKit (503). Not an outage — a dev machine.
 *   - error:        the server is there but the read failed. That IS worth a red tile.
 */
export type LiveAudioState = 'loading' | 'ok' | 'unconfigured' | 'error';

export const LIVE_AUDIO_POLL_MS = 3_000;

export interface LiveAudioStatusResult {
  state: LiveAudioState;
  status: LiveAudioStatus | null;
  /**
   * Client epoch ms when this payload arrived (0 when none has). Ages are measured
   * against this rather than a render-time clock, so rendering stays pure and a tile's
   * age can't drift between polls.
   */
  receivedAt: number;
}

const LOADING: LiveAudioStatusResult = { state: 'loading', status: null, receivedAt: 0 };

/** Poll the live-audio status endpoint for a session. */
export function useLiveAudioStatus(
  docId: string,
  intervalMs: number = LIVE_AUDIO_POLL_MS,
): LiveAudioStatusResult {
  // Stamped with the doc it describes, so switching sessions reads as "loading" by
  // derivation rather than by resetting state from inside the effect.
  const [result, setResult] = useState<LiveAudioStatusResult & { docId: string }>({
    ...LOADING,
    docId,
  });

  useEffect(() => {
    let active = true;

    const poll = async () => {
      const settle = (next: LiveAudioStatusResult) => {
        if (active) setResult({ ...next, docId });
      };
      try {
        const resp = await fetch(
          `/api/livekit/translate/status?sessionId=${encodeURIComponent(docId)}`,
        );
        if (!active) return;
        if (resp.status === 503) {
          settle({ state: 'unconfigured', status: null, receivedAt: Date.now() });
          return;
        }
        if (!resp.ok) {
          settle({ state: 'error', status: null, receivedAt: Date.now() });
          return;
        }
        const data = (await resp.json()) as LiveAudioStatus;
        settle({
          state: 'ok',
          status: { translations: data.translations ?? [], presence: data.presence ?? null },
          receivedAt: Date.now(),
        });
      } catch {
        // Network blip or the server going away — both mean we can't see the session.
        settle({ state: 'error', status: null, receivedAt: Date.now() });
      }
    };

    void poll();
    const id = setInterval(() => void poll(), intervalMs);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [docId, intervalMs]);

  return result.docId === docId ? result : LOADING;
}
