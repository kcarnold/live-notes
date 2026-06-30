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
 * new one is ready. Unexpected closures fall back to a backoff reconnect. The
 * whole lifecycle is reported via the injected `recordEvent` telemetry sink so we
 * can see how often sessions drop and how long any gap lasts.
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

/** What prompted a reconnect, for telemetry. */
export type ReconnectTrigger = "goaway" | "close";

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

  async stop(): Promise<void> {
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Stopping bridge`
    );
    this.status = "closed";

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

    // Find the organizer participant and subscribe to their audio
    const participants = this.room.remoteParticipants;

    for (const [, participant] of participants) {
      if (participant.identity === this.organizerIdentity) {
        this.subscribeToParticipantAudio(participant);
        return;
      }
    }

    // If organizer hasn't joined yet, wait for them
    console.log(
      `[TranslationBridge:${this.targetLanguage}] Waiting for organizer ${this.organizerIdentity}...`
    );

    // Listen for the organizer to publish their track
    this.room.on(
      RoomEvent.TrackPublished,
      (
        publication: RemoteTrackPublication,
        participant: RemoteParticipant
      ) => {
        if (
          participant.identity === this.organizerIdentity &&
          publication.kind === TrackKind.KIND_AUDIO
        ) {
          publication.setSubscribed(true);
        }
      }
    );

    // Once subscribed, pipe to Gemini
    this.room.on(
      RoomEvent.TrackSubscribed,
      (
        track: RemoteAudioTrack,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant
      ) => {
        if (
          participant.identity === this.organizerIdentity &&
          publication.kind === TrackKind.KIND_AUDIO
        ) {
          this.pipeTrackToGemini(track);
        }
      }
    );
  }

  /**
   * Manually subscribe to a participant's audio track (needed when autoSubscribe is off).
   */
  private subscribeToParticipantAudio(
    participant: RemoteParticipant
  ): void {
    for (const [, publication] of participant.trackPublications) {
      if (publication.kind === TrackKind.KIND_AUDIO) {
        // Manually subscribe — this triggers TrackSubscribed event
        publication.setSubscribed(true);
      }
    }

    // Also listen for TrackSubscribed to pipe to Gemini
    this.room!.on(
      RoomEvent.TrackSubscribed,
      (
        track: RemoteAudioTrack,
        pub: RemoteTrackPublication,
        p: RemoteParticipant
      ) => {
        if (
          p.identity === this.organizerIdentity &&
          pub.kind === TrackKind.KIND_AUDIO
        ) {
          this.pipeTrackToGemini(track);
        }
      }
    );
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
