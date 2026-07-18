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
 *   to a backoff reconnect.
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

/** Records a telemetry event. Implemented in the server over the PostHog client. */
export type RecordEvent = (
  event: string,
  properties: Record<string, unknown>
) => void;

/** What prompted a reconnect, for telemetry. */
export type ReconnectTrigger = "goaway" | "close";

// Organizer audio arrives in 100ms frames, so a gap this long means the input is dead,
// not merely quiet. Recovery is attempted no more than once per stall window.
const INPUT_STALL_MS = 15_000;
const STALL_CHECK_INTERVAL_MS = 5_000;

// Exponential-backoff bounds for failed Gemini reconnect attempts (mirrors the
// Proclaim service's convention; see PROCLAIM_INTEGRATION.md).
const RECONNECT_BACKOFF = { initialMs: 1_000, maxMs: 30_000 };

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

  // Persists finalized transcript segments into the shared Yjs doc.
  private readonly writer: TranscriptWriter | null;
  // Whether this bridge also writes the source-language (English) transcript,
  // via Gemini input transcription. Only the primary bridge does, so the same
  // English text isn't appended once per running language.
  private readonly writesSourceTranscript: boolean;
  // Telemetry sink (PostHog, injected by the server). Null in tests / when unset.
  private readonly recordEvent: RecordEvent | null;

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

    if (this.stallWatchdog) {
      clearInterval(this.stallWatchdog);
      this.stallWatchdog = null;
    }
    this.pipedTracks.clear();

    // Stop any in-flight reconnect so it doesn't resurrect the socket after teardown.
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

    if (this.room) {
      await this.room.disconnect();
      this.room = null;
    }

    this.audioSource = null;
    this.localTrack = null;
    this.geminiSetupComplete = false;
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
      this.status = "closed";
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

      if (this.status !== "active") return;

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

    this.flushDroppedFrames();
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
    if (this.status !== "active") {
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

  /** Report (and reset) any input audio dropped while the socket was down. */
  private flushDroppedFrames(): void {
    if (this.framesDroppedWhileDown > 0) {
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Dropped ${this.framesDroppedWhileDown} input audio frames while reconnecting`
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
    if (!this.room || this.status === "closed") return;
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
      console.warn(
        `[TranslationBridge:${this.targetLanguage}] No organizer audio for ${stalledMs}ms — reconciling subscription`
      );
      this.record("organizer_audio_stalled", { stalledMs });
      this.reconcile("stall");
    }, STALL_CHECK_INTERVAL_MS);
    // Don't hold the process open on this timer alone.
    this.stallWatchdog.unref?.();
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
    // and conflating them would have the watchdog papering over the wrong pipe.
    this.lastOrganizerFrameAt = Date.now();

    if (
      !this.geminiWs ||
      this.geminiWs.readyState !== WebSocket.OPEN ||
      !this.geminiSetupComplete
    ) {
      // Socket is down (e.g. mid-reconnect): this speech is lost. Count it so the
      // gap's impact is visible; flushed as a telemetry event when we recover.
      this.framesDroppedWhileDown++;
      return;
    }

    try {
      // Convert AudioFrame's Int16Array data to base64
      const int16Data = frame.data;
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
