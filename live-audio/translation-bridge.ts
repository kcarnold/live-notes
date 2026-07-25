/**
 * TranslationBridge: Connects a LiveKit room to a Gemini Live API WebSocket
 * for real-time audio translation.
 *
 * Each bridge instance:
 * 1. Joins the LiveKit room as a bot participant (e.g., "translator-es")
 * 2. Subscribes to the organizer's audio track
 * 3. Pipes PCM audio frames to Gemini Live API via WebSocket
 * 4. Receives translated audio back and publishes it as a new track
 *
 * Both sides of the bridge drop connections, and each is defended differently:
 *
 * - **Gemini** periodically terminates the session (duration/context limits, routine
 *   resets). The bridge listens for the `goAway` warning and reconnects
 *   make-before-break — it opens a replacement socket while the old one is still
 *   serving audio, then swaps once the new one is ready. Unexpected closures fall back
 *   to a backoff reconnect. When the overlap fails (the old socket dies before the
 *   replacement finishes setup, e.g. a short `goAway` lead time), input frames are
 *   buffered during the gap and flushed into the fresh session on setup, so a swap
 *   costs a little latency on that segment rather than dropped words. The same buffer
 *   covers the setup latency when the socket is reopened after a silence suspend.
 * - **LiveKit** does full reconnects that silently rebuild remote track state, which
 *   twice left the bridge `active` but receiving no audio at all. The organizer
 *   subscription is therefore rebuildable (`Reconnected` re-drives it) and watched (a
 *   stall watchdog recovers a silent input whatever the cause).
 *
 * The whole lifecycle is reported via the injected `recordEvent` telemetry sink so we
 * can see how often sessions drop and how long any gap lasts.
 *
 * "Active but deaf" is the failure mode this file is shaped around; the incident
 * history and the reasoning behind each layer are in docs/live-audio-resilience.md.
 */

import {
  Room,
  RoomEvent,
  LocalAudioTrack,
  AudioSource,
  AudioFrame,
  DisconnectReason,
  TrackPublishOptions,
  TrackSource,
  RemoteTrackPublication,
  RemoteParticipant,
  RemoteAudioTrack,
  TrackKind,
  AudioStream,
  SimulateScenarioKind,
} from "@livekit/rtc-node";
// RemoteTrack is a type-only export (a union alias), so it must not be imported as a value —
// tsc accepts it either way, but ESM fails at runtime with "does not provide an export named".
import type { RemoteTrack } from "@livekit/rtc-node";
import WebSocket from "ws";
import type { TranscriptWriter } from "./transcript-writer.ts";

export type BridgeStatus = "starting" | "active" | "error" | "closed";

/** The Gemini leg's state, derived for reporting (see health()). */
export type GeminiLegState = "ready" | "connecting" | "backoff" | "suspended" | "down";

/**
 * Composite health snapshot. `status` alone is a single word that has twice read
 * "active" through an outage; this is the honest version, surfaced by the status
 * endpoint so dashboards and the supervisor can see which leg is actually unwell.
 */
export interface BridgeHealth {
  status: BridgeStatus;
  gemini: GeminiLegState;
  /** Last time an organizer audio frame entered the bridge (0 = never). */
  lastInputFrameAt: number;
  /** Last time translated audio was published to LiveKit (0 = never). */
  lastOutputFrameAt: number;
  reconnects: number;
  /** Gap-buffer depth right now — current added latency in frames. */
  bufferedFrames: number;
}

/** Records a telemetry event. Implemented in the server over the PostHog client. */
export type RecordEvent = (
  event: string,
  properties: Record<string, unknown>
) => void;

/**
 * What prompted a reconnect, for telemetry.
 *   - goaway/close: the Gemini session died and we're re-establishing it.
 *   - resume: the mic went from silence back to speech, so we're re-opening the
 *     socket we tore down to avoid paying to translate silence.
 */
export type ReconnectTrigger = "goaway" | "close" | "resume";

// Organizer audio arrives in 100ms frames, so a gap this long means the input is dead,
// not merely quiet. Recovery is attempted no more than once per stall window.
const INPUT_STALL_MS = 15_000;
const STALL_CHECK_INTERVAL_MS = 5_000;
// Reconcile is the watchdog's level-1 recovery; this is level 2. If this many
// consecutive stall windows pass with an apparently-live (unmuted, published) organizer
// mic and still no frames, reconcile isn't fixing it — tear the bridge down so demand
// (a listener re-requesting the language) recreates it from scratch, which is what the
// manual redeploy did in the 2026-07-12 outage. A muted or unpublished mic never
// escalates: that silence is expected, and recreating wouldn't (and shouldn't) end it.
const STALL_ESCALATE_AFTER = 3;

// Exponential-backoff bounds for failed Gemini reconnect attempts (mirrors the
// Proclaim service's convention; see PROCLAIM_INTEGRATION.md).
const RECONNECT_BACKOFF = { initialMs: 1_000, maxMs: 30_000 };

// Silence gating uses two thresholds, because "have we been silent long enough to
// stop paying?" and "is there any sound here worth keeping?" want opposite biases.
//
// The *voice* bar (per-bridge, `silenceThresholdDbfs`) drives the suspend clock and
// the resume trigger: only clear speech keeps the session alive / wakes it, so room
// tone doesn't burn money and faint noise doesn't wake it to hallucinate on nothing.
// That bar is also the feature's only switch. At SILENCE_GATING_OFF_DBFS every frame
// reads as voice, so the suspend clock can never elapse and the bridge is a plain
// always-on session — there is no second boolean to keep in sync with it, and no
// configuration in which some of the gating machinery is live and the rest isn't.
// SILENCE_THRESHOLD_DBFS is the level to use when you do want gating.
//
// SILENCE_FLOOR_DBFS (the *dead-air* floor, well below the voice bar) is the only
// thing the gap-collapse is allowed to drop. An unvoiced consonant (/s/, /f/, a
// plosive burst diluted across a 100 ms frame) can read below the voice bar but sits
// far above this floor, so it is always kept — we never trade a clipped consonant
// for lower latency. Only genuine near-digital dead air collapses. It belongs to the
// reconnect buffer, not to gating, so it stays fixed however the voice bar is set.
export const SILENCE_THRESHOLD_DBFS = -30;
// Gating off. `frameRmsDbfs` bottoms out at -Infinity for pure digital silence, and
// the voice test is `>=`, so at this bar even a frame of zeroes counts as voice.
export const SILENCE_GATING_OFF_DBFS = -Infinity;
export const SILENCE_FLOOR_DBFS = -50;
const SILENCE_SUSPEND_MS = 30_000;
const SILENCE_CHECK_INTERVAL_MS = 5_000;

// Input frames are 100 ms (AudioStream `frameSizeMs`). When the Gemini socket is
// briefly unavailable — a reconnect gap where the old session closed before its
// replacement finished setup, or the setup latency right after a silence resume — we
// buffer input frames instead of dropping them, then flush them into the fresh
// session once it's ready. So a session swap costs a little added latency on that
// segment rather than clipped/lost words. Only frames that were never sent are
// buffered, so nothing is ever sent twice and the transcript is never duplicated.
// The buffer is bounded so a long outage can't grow it without limit; a short
// pre-roll of the frames just before speech resumes gives the new session onset.
const INPUT_FRAME_MS = 100;
const MAX_BUFFERED_FRAMES = Math.round(4_000 / INPUT_FRAME_MS);
// Pre-roll kept before the resume trigger, so an onset consonant that reads below
// the voice bar (and so doesn't itself trigger resume) is still carried into the
// fresh session by the flush rather than clipped.
const SILENCE_PREROLL_FRAMES = Math.round(500 / INPUT_FRAME_MS);

// Flushing the backlog into a fresh session leaves that segment running a little
// behind live, and Gemini processes input at ~1x, so the lag doesn't drain on its
// own. But dead air carries no words: we collapse runs of below-floor silence in the
// gap backlog beyond this many consecutive frames, keeping short pauses as
// utterance-boundary cues. Since speech has natural gaps, a swap that lands in a
// pause then costs almost no added latency, and the recovered lag is bounded by how
// much actual speech occurred during the gap. Only below-floor frames collapse, so a
// faint consonant is never dropped for latency (see SILENCE_FLOOR_DBFS).
const MAX_GAP_SILENCE_FRAMES = Math.round(300 / INPUT_FRAME_MS);

/**
 * RMS level of a PCM16 frame in dBFS (0 dBFS = a full-scale 32768 amplitude).
 * Returns -Infinity for pure digital silence. Used to decide whether the
 * organizer's mic is carrying speech or just room tone.
 */
export function frameRmsDbfs(data: Int16Array): number {
  if (data.length === 0) return -Infinity;
  let sumSquares = 0;
  for (let i = 0; i < data.length; i++) {
    const s = data[i];
    sumSquares += s * s;
  }
  const rms = Math.sqrt(sumSquares / data.length);
  if (rms === 0) return -Infinity;
  return 20 * Math.log10(rms / 32768);
}

/**
 * Whether a PCM16 frame counts as silence at the given dBFS threshold. Defined
 * strictly (a low threshold) so real — even quiet — speech is never mistaken for
 * silence; only genuine room tone falls below it.
 */
export function isSilentFrame(
  data: Int16Array,
  thresholdDbfs: number = SILENCE_THRESHOLD_DBFS
): boolean {
  return frameRmsDbfs(data) < thresholdDbfs;
}

/**
 * Read the voice bar from its env value (`LIVE_AUDIO_SILENCE_THRESHOLD_DBFS`), in
 * dBFS. Unset — or anything non-finite, including a literal "-Infinity" — means
 * gating off, so the cost path is opted into by naming a level (e.g. `-30`) and
 * never arrives by accident. Note the sign: dBFS is negative below full scale, so
 * a *higher* bar gates more aggressively and `0` would treat all real speech as
 * silence. That's the opposite of off.
 */
export function parseSilenceThresholdDbfs(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return SILENCE_GATING_OFF_DBFS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : SILENCE_GATING_OFF_DBFS;
}

/**
 * Parse the `timeLeft` from a Gemini `goAway` message into milliseconds. The wire
 * shape is unconfirmed for the translate model (the raw value is logged), so this
 * tolerates a protobuf Duration string ("10s", "10.5s"), a bare number of seconds,
 * or an expanded `{ seconds, nanos }` object. Returns null if it can't be parsed.
 */
export function parseGoAwayTimeLeftMs(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return isFinite(raw) ? Math.round(raw * 1000) : null;
  if (typeof raw === "string") {
    const m = raw.trim().match(/^([\d.]+)\s*s?$/);
    return m ? Math.round(parseFloat(m[1]) * 1000) : null;
  }
  if (typeof raw === "object") {
    const o = raw as { seconds?: number | string; nanos?: number | string };
    const secs = o.seconds != null ? Number(o.seconds) : NaN;
    if (isNaN(secs)) return null;
    return Math.round(secs * 1000 + Number(o.nanos ?? 0) / 1e6);
  }
  return null;
}

/**
 * Equal-jitter exponential backoff: half the capped delay plus a random half, so
 * concurrent bridges don't reconnect in lockstep. Result is in [cap/2, cap] where
 * cap = min(maxMs, initialMs * 2^attempt).
 */
export function nextBackoffMs(
  attempt: number,
  opts: { initialMs: number; maxMs: number } = RECONNECT_BACKOFF
): number {
  const cap = Math.min(opts.maxMs, opts.initialMs * 2 ** Math.max(0, attempt));
  return Math.round(cap / 2 + Math.random() * (cap / 2));
}

/**
 * Minimal structural views of the LiveKit room objects the subscription decision
 * touches, so the decision can be unit-tested with tiny fakes (no live `Room`).
 */
export interface AudioPublicationLike {
  /** TrackKind in production; a predicate (`isAudio`) decides what counts as audio. */
  kind: unknown;
  /** Manually subscribe/unsubscribe (autoSubscribe is off on the bridge's room). */
  setSubscribed(subscribed: boolean): void;
}
export interface AudioParticipantLike {
  identity: string;
  trackPublications: Iterable<[string, AudioPublicationLike]>;
}

/**
 * Subscribe to every organizer audio publication in the room *right now*. Returns how
 * many publications it acted on, which is the bridge's "am I actually wired up?" signal.
 *
 * This is a **reconcile**, not an event handler: it takes the room's current state and
 * drives it toward the desired state, and it is idempotent (`setSubscribed(true)` on an
 * already-subscribed publication is a no-op). Callers re-run it whenever the participant
 * list could have changed and never have to reason about *which* change happened.
 *
 * That shape is the fix for two production outages, both of which left the bridge
 * `active` but receiving no audio at all — "active but deaf", which nothing throws on
 * and nothing notices. Both were the same mistake: subscription was decided *once*, from
 * an event, and the decision then drifted from reality.
 *
 *   - Outage 1 (publish race): the organizer was in the room but published their mic a
 *     beat later, and the code that handled "organizer is here" took an early return
 *     before registering a listener for "organizer published something".
 *   - Outage 2 (full reconnect): LiveKit rebuilt the session, re-creating remote
 *     participants and their tracks as *new objects*. Per LiveKit's documented sequence a
 *     full reconnect emits `ParticipantConnected` for everyone already in the room — but
 *     **no `TrackPublished`** for their existing publications. So neither the startup
 *     enumeration nor the publish listener ever fired again, and the bridge streamed
 *     silence to Gemini for six minutes.
 *
 * Reconciling is convergent rather than event-exhaustive: being wrong about any single
 * event costs nothing so long as some later trigger re-runs this. Enumerating events
 * correctly is a game we have now lost twice; this stops playing it. (The frontend's
 * ListenViewer already worked this way — re-running subscription on participant changes —
 * which is exactly why attendees kept hearing the speaker while the bridges went deaf.)
 *
 * Kept pure (no `Room`, no LiveKit enums) so the timing cases are unit-testable.
 */
export function reconcileOrganizerAudio(params: {
  organizerIdentity: string;
  participants: Iterable<AudioParticipantLike>;
  isAudio: (pub: AudioPublicationLike) => boolean;
}): number {
  let subscribed = 0;
  for (const participant of params.participants) {
    if (participant.identity !== params.organizerIdentity) continue;
    for (const [, pub] of participant.trackPublications) {
      if (!params.isAudio(pub)) continue;
      pub.setSubscribed(true);
      subscribed++;
    }
  }
  return subscribed;
}

/**
 * Should the bridge try to recover a silent audio input?
 *
 * Organizer audio arrives on a fixed 100ms cadence, so its absence is unambiguous: if
 * we've received audio before but none for `stallMs`, the input is dead — whatever the
 * cause. The cooldown means a genuinely muted speaker yields one telemetry event rather
 * than a retry storm.
 *
 * `lastFrameAt === 0` (never received any audio) is *not* a stall: that's the startup
 * case, which the subscription wiring already covers, and firing here would fight it.
 */
export function shouldRecoverStalledInput(params: {
  now: number;
  lastFrameAt: number;
  lastRecoveryAt: number;
  stallMs: number;
}): boolean {
  const { now, lastFrameAt, lastRecoveryAt, stallMs } = params;
  if (lastFrameAt === 0) return false;
  if (now - lastFrameAt < stallMs) return false;
  return now - lastRecoveryAt >= stallMs;
}

export class TranslationBridge {
  private room: Room | null = null;
  private geminiWs: WebSocket | null = null;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private publishedTrackSid: string = "";
  private framesSentToGemini: number = 0;
  private framesReceivedFromGemini: number = 0;

  public readonly targetLanguage: string;
  public readonly sessionId: string;
  public readonly identity: string;
  public status: BridgeStatus = "starting";
  public subscriberCount: number = 0;

  // Gemini Live API config
  private readonly geminiApiKey: string;
  private readonly geminiModel: string = "gemini-3.5-live-translate-preview";
  private readonly sampleRate: number = 24000; // Gemini outputs 24kHz
  private readonly inputSampleRate: number = 16000; // Gemini Live expects 16kHz input
  private readonly channels: number = 1;

  // LiveKit config
  private readonly livekitUrl: string;
  private readonly livekitApiKey: string;
  private readonly livekitApiSecret: string;

  // Whether the *current* (this.geminiWs) socket has finished setup and can take audio.
  private geminiSetupComplete: boolean = false;
  private organizerIdentity: string;
  private lastAudioFrameTime: number = 0;
  private captureChain: Promise<void> = Promise.resolve();

  // Silence gating. `suspended` means we've torn down the Gemini socket because the
  // mic has been silent (the LiveKit participant/track stay live). `lastVoiceAt` is
  // the last time a non-silent input frame arrived; the monitor suspends once it's
  // older than SILENCE_SUSPEND_MS, and the first non-silent frame resumes.
  private suspended: boolean = false;
  private lastVoiceAt: number = 0;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;

  // Undelivered input frames awaiting a ready socket, flushed on setupComplete.
  // Only ever holds frames that were never sent, so flushing can't duplicate audio.
  private pendingFrames: Int16Array[] = [];
  // Consecutive silent frames currently at the tail of the gap backlog, used to
  // collapse dead air (see MAX_GAP_SILENCE_FRAMES).
  private bufferedSilenceRun: number = 0;

  // Teardown epoch. Incremented whenever the Gemini side is torn down (stop, room
  // failure, silence suspend), and captured by every socket's handlers when the
  // socket is wired. A handler whose epoch is stale — its socket belongs to a life
  // the bridge has already left — is dropped instead of acting, which closes the
  // whole "async callback fires in a state it wasn't written for" class (e.g. a
  // setupComplete racing a suspend and swapping a paid-for socket into a bridge
  // that believes it has none).
  private epoch: number = 0;

  // Reconnect state. `pendingWs` is a replacement socket being established (during
  // a make-before-break swap or a backoff retry); `reconnecting` guards against
  // launching two overlapping reconnects (e.g. goAway then the actual close).
  private pendingWs: WebSocket | null = null;
  private reconnecting: boolean = false;
  private reconnectCount: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionConnectedAt: number = 0;
  private framesDroppedWhileDown: number = 0;

  // Organizer-audio liveness. The bridge's defining failure mode is going deaf while
  // staying `active` (see docs/live-audio-resilience.md), so the input side is
  // continuously reconciled and watched. `pipedTracks` dedupes piping (TrackSubscribed
  // can be delivered redundantly) and is cleared when a track's stream ends, so a
  // re-subscribed track pipes again. `lastOrganizerFrameAt` is the liveness signal
  // (0 = no organizer audio has ever arrived).
  private pipedTracks: Set<RemoteAudioTrack> = new Set();
  private lastOrganizerFrameAt: number = 0;
  private lastStallRecoveryAt: number = 0;
  private stallWatchdog: ReturnType<typeof setInterval> | null = null;
  // Stall windows in a row where reconcile didn't bring frames back (see
  // STALL_ESCALATE_AFTER). Reset whenever frames arrive or the mic reads muted.
  private consecutiveStallRecoveries: number = 0;

  // Persists finalized transcript segments into the shared Yjs doc.
  private readonly writer: TranscriptWriter | null;
  // Whether this bridge also writes the source-language (English) transcript,
  // via Gemini input transcription. Only the primary bridge does, so the same
  // English text isn't appended once per running language.
  private readonly writesSourceTranscript: boolean;
  // Telemetry sink (PostHog, injected by the server). Null in tests / when unset.
  private readonly recordEvent: RecordEvent | null;
  // The voice bar, in dBFS — the cost path's only knob. At SILENCE_GATING_OFF_DBFS
  // (the default) every frame reads as voice, so the bridge never suspends and is a
  // plain always-on session. The goaway/reconnect buffering is independent of this
  // and always active.
  private readonly silenceThresholdDbfs: number;

  // The source (input) transcript is published under this language code.
  static readonly SOURCE_CODE = "en";

  constructor(
    sessionId: string,
    targetLanguage: string,
    organizerIdentity: string,
    config: {
      geminiApiKey: string;
      livekitUrl: string;
      livekitApiKey: string;
      livekitApiSecret: string;
      writer?: TranscriptWriter | null;
      writesSourceTranscript?: boolean;
      recordEvent?: RecordEvent | null;
      silenceThresholdDbfs?: number;
    }
  ) {
    this.sessionId = sessionId;
    this.targetLanguage = targetLanguage;
    this.organizerIdentity = organizerIdentity;
    this.identity = `translator-${targetLanguage}`;
    this.geminiApiKey = config.geminiApiKey;
    this.livekitUrl = config.livekitUrl;
    this.livekitApiKey = config.livekitApiKey;
    this.livekitApiSecret = config.livekitApiSecret;
    this.writer = config.writer ?? null;
    this.writesSourceTranscript = config.writesSourceTranscript ?? false;
    this.recordEvent = config.recordEvent ?? null;
    this.silenceThresholdDbfs = config.silenceThresholdDbfs ?? SILENCE_GATING_OFF_DBFS;
  }

  /**
   * The Gemini leg's current state, derived from the connection fields rather than
   * stored — so it can't drift from them. Reporting only; no behavior reads this.
   */
  private geminiLegState(): GeminiLegState {
    if (this.suspended) return "suspended";
    if (this.geminiWs && this.geminiSetupComplete) return "ready";
    if (this.pendingWs) return "connecting";
    if (this.reconnectTimer) return "backoff";
    return "down";
  }

  /** Composite health snapshot for the status endpoint / supervisor / dashboards. */
  health(): BridgeHealth {
    return {
      status: this.status,
      gemini: this.geminiLegState(),
      lastInputFrameAt: this.lastOrganizerFrameAt,
      lastOutputFrameAt: this.lastAudioFrameTime,
      reconnects: this.reconnectCount,
      bufferedFrames: this.pendingFrames.length,
    };
  }

  /** Emit a telemetry event tagged with this bridge's language and identity. */
  private record(event: string, properties: Record<string, unknown> = {}): void {
    if (!this.recordEvent) return;
    console.log(`[TranslationBridge:${this.targetLanguage}] telemetry: ${event}`, properties);
    this.recordEvent(event, {
      targetLanguage: this.targetLanguage,
      identity: this.identity,
      ...properties,
    });
  }

  async start(): Promise<void> {
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Starting bridge for session ${this.sessionId} (telemetry: ${this.recordEvent ? 'enabled' : 'DISABLED'})`
    );

    try {
      // 1. Generate token and join LiveKit room
      await this.joinLiveKitRoom();

      // 2. Connect to Gemini Live API
      await this.connectGemini();

      // 3. Subscribe to organizer's audio and wire up the pipeline
      await this.subscribeToOrganizer();

      this.status = "active";
      // Start the silence clock now so an organizer who joins but never speaks
      // still suspends after the grace window rather than immediately. Unconditional:
      // the monitor itself no-ops when the voice bar is off.
      this.lastVoiceAt = Date.now();
      this.startSilenceMonitor();
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Bridge is active`
      );
    } catch (error) {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Failed to start:`,
        error
      );
      this.status = "error";
      throw error;
    }
  }

  /**
   * Force a LiveKit reconnection scenario on this bridge's room. **Testing only.**
   *
   * A full reconnect is what caused the 2026-07-12 outage, and it is not something you can
   * wait for: it's the SDK's escalation when a resume fails, triggered by server-side
   * events, not by elapsed time. Without this, verifying the fix means running a service and
   * hoping. With it, the check takes seconds and can be repeated.
   *
   * This is also the only way to test the fix against the *real* SDK rather than against our
   * model of it — the e2e fakes encode our reading of LiveKit's documented reconnect
   * sequence, and this is what confirms that reading is right.
   */
  async simulateScenario(kind: SimulateScenarioKind): Promise<void> {
    if (!this.room) throw new Error("Bridge is not connected to a room");
    console.warn(
      `[TranslationBridge:${this.targetLanguage}] Simulating LiveKit scenario ${SimulateScenarioKind[kind] ?? kind}`
    );
    this.record("livekit_scenario_simulated", {
      scenario: SimulateScenarioKind[kind] ?? String(kind),
    });
    await this.room.simulateScenario(kind);
  }

  async stop(): Promise<void> {
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Stopping bridge`
    );
    this.status = "closed";

    // Stop the silence monitor so it can't suspend/resume after teardown.
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.stallWatchdog) {
      clearInterval(this.stallWatchdog);
      this.stallWatchdog = null;
    }
    this.pipedTracks.clear();

    this.teardownGeminiSide();

    if (this.room) {
      await this.room.disconnect();
      this.room = null;
    }

    this.audioSource = null;
    this.localTrack = null;
    this.suspended = false;
  }

  /**
   * Close the Gemini side completely: the active socket, any pending replacement, any
   * scheduled retry, and the gap buffer. Used by stop() and by failure paths (room
   * disconnect, watchdog escalation) where the bridge is done but must not leave a
   * paid-for socket behind. The sockets' close handlers see a non-active status (or
   * suspended) and won't reconnect.
   */
  private teardownGeminiSide(): void {
    this.epoch++;
    this.reconnecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pendingWs) {
      this.pendingWs.close();
      this.pendingWs = null;
    }
    if (this.geminiWs) {
      this.geminiWs.close();
      this.geminiWs = null;
    }
    this.geminiSetupComplete = false;
    this.pendingFrames = [];
    this.bufferedSilenceRun = 0;
  }

  private async joinLiveKitRoom(): Promise<void> {
    // Generate a token for the bot participant using the server SDK
    const { AccessToken } = await import("livekit-server-sdk");

    const at = new AccessToken(this.livekitApiKey, this.livekitApiSecret, {
      identity: this.identity,
      name: `Translator (${this.targetLanguage.toUpperCase()})`,
    });

    at.addGrant({
      roomJoin: true,
      room: this.sessionId,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    // Create and connect to the room
    this.room = new Room();

    this.room.on(RoomEvent.Disconnected, (reason: DisconnectReason) => {
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Disconnected from room (reason: ${DisconnectReason[reason] ?? reason})`
      );
      this.record("livekit_disconnected", { reason: DisconnectReason[reason] ?? String(reason) });
      // stop() disconnects the room deliberately, with status already "closed" — done.
      if (this.status === "closed") return;
      // Any other disconnect (duplicate identity, LiveKit server restart, connectivity
      // loss past the SDK's resume) is a failure. "error" marks the bridge recreatable —
      // ensureBridge treats it as stale, and listeners re-request the language when they
      // see the translator gone. Drop the Gemini side too, so the bridge can't linger as
      // a zombie holding a paid-for session that no audio will ever reach.
      this.status = "error";
      this.teardownGeminiSide();
    });

    this.room.on(RoomEvent.Reconnecting, () => {
      console.log(`[TranslationBridge:${this.targetLanguage}] LiveKit reconnecting`);
      this.record("livekit_reconnecting");
    });

    // A *full* reconnect (the 2026-07-12 outage) rebuilds session state: remote
    // participants and their tracks come back as new objects and the old AudioStream
    // ends. Recovery is not handled here — it falls out of the reconcile triggers wired
    // in subscribeToOrganizer, which is the point of that shape.
    this.room.on(RoomEvent.Reconnected, () => {
      console.log(`[TranslationBridge:${this.targetLanguage}] LiveKit reconnected`);
      this.record("livekit_reconnected");
    });

    // Not load-bearing, but this is the vocabulary the next incident will be read in:
    // the last one had to be reconstructed from frame-count arithmetic because the
    // bridge subscribed to three room events and depended on nine.
    this.room.on(
      RoomEvent.TrackUnsubscribed,
      (_track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (participant.identity !== this.organizerIdentity) return;
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Organizer audio track unsubscribed`
        );
        this.record("livekit_organizer_track_unsubscribed");
      }
    );

    this.room.on(
      RoomEvent.TrackSubscriptionFailed,
      (trackSid: string, participant: RemoteParticipant, reason?: string) => {
        console.error(
          `[TranslationBridge:${this.targetLanguage}] Track subscription failed (sid: ${trackSid}, participant: ${participant.identity}): ${reason ?? "unknown"}`
        );
        this.record("livekit_track_subscription_failed", {
          trackSid,
          participantIdentity: participant.identity,
          reason: reason ?? "unknown",
        });
      }
    );

    this.room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      if (participant.identity !== this.organizerIdentity) return;
      console.log(`[TranslationBridge:${this.targetLanguage}] Organizer left the room`);
      this.record("livekit_organizer_disconnected");
    });

    await this.room.connect(this.livekitUrl, token, {
      autoSubscribe: false,
      dynacast: false,
    });

    console.log(
      `[TranslationBridge:${this.targetLanguage}] Joined room as ${this.identity}`
    );

    // Create an AudioSource to publish translated audio
    // Gemini outputs 24kHz mono PCM
    this.audioSource = new AudioSource(this.sampleRate, this.channels);
    this.localTrack = LocalAudioTrack.createAudioTrack(
      `translated-audio-${this.targetLanguage}`,
      this.audioSource
    );

    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;

    await this.room.localParticipant!.publishTrack(
      this.localTrack,
      publishOptions
    );

    // Save published track SID for transcription
    const pubs = this.room.localParticipant!.trackPublications;
    for (const [, pub] of pubs) {
      if (pub.track === this.localTrack) {
        this.publishedTrackSid = pub.sid || "";
        break;
      }
    }

    console.log(
      `[TranslationBridge:${this.targetLanguage}] Published translated audio track (sid: ${this.publishedTrackSid || 'pending'})`
    );
  }

  private geminiWsUrl(): string {
    return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.geminiApiKey}`;
  }

  /** Open the initial Gemini socket and resolve once its setup completes. */
  private async connectGemini(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.geminiWsUrl());
      this.geminiWs = ws;
      this.wireGeminiSocket(ws, { role: "initial", onInitialError: reject });

      const checkSetup = setInterval(() => {
        if (this.geminiSetupComplete) {
          clearInterval(checkSetup);
          resolve();
        }
      }, 100);

      setTimeout(() => {
        if (!this.geminiSetupComplete) {
          clearInterval(checkSetup);
          reject(new Error("Gemini setup timeout"));
        }
      }, 15000);
    });
  }

  /**
   * Attach handlers to a Gemini socket. Used for both the initial connection and
   * reconnect replacements, so their behavior never diverges. A "pending"
   * replacement is swapped in as the active socket once its setup completes
   * (make-before-break); content messages from any socket that isn't the current
   * `this.geminiWs` are ignored.
   */
  private wireGeminiSocket(
    ws: WebSocket,
    opts: {
      role: "initial" | "pending";
      trigger?: ReconnectTrigger;
      attempt?: number;
      onInitialError?: (err: Error) => void;
    }
  ): void {
    let openedAt = 0;
    let ready = false;
    // The life of the bridge this socket belongs to; see the epoch field.
    const wiredEpoch = this.epoch;

    ws.on("open", () => {
      openedAt = Date.now();
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Gemini WebSocket open (${opts.role})`
      );
      this.sendGeminiSetup(ws);
    });

    ws.on("message", (data: WebSocket.Data) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString());
      } catch (error) {
        console.error(
          `[TranslationBridge:${this.targetLanguage}] Error parsing Gemini message:`,
          error
        );
        return;
      }

      if (!ready) {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Gemini message (pre-setup, ${opts.role}):`,
          JSON.stringify(message).slice(0, 500)
        );
      }

      if (message.setupComplete) {
        // The bridge may have moved on while this socket was setting up — suspended
        // for silence, stopped, or failed with its room. Swapping in then would strand
        // an open, paid-for socket in a bridge that believes it has none. (status
        // "starting" is fine: that's the initial socket completing during start().)
        if (
          wiredEpoch !== this.epoch ||
          this.suspended ||
          this.status === "closed" ||
          this.status === "error"
        ) {
          console.log(
            `[TranslationBridge:${this.targetLanguage}] Dropping stale setupComplete (${opts.role})`
          );
          this.record("gemini_stale_socket_dropped", { role: opts.role, trigger: opts.trigger });
          try {
            ws.close();
          } catch {
            // already closing
          }
          return;
        }
        ready = true;
        this.onSocketReady(ws, opts.role, openedAt ? Date.now() - openedAt : 0, opts.trigger);
        return;
      }

      // Only the active socket's content drives audio/transcript output.
      if (ws !== this.geminiWs) return;
      this.processServerContent(message);
    });

    ws.on("error", (error) => {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Gemini WebSocket error (${opts.role}):`,
        error
      );
      if (opts.role === "initial" && !ready) {
        opts.onInitialError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason.toString();
      const wasActive = ws === this.geminiWs;
      const wasPending = ws === this.pendingWs;
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Gemini WebSocket closed (${opts.role})`,
        { code, reason: reasonStr, wasActive, wasPending }
      );
      this.record("gemini_session_closed", {
        code,
        reason: reasonStr,
        role: opts.role,
        wasActive,
        wasPending,
        socketLifetimeMs: openedAt ? Date.now() - openedAt : 0,
        framesSent: this.framesSentToGemini,
        framesReceived: this.framesReceivedFromGemini,
        totalReconnects: this.reconnectCount,
      });

      if (opts.role === "initial" && !ready) {
        opts.onInitialError?.(
          new Error(`Gemini WebSocket closed before setup: code=${code} reason=${reasonStr}`)
        );
        return;
      }

      // While suspended for silence we deliberately closed the socket and nulled
      // `geminiWs`; the resume path reopens it. Don't treat that as a session drop.
      if (this.status !== "active" || this.suspended) return;

      if (wasActive) {
        // The live session died (with or without a goAway). Stop sending audio to
        // the dead socket and reconnect (no-op if a goAway replacement is already
        // in flight).
        this.geminiSetupComplete = false;
        this.beginReconnect("close");
      } else if (wasPending) {
        // A replacement died before it could take over — retry with backoff,
        // keeping `reconnecting` set so we don't also start a parallel attempt.
        this.pendingWs = null;
        const attempt = (opts.attempt ?? 0) + 1;
        const trigger = opts.trigger ?? "close";
        const backoffMs = nextBackoffMs(attempt);
        this.record("gemini_reconnect_retry", { trigger, attempt, backoffMs });
        this.reconnectTimer = setTimeout(() => this.openReplacement(trigger, attempt), backoffMs);
      }
      // A stale socket we already swapped away from: nothing to do.
    });
  }

  /** Promote a socket to active once its setup completes. */
  private onSocketReady(
    ws: WebSocket,
    role: "initial" | "pending",
    setupLatencyMs: number,
    trigger?: ReconnectTrigger
  ): void {
    this.sessionConnectedAt = Date.now();
    this.geminiSetupComplete = true;

    if (role === "pending") {
      const old = this.geminiWs;
      this.geminiWs = ws;
      this.pendingWs = null;
      this.reconnecting = false;
      this.reconnectCount++;
      if (old && old !== ws) {
        try {
          old.close();
        } catch {
          // already closing
        }
      }
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Gemini reconnect setup complete — swapped in (trigger=${trigger}, total=${this.reconnectCount})`
      );
      this.record("gemini_session_setup_complete", {
        isReconnect: true,
        trigger,
        totalReconnects: this.reconnectCount,
        setupLatencyMs,
      });
    } else {
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Gemini setup complete`
      );
      this.record("gemini_session_setup_complete", {
        isReconnect: false,
        totalReconnects: 0,
        setupLatencyMs,
      });
    }

    this.flushPendingFrames();
  }

  /** Start a reconnect unless one is already in flight. */
  private beginReconnect(trigger: ReconnectTrigger): void {
    if (this.reconnecting || this.status !== "active") return;
    this.reconnecting = true;
    this.openReplacement(trigger, 0);
  }

  /** Open a replacement socket; it swaps in once its setup completes. */
  private openReplacement(trigger: ReconnectTrigger, attempt: number): void {
    this.reconnectTimer = null;
    if (this.status !== "active" || this.suspended) {
      this.reconnecting = false;
      return;
    }
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Opening replacement Gemini socket (trigger=${trigger}, attempt=${attempt})`
    );
    this.record("gemini_reconnect_attempt", { trigger, attempt });
    const ws = new WebSocket(this.geminiWsUrl());
    this.pendingWs = ws;
    this.wireGeminiSocket(ws, { role: "pending", trigger, attempt });
  }

  /**
   * Periodically suspend the Gemini socket after a long silence. Resumption is
   * driven per-frame (the first non-silent frame reopens the socket), but this
   * timer also catches the case where the mic is muted and no frames arrive at
   * all — then `lastVoiceAt` simply stops advancing and the window elapses.
   *
   * That muted-mic path is why an off voice bar is checked here and not left to
   * fall out of the per-frame test: with no frames at all there is nothing to read
   * as voice, so the clock would elapse on a bridge that is meant never to suspend.
   * This is the one place the switch is read; everywhere else the bar is just a bar.
   */
  private startSilenceMonitor(): void {
    if (this.silenceTimer) return;
    if (this.silenceThresholdDbfs === SILENCE_GATING_OFF_DBFS) return;
    this.silenceTimer = setInterval(() => {
      if (this.status !== "active" || this.suspended) return;
      if (this.lastVoiceAt && Date.now() - this.lastVoiceAt > SILENCE_SUSPEND_MS) {
        this.suspendForSilence();
      }
    }, SILENCE_CHECK_INTERVAL_MS);
    // Don't keep the process alive solely for the silence monitor.
    this.silenceTimer.unref?.();
  }

  /**
   * Tear down the Gemini socket after a sustained silence. The LiveKit room and the
   * published translated track are left untouched, so subscribers stay connected —
   * the translated audio just goes quiet until we resume. Any in-flight reconnect is
   * cancelled: there's nothing to reconnect to while we're intentionally down.
   */
  private suspendForSilence(): void {
    if (this.suspended) return;
    const silentMs = this.lastVoiceAt ? Date.now() - this.lastVoiceAt : null;
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Suspending Gemini after ${silentMs}ms of silence`
    );
    // Set suspended before closing so the socket's close handler treats this as an
    // intentional teardown rather than a session drop to reconnect from. The shared
    // teardown also drops any stale gap buffer (from here we only keep a short
    // silence pre-roll) and bumps the epoch, so an in-flight setupComplete from
    // before the suspend can't swap a socket back in.
    this.suspended = true;
    this.teardownGeminiSide();

    this.record("gemini_suspended_silence", {
      silentMs,
      framesSent: this.framesSentToGemini,
      framesReceived: this.framesReceivedFromGemini,
    });
  }

  /**
   * Reopen the Gemini socket on the first sign of speech after a silence suspend.
   * Reuses the make-before-break reconnect path (trigger "resume"); frames that
   * arrive before the replacement finishes setup are counted as dropped, so the
   * first word after silence may be clipped by the socket setup latency.
   */
  private resumeFromSilence(): void {
    if (!this.suspended) return;
    const silentMs = this.lastVoiceAt ? Date.now() - this.lastVoiceAt : null;
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Voice detected — resuming Gemini after ${silentMs}ms of silence`
    );
    this.suspended = false;
    this.record("gemini_resumed_voice", { silentMs });
    this.beginReconnect("resume");
  }

  private sendGeminiSetup(ws: WebSocket): void {
    const setupMessage = {
      setup: {
        model: `models/${this.geminiModel}`,
        outputAudioTranscription: {},
        // Only the primary bridge transcribes the source audio (English), so the
        // English transcript is produced once regardless of how many languages run.
        ...(this.writesSourceTranscript ? { inputAudioTranscription: {} } : {}),
        generationConfig: {
          responseModalities: ["AUDIO"],
          translationConfig: {
            targetLanguageCode: this.targetLanguage,
            echoTargetLanguage: true,
          },
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
          },
        },
      },
    };

    console.log(
      `[TranslationBridge:${this.targetLanguage}] Sending Gemini setup:`,
      JSON.stringify(setupMessage, null, 2)
    );

    ws.send(JSON.stringify(setupMessage));
  }

  /** Handle a content message from the active Gemini socket. */
  private processServerContent(message: Record<string, unknown>): void {
    // goAway: the server warns before terminating. Reconnect now (make-before-break)
    // so the replacement is ready before this socket actually closes.
    const goAway = (message.goAway ?? message.go_away) as
      | { timeLeft?: unknown; time_left?: unknown }
      | undefined;
    if (goAway) {
      const raw = goAway.timeLeft ?? goAway.time_left;
      const timeLeftMs = parseGoAwayTimeLeftMs(raw);
      const sessionAgeMs = this.sessionConnectedAt ? Date.now() - this.sessionConnectedAt : null;
      console.log(`[TranslationBridge:${this.targetLanguage}] Gemini goAway received`, {
        raw,
        timeLeftMs,
        sessionAgeMs,
      });
      this.record("gemini_goaway", {
        timeLeftRaw: typeof raw === "string" ? raw : JSON.stringify(raw ?? null),
        timeLeftMs,
        sessionAgeMs,
      });
      this.beginReconnect("goaway");
      return;
    }

    // sessionResumptionUpdate: we don't resume yet, but record whether the translate
    // model even offers a handle — informs whether session resumption is worth adding.
    const sru = message.sessionResumptionUpdate ?? message.session_resumption_update;
    if (sru) {
      const o = sru as { resumable?: boolean; newHandle?: string; new_handle?: string };
      this.record("gemini_session_resumption_update", {
        resumable: !!o.resumable,
        hasHandle: !!(o.newHandle ?? o.new_handle),
      });
    }

    const serverContent = (message as { serverContent?: { modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> }; outputTranscription?: { text?: string }; inputTranscription?: { text?: string } } }).serverContent;
    const parts = serverContent?.modelTurn?.parts;

    if (parts?.length) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          this.framesReceivedFromGemini++;
          if (this.framesReceivedFromGemini <= 3 || this.framesReceivedFromGemini % 100 === 0) {
            console.log(
              `[TranslationBridge:${this.targetLanguage}] Received audio frame #${this.framesReceivedFromGemini} from Gemini (${part.inlineData.data.length} bytes base64)`
            );
          }
          // Queue frame for sequential capture (avoid promise pile-up)
          this.queueAudioFrame(part.inlineData.data);
        }
      }
    }

    // Transcription (target language): Gemini Live Translate streams a continuous
    // flow of deltas with no turnComplete, so persist each delta straight into the
    // shared Yjs transcript, which is the single source of truth for viewers.
    if (serverContent?.outputTranscription?.text) {
      this.writer?.appendDelta(this.targetLanguage, serverContent.outputTranscription.text);
    }

    // Input transcription (source language / English) — only on the primary bridge.
    if (this.writesSourceTranscript && serverContent?.inputTranscription?.text) {
      this.writer?.appendDelta(TranslationBridge.SOURCE_CODE, serverContent.inputTranscription.text);
    }
  }

  /**
   * Replay input frames buffered while the socket was down into the freshly-ready
   * session, then report any that overflowed the buffer (genuine loss). Called from
   * onSocketReady, so `this.geminiWs` is the new active socket. Because only never-
   * sent frames are buffered, this never re-sends audio — the transcript can't double.
   */
  private flushPendingFrames(): void {
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    this.bufferedSilenceRun = 0;

    if (frames.length > 0) {
      const bufferedMs = frames.length * INPUT_FRAME_MS;
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Flushing ${frames.length} buffered input frames (${bufferedMs}ms) into the fresh session`
      );
      for (const f of frames) this.sendFrameData(f);
      this.record("gemini_input_flushed", { frames: frames.length, bufferedMs });
    }

    if (this.framesDroppedWhileDown > 0) {
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Dropped ${this.framesDroppedWhileDown} input audio frames (buffer overflow) while reconnecting`
      );
      this.record("gemini_input_dropped", { frames: this.framesDroppedWhileDown });
      this.framesDroppedWhileDown = 0;
    }
  }

  /**
   * Queue an audio frame for sequential capture.
   * Chains each captureFrame call to avoid promise pile-up.
   */
  private queueAudioFrame(base64Audio: string): void {
    this.captureChain = this.captureChain.then(() =>
      this.publishTranslatedAudio(base64Audio)
    );
  }

  private async publishTranslatedAudio(base64Audio: string): Promise<void> {
    if (!this.audioSource || this.status === "closed") return;

    try {
      const pcmBuffer = Buffer.from(base64Audio, "base64");
      const int16 = new Int16Array(
        pcmBuffer.buffer,
        pcmBuffer.byteOffset,
        pcmBuffer.byteLength / 2
      );

      const frame = new AudioFrame(int16, this.sampleRate, this.channels, int16.length);
      await this.audioSource.captureFrame(frame);

      const now = Date.now();
      if (this.lastAudioFrameTime && now - this.lastAudioFrameTime > 2000) {
        const gapMs = now - this.lastAudioFrameTime;
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Audio resumed after ${gapMs}ms gap (frame #${this.framesReceivedFromGemini})`
        );
        // The user-visible "hang" duration — the headline metric for this work.
        this.record("gemini_audio_gap", { gapMs });
      }
      this.lastAudioFrameTime = now;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("InvalidState") || msg.includes("closed")) {
        console.warn(
          `[TranslationBridge:${this.targetLanguage}] AudioSource closed — stopping capture`
        );
        this.audioSource = null;
      } else {
        console.error(
          `[TranslationBridge:${this.targetLanguage}] Error capturing audio frame:`,
          error
        );
      }
    }
  }

  private async subscribeToOrganizer(): Promise<void> {
    if (!this.room) return;
    const room = this.room;

    // autoSubscribe is off, so we drive subscription ourselves — but we do it by
    // *reconciling* against the room's current state, never by trusting a single event.
    // Every trigger below runs the same idempotent reconcile; none of them is individually
    // load-bearing. That's deliberate: the two outages this bridge has had were both a
    // missing event (a late publish, then a full reconnect that re-creates participants
    // without re-emitting TrackPublished), and enumerating events correctly is a game we
    // kept losing. Missing one trigger here costs nothing as long as another still fires.
    room.on(RoomEvent.ParticipantConnected, () => this.reconcile("participant_connected"));
    room.on(RoomEvent.TrackPublished, () => this.reconcile("track_published"));
    room.on(RoomEvent.Reconnected, () => this.reconcile("reconnected"));

    // Piping is separate from subscribing: a track can be delivered to us more than once,
    // and must reach Gemini exactly once. The dedupe is cleared when a stream ends, so a
    // track that comes back after a reconnect pipes again.
    room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteAudioTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (participant.identity !== this.organizerIdentity) return;
        if (pub.kind !== TrackKind.KIND_AUDIO) return;
        if (this.pipedTracks.has(track)) return;
        this.pipedTracks.add(track);
        this.pipeTrackToGemini(track);
      }
    );

    this.reconcile("start");
    this.startStallWatchdog();
  }

  /**
   * Drive the room's subscriptions toward "we are subscribed to the organizer's audio".
   * Safe to call at any time, from any trigger, as often as we like.
   */
  private reconcile(trigger: string): void {
    if (!this.room || this.status === "closed" || this.status === "error") return;
    const subscribed = reconcileOrganizerAudio({
      organizerIdentity: this.organizerIdentity,
      participants: this.room.remoteParticipants.values(),
      isAudio: (pub) => pub.kind === TrackKind.KIND_AUDIO,
    });
    this.record("organizer_audio_reconciled", { trigger, publications: subscribed });
  }

  /**
   * Watch for a silent input. This is the layer that doesn't need to know *why* the
   * audio stopped — the previous outage's trigger was one nobody had enumerated, and
   * the next one's won't be either. Fires only once per stall window, so a genuinely
   * muted speaker produces one event rather than a retry storm.
   */
  private startStallWatchdog(): void {
    if (this.stallWatchdog) return;
    this.stallWatchdog = setInterval(() => {
      if (this.status !== "active") return;
      const now = Date.now();
      // Frames since the last recovery mean it worked — the escalation clock resets.
      if (this.lastOrganizerFrameAt > this.lastStallRecoveryAt) {
        this.consecutiveStallRecoveries = 0;
      }
      if (
        !shouldRecoverStalledInput({
          now,
          lastFrameAt: this.lastOrganizerFrameAt,
          lastRecoveryAt: this.lastStallRecoveryAt,
          stallMs: INPUT_STALL_MS,
        })
      ) {
        return;
      }
      this.lastStallRecoveryAt = now;
      const stalledMs = now - this.lastOrganizerFrameAt;

      // Level 2: reconcile has had its chances and frames never came back. Only when
      // the organizer's mic *looks* live — a muted/unpublished mic is expected silence,
      // and recreating the bridge wouldn't end it (just churn a Gemini session).
      if (this.organizerHasUnmutedAudio()) {
        this.consecutiveStallRecoveries++;
        if (this.consecutiveStallRecoveries >= STALL_ESCALATE_AFTER) {
          console.error(
            `[TranslationBridge:${this.targetLanguage}] No organizer audio for ${stalledMs}ms after ${this.consecutiveStallRecoveries} reconcile attempts — tearing down for recreation`
          );
          this.record("organizer_audio_unrecoverable", {
            stalledMs,
            recoveries: this.consecutiveStallRecoveries,
          });
          // stop() leaves the room, so listeners see the translator vanish and
          // re-request the language, which recreates the bridge from scratch.
          void this.stop();
          return;
        }
      } else {
        this.consecutiveStallRecoveries = 0;
      }

      console.warn(
        `[TranslationBridge:${this.targetLanguage}] No organizer audio for ${stalledMs}ms — reconciling subscription`
      );
      this.record("organizer_audio_stalled", { stalledMs });
      this.reconcile("stall");
    }, STALL_CHECK_INTERVAL_MS);
    // Don't hold the process open on this timer alone.
    this.stallWatchdog.unref?.();
  }

  /**
   * Does the organizer currently have an audio publication that isn't muted? Frames
   * should be flowing from such a mic, so their sustained absence marks the input
   * pipe as broken rather than merely quiet. `muted` can be undefined on some SDK
   * paths; treat unknown as live so a broken pipe is never mistaken for a muted mic.
   */
  private organizerHasUnmutedAudio(): boolean {
    if (!this.room) return false;
    for (const participant of this.room.remoteParticipants.values()) {
      if (participant.identity !== this.organizerIdentity) continue;
      for (const [, pub] of participant.trackPublications) {
        if (pub.kind !== TrackKind.KIND_AUDIO) continue;
        if (pub.muted !== true) return true;
      }
    }
    return false;
  }

  private pipeTrackToGemini(track: RemoteAudioTrack): void {
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Subscribed to organizer audio track, piping to Gemini`
    );
    this.record("organizer_audio_piped");

    const audioStream = new AudioStream(track, {
      sampleRate: this.inputSampleRate,
      numChannels: this.channels,
      frameSizeMs: 100,
    });

    // Process frames as they arrive via ReadableStream reader
    const reader = audioStream.getReader();
    const readLoop = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        this.sendAudioToGemini(value);
      }
    };

    // The stream *ending* is an event, not an exit. A bare `break` here is what made the
    // 2026-07-12 outage silent: LiveKit's full reconnect ended this stream, the loop fell
    // out, and nothing logged it. Forget the track so that if it comes back we pipe it
    // again, then reconcile in case the replacement is already sitting in the room.
    const streamClosed = (why: string) => {
      this.pipedTracks.delete(track);
      this.reconcile(why);
    };

    readLoop()
      .then(() => {
        console.warn(
          `[TranslationBridge:${this.targetLanguage}] Organizer audio stream ended`
        );
        this.record("organizer_audio_stream_ended");
        streamClosed("stream_ended");
      })
      .catch((err: Error) => {
        console.error(
          `[TranslationBridge:${this.targetLanguage}] Audio stream error:`,
          err
        );
        this.record("organizer_audio_stream_error", { message: err.message });
        streamClosed("stream_error");
      });
  }

  private sendAudioToGemini(frame: AudioFrame): void {
    // Liveness is stamped where organizer audio *enters* the bridge, before the Gemini
    // check below: a stalled Gemini socket is a different failure with its own recovery,
    // and conflating them would have the watchdog papering over the wrong pipe. Stamp on
    // every organizer frame (silence included) — the input pipe being alive is the point,
    // independent of whether this frame is voice.
    this.lastOrganizerFrameAt = Date.now();

    // Silence gating. `isVoice` (strict bar) drives the suspend clock and resume; the
    // raw level is passed on so the gap-collapse can tell a faint consonant (kept)
    // from genuine dead air (droppable).
    const dbfs = frameRmsDbfs(frame.data);
    const isVoice = dbfs >= this.silenceThresholdDbfs;
    if (isVoice) {
      this.lastVoiceAt = Date.now();
      if (this.suspended) this.resumeFromSilence();
    }

    // Still suspended → a quiet frame with no session to feed. Keep only a short
    // rolling pre-roll (so the resume flush carries the speech onset into the fresh
    // session) and send nothing — the whole point is not to pay Gemini for silence.
    if (this.suspended) {
      this.bufferFrame(frame.data, { preroll: true, dbfs });
      return;
    }

    const canSend =
      !!this.geminiWs &&
      this.geminiWs.readyState === WebSocket.OPEN &&
      this.geminiSetupComplete;

    if (canSend) {
      this.sendFrameData(frame.data);
    } else {
      // Socket down but we're meant to be live (a reconnect gap, or the setup latency
      // right after a silence resume). Buffer instead of dropping so the words aren't
      // lost — they're flushed into the fresh session on setupComplete.
      this.bufferFrame(frame.data, { preroll: false, dbfs });
    }
  }

  /**
   * Hold an undelivered input frame for later flush. `preroll` marks the intentional
   * rolling window kept during silence (bounded tightly, evictions expected);
   * otherwise it's a live gap (bounded loosely, and an eviction is genuine lost
   * speech worth counting). In a gap we collapse long runs of *below-floor* dead air
   * so the flushed backlog — and thus the catch-up latency — is mostly speech, while
   * anything above the floor (including faint consonants) is always kept. Frames are
   * copied because the AudioStream reuses the backing buffer between reads.
   */
  private bufferFrame(int16: Int16Array, opts: { preroll: boolean; dbfs: number }): void {
    if (!opts.preroll) {
      if (opts.dbfs < SILENCE_FLOOR_DBFS) {
        if (this.bufferedSilenceRun >= MAX_GAP_SILENCE_FRAMES) return; // drop dead air
        this.bufferedSilenceRun++;
      } else {
        this.bufferedSilenceRun = 0;
      }
    }

    const cap = opts.preroll ? SILENCE_PREROLL_FRAMES : MAX_BUFFERED_FRAMES;
    this.pendingFrames.push(new Int16Array(int16));
    while (this.pendingFrames.length > cap) {
      this.pendingFrames.shift();
      if (!opts.preroll) this.framesDroppedWhileDown++;
    }
  }

  /** Serialize and send one PCM16 frame to the active Gemini socket. */
  private sendFrameData(int16Data: Int16Array): void {
    if (!this.geminiWs || this.geminiWs.readyState !== WebSocket.OPEN) return;
    try {
      const buffer = Buffer.from(int16Data.buffer, int16Data.byteOffset, int16Data.byteLength);
      const base64 = buffer.toString("base64");

      this.framesSentToGemini++;
      if (this.framesSentToGemini <= 3 || this.framesSentToGemini % 500 === 0) {
        console.log(
          `[TranslationBridge:${this.targetLanguage}] Sent audio frame #${this.framesSentToGemini} to Gemini (${base64.length} bytes base64, ${int16Data.length} samples)`
        );
      }

      const message = {
        realtimeInput: {
          audio: {
            mimeType: `audio/pcm;rate=${this.inputSampleRate}`,
            data: base64,
          },
        },
      };

      this.geminiWs.send(JSON.stringify(message));
    } catch (error) {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Error sending audio to Gemini:`,
        error
      );
    }
  }
}
