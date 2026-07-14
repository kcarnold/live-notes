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
 * The Gemini session is periodically terminated by the server (duration/context
 * limits, routine resets). To keep the audio from cutting out, the bridge listens
 * for the `goAway` warning and reconnects make-before-break — it opens a
 * replacement socket while the old one is still serving audio, then swaps once the
 * new one is ready. Unexpected closures fall back to a backoff reconnect. When the
 * overlap fails (the old socket dies before the replacement finishes setup, e.g. a
 * short `goAway` lead time), input frames are buffered during the gap and flushed
 * into the fresh session on setup, so a swap costs a little latency on that segment
 * rather than dropped words. The same buffer covers the setup latency when the
 * socket is reopened after a silence suspend. The whole lifecycle is reported via
 * the injected `recordEvent` telemetry sink so we can see how often sessions drop
 * and how long any gap lasts.
 */

import {
  Room,
  RoomEvent,
  LocalAudioTrack,
  AudioSource,
  AudioFrame,
  TrackPublishOptions,
  TrackSource,
  RemoteTrackPublication,
  RemoteParticipant,
  RemoteAudioTrack,
  TrackKind,
  AudioStream,
} from "@livekit/rtc-node";
import WebSocket from "ws";
import type { TranscriptWriter } from "./transcript-writer.ts";

export type BridgeStatus = "starting" | "active" | "error" | "closed";

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

// Exponential-backoff bounds for failed Gemini reconnect attempts (mirrors the
// Proclaim service's convention; see PROCLAIM_INTEGRATION.md).
const RECONNECT_BACKOFF = { initialMs: 1_000, maxMs: 30_000 };

// Silence gating: we don't want to pay Gemini to translate a silent mic. When the
// organizer's input stays below SILENCE_THRESHOLD_DBFS for SILENCE_SUSPEND_MS, the
// Gemini socket is torn down. The LiveKit translator participant and its published
// track stay put — the translated audio simply goes quiet — so listeners never have
// to resubscribe. The socket is reopened on the very first non-silent frame.
export const SILENCE_THRESHOLD_DBFS = -30;
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
const SILENCE_PREROLL_FRAMES = Math.round(300 / INPUT_FRAME_MS);

// Flushing the backlog into a fresh session leaves that segment running a little
// behind live, and Gemini processes input at ~1x, so the lag doesn't drain on its
// own. But silence carries no words: we collapse runs of dead air in the gap
// backlog beyond this many consecutive frames, keeping short pauses as
// utterance-boundary cues. Since speech has natural gaps, a swap that lands in a
// pause then costs almost no added latency, and the recovered lag is bounded by how
// much actual speech occurred during the gap.
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
 * Wire the bridge's room so the organizer's microphone audio always reaches Gemini,
 * regardless of publish timing. This is the fix for a production outage: the old
 * code took an early return when the organizer was already in the room and so never
 * registered a future-publish listener — if the mic track landed a beat *after* the
 * bridge started (the common join/getUserMedia race), the bridge subscribed to
 * nothing and stayed active but permanently deaf.
 *
 * The decision has three parts, all of which must run every time:
 *   1. Subscribe to any organizer audio already published when we start.
 *   2. Subscribe to any organizer audio published later (`TrackPublished`).
 *   3. Pipe each subscribed organizer audio track to Gemini exactly once
 *      (`TrackSubscribed`), deduped so a track can't be piped twice.
 *
 * Kept pure (no `Room`, no LiveKit enums) so the timing cases are unit-testable.
 */
export function wireOrganizerAudioSubscription<Track>(params: {
  organizerIdentity: string;
  existingParticipants: Iterable<AudioParticipantLike>;
  isAudio: (pub: AudioPublicationLike) => boolean;
  onTrackPublished: (
    handler: (pub: AudioPublicationLike, participant: AudioParticipantLike) => void
  ) => void;
  onTrackSubscribed: (
    handler: (
      track: Track,
      pub: AudioPublicationLike,
      participant: AudioParticipantLike
    ) => void
  ) => void;
  pipe: (track: Track) => void;
}): void {
  const subscribeIfOrganizerAudio = (
    pub: AudioPublicationLike,
    participant: AudioParticipantLike
  ) => {
    if (participant.identity === params.organizerIdentity && params.isAudio(pub)) {
      pub.setSubscribed(true);
    }
  };

  // 1. Already-published organizer audio.
  for (const participant of params.existingParticipants) {
    for (const [, pub] of participant.trackPublications) {
      subscribeIfOrganizerAudio(pub, participant);
    }
  }

  // 2. Organizer audio published after we start (the case the old early return missed).
  params.onTrackPublished(subscribeIfOrganizerAudio);

  // 3. Pipe each organizer audio track once, no matter how it got subscribed.
  const piped = new Set<Track>();
  params.onTrackSubscribed((track, pub, participant) => {
    if (participant.identity !== params.organizerIdentity || !params.isAudio(pub)) return;
    if (piped.has(track)) return;
    piped.add(track);
    params.pipe(track);
  });
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

  // Reconnect state. `pendingWs` is a replacement socket being established (during
  // a make-before-break swap or a backoff retry); `reconnecting` guards against
  // launching two overlapping reconnects (e.g. goAway then the actual close).
  private pendingWs: WebSocket | null = null;
  private reconnecting: boolean = false;
  private reconnectCount: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionConnectedAt: number = 0;
  private framesDroppedWhileDown: number = 0;

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
      // Start the silence clock now so an organizer who joins but never speaks
      // still suspends after the grace window rather than immediately.
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
    this.suspended = false;
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

    this.room.on(RoomEvent.Disconnected, () => {
      console.log(
        `[TranslationBridge:${this.targetLanguage}] Disconnected from room`
      );
      this.status = "closed";
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

  /**
   * Periodically suspend the Gemini socket after a long silence. Resumption is
   * driven per-frame (the first non-silent frame reopens the socket), but this
   * timer also catches the case where the mic is muted and no frames arrive at
   * all — then `lastVoiceAt` simply stops advancing and the window elapses.
   */
  private startSilenceMonitor(): void {
    if (this.silenceTimer) return;
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
    // intentional teardown rather than a session drop to reconnect from.
    this.suspended = true;
    this.geminiSetupComplete = false;
    // Drop any stale gap buffer; from here we only keep a short silence pre-roll.
    this.pendingFrames = [];
    this.bufferedSilenceRun = 0;

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

    // autoSubscribe is off, so we drive subscription ourselves. The decision lives
    // in a pure helper (unit-tested) so publish-timing races can't silently regress:
    // it subscribes to organizer audio present now AND audio published later, and
    // pipes each track to Gemini exactly once.
    wireOrganizerAudioSubscription<RemoteAudioTrack>({
      organizerIdentity: this.organizerIdentity,
      existingParticipants: room.remoteParticipants.values(),
      isAudio: (pub) => pub.kind === TrackKind.KIND_AUDIO,
      onTrackPublished: (handler) =>
        room.on(
          RoomEvent.TrackPublished,
          (publication: RemoteTrackPublication, participant: RemoteParticipant) =>
            handler(publication, participant)
        ),
      onTrackSubscribed: (handler) =>
        room.on(
          RoomEvent.TrackSubscribed,
          (
            track: RemoteAudioTrack,
            publication: RemoteTrackPublication,
            participant: RemoteParticipant
          ) => handler(track, publication, participant)
        ),
      pipe: (track) => this.pipeTrackToGemini(track),
    });
  }

  private pipeTrackToGemini(track: RemoteAudioTrack): void {
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Subscribed to organizer audio track, piping to Gemini`
    );

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
        if (done) break;
        this.sendAudioToGemini(value);
      }
    };

    readLoop().catch((err: Error) => {
      console.error(
        `[TranslationBridge:${this.targetLanguage}] Audio stream error:`,
        err
      );
    });
  }

  private sendAudioToGemini(frame: AudioFrame): void {
    // Silence gating. Track the last non-silent frame so the monitor knows when to
    // suspend, and reopen the socket the instant speech returns after a suspend.
    const silent = isSilentFrame(frame.data);
    if (!silent) {
      this.lastVoiceAt = Date.now();
      if (this.suspended) this.resumeFromSilence();
    }

    // Still suspended → a silent frame with no session to feed. Keep only a short
    // rolling pre-roll (so the resume flush carries the speech onset into the fresh
    // session) and send nothing — the whole point is not to pay Gemini for silence.
    if (this.suspended) {
      this.bufferFrame(frame.data, { preroll: true, silent });
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
      this.bufferFrame(frame.data, { preroll: false, silent });
    }
  }

  /**
   * Hold an undelivered input frame for later flush. `preroll` marks the intentional
   * rolling window kept during silence (bounded tightly, evictions expected);
   * otherwise it's a live gap (bounded loosely, and an eviction is genuine lost
   * speech worth counting). In a gap we collapse long runs of silence so the flushed
   * backlog — and thus the catch-up latency — is mostly speech. Frames are copied
   * because the AudioStream reuses the backing buffer between reads.
   */
  private bufferFrame(int16: Int16Array, opts: { preroll: boolean; silent: boolean }): void {
    if (!opts.preroll) {
      if (opts.silent) {
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
