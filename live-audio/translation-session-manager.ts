/**
 * TranslationSessionManager: Singleton that enforces "max 1 Gemini Live API
 * session per language per room" constraint, owns the per-session Yjs transcript
 * writer, and reaps idle translator bots.
 *
 * Usage:
 *   const manager = TranslationSessionManager.getInstance();
 *   manager.init({ documentManager, livekit });   // once, at server boot
 *   const bridge = await manager.getOrCreate(sessionId, targetLanguage, organizerIdentity);
 */

import type { DocumentManager } from "@y-sweet/sdk";
import { RoomServiceClient } from "livekit-server-sdk";

import { TranscriptWriter } from "./transcript-writer.ts";
import { TranslationBridge } from "./translation-bridge.ts";
import type { BridgeStatus } from "./translation-bridge.ts";

/**
 * Minimal telemetry client (structurally satisfied by the PostHog node client).
 * Kept local so the translation layer doesn't depend on posthog-node directly.
 */
export interface TelemetryClient {
  capture(args: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }): void;
}

export interface TranslationInfo {
  language: string;
  translatorIdentity: string;
  status: BridgeStatus;
  subscriberCount: number;
}

export interface SessionInfo {
  sessionId: string;
  organizerIdentity: string;
  createdAt: Date;
}

interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * A translation session is "healthy" only while it has at least one human listener
 * AND a broadcaster present. With no listeners the bots are pointless; with no
 * broadcaster there's no source audio to translate. Either way the session is dead
 * weight (and still burning a Gemini session) and should be reaped. Bot identities
 * (organizer-*, translator-*) are excluded from the listener count.
 */
export function isSessionHealthy(participantIdentities: string[]): boolean {
  const hasListener = participantIdentities.some(
    (id) => !id.startsWith("organizer-") && !id.startsWith("translator-")
  );
  const hasOrganizer = participantIdentities.some((id) => id.startsWith("organizer-"));
  return hasListener && hasOrganizer;
}

class TranslationSessionManager {
  private static instance: TranslationSessionManager;

  // The primary/default translation language. It runs whenever anyone is
  // listening and is the sole writer of the source (English) transcript.
  static readonly DEFAULT_LANGUAGE = "fr";

  private static readonly REAP_INTERVAL_MS = 30_000;
  private static readonly REAP_GRACE_MS = 60_000;

  // Map<sessionId, Map<languageCode, TranslationBridge>>
  private translations: Map<string, Map<string, TranslationBridge>> = new Map();

  // Map<sessionId, SessionInfo>
  private sessions: Map<string, SessionInfo> = new Map();

  // Map<sessionId, TranscriptWriter> — one Yjs writer per session, shared by bridges.
  private writers: Map<string, TranscriptWriter> = new Map();

  // Map<sessionId, epoch-ms> — last time the session had a listener AND a broadcaster.
  private lastHealthyAt: Map<string, number> = new Map();

  private documentManager: DocumentManager | null = null;
  private livekitConfig: LiveKitConfig | null = null;
  private telemetry: TelemetryClient | null = null;
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  private constructor() {}

  static getInstance(): TranslationSessionManager {
    if (!TranslationSessionManager.instance) {
      TranslationSessionManager.instance = new TranslationSessionManager();
    }
    return TranslationSessionManager.instance;
  }

  /**
   * Provide the dependencies the manager needs to persist transcripts and reap
   * idle bots. Called once from the server at boot.
   */
  init(opts: {
    documentManager: DocumentManager;
    livekit: LiveKitConfig;
    telemetry?: TelemetryClient;
  }): void {
    this.documentManager = opts.documentManager;
    this.livekitConfig = opts.livekit;
    this.telemetry = opts.telemetry ?? null;
    this.startReaper();
  }

  // Session management
  createSession(sessionId: string, organizerIdentity: string): SessionInfo {
    const info: SessionInfo = {
      sessionId,
      organizerIdentity,
      createdAt: new Date(),
    };
    this.sessions.set(sessionId, info);
    console.log(`[SessionManager] Created session ${sessionId} for organizer ${organizerIdentity}`);
    return info;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Ensure translation is running for a language and return its bridge.
   *
   * Always keeps the English transcript available cheaply by ensuring the
   * default/primary bridge (DEFAULT_LANGUAGE) runs while anyone is listening —
   * it is the sole writer of the source transcript. The transcript is never
   * cleared here: it accumulates in the day-scoped doc for accountability, so a
   * transient drop-to-zero-listeners and rejoin can't wipe a live talk.
   */
  async getOrCreate(
    sessionId: string,
    targetLanguage: string,
    organizerIdentity: string
  ): Promise<TranslationBridge> {
    // Protect a just-started session from being reaped before its first listener
    // has finished joining the LiveKit room.
    this.lastHealthyAt.set(sessionId, Date.now());

    const writer = this.getOrCreateWriter(sessionId);

    // Always keep the default bridge alive (the source-transcript writer).
    const defaultBridge = await this.ensureBridge(
      sessionId,
      TranslationSessionManager.DEFAULT_LANGUAGE,
      organizerIdentity,
      writer,
      { countSubscriber: targetLanguage === TranslationSessionManager.DEFAULT_LANGUAGE, writesSourceTranscript: true }
    );

    if (targetLanguage === TranslationSessionManager.DEFAULT_LANGUAGE) {
      return defaultBridge;
    }

    return this.ensureBridge(sessionId, targetLanguage, organizerIdentity, writer, {
      countSubscriber: true,
      writesSourceTranscript: false,
    });
  }

  private getOrCreateWriter(sessionId: string): TranscriptWriter | null {
    if (!this.documentManager) return null;
    let writer = this.writers.get(sessionId);
    if (!writer) {
      writer = new TranscriptWriter(sessionId, this.documentManager);
      this.writers.set(sessionId, writer);
    }
    return writer;
  }

  /**
   * Create-or-reuse a single language's bridge, with a short retry on transient
   * startup failures (LiveKit region discovery / Gemini WS can blip).
   */
  private async ensureBridge(
    sessionId: string,
    targetLanguage: string,
    organizerIdentity: string,
    writer: TranscriptWriter | null,
    opts: { countSubscriber: boolean; writesSourceTranscript: boolean }
  ): Promise<TranslationBridge> {
    let languageMap = this.translations.get(sessionId);
    if (languageMap) {
      const existing = languageMap.get(targetLanguage);
      // Reuse active OR still-starting bridges so concurrent requests (common for
      // the default bridge) don't spin up duplicate Gemini sessions.
      if (existing && (existing.status === "active" || existing.status === "starting")) {
        if (opts.countSubscriber) existing.subscriberCount++;
        return existing;
      }
      if (existing && (existing.status === "error" || existing.status === "closed")) {
        console.log(`[SessionManager] Cleaning up stale bridge for ${targetLanguage}`);
        await existing.stop();
        languageMap.delete(targetLanguage);
      }
    }

    if (!languageMap) {
      languageMap = new Map();
      this.translations.set(sessionId, languageMap);
    }

    // Per-session telemetry sink: tag every bridge event with the session as the
    // distinctId so a talk's full reconnect history groups together in PostHog.
    const telemetry = this.telemetry;
    const recordEvent = telemetry
      ? (event: string, properties: Record<string, unknown>) =>
          telemetry.capture({ distinctId: sessionId, event, properties: { ...properties, sessionId } })
      : null;

    const config = {
      geminiApiKey: process.env.GEMINI_API_KEY!,
      livekitUrl: this.livekitConfig?.url ?? process.env.LIVEKIT_URL ?? process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "ws://localhost:7880",
      livekitApiKey: this.livekitConfig?.apiKey ?? process.env.LIVEKIT_API_KEY!,
      livekitApiSecret: this.livekitConfig?.apiSecret ?? process.env.LIVEKIT_API_SECRET!,
      writer,
      writesSourceTranscript: opts.writesSourceTranscript,
      recordEvent,
    };

    console.log(`[SessionManager] Creating new bridge for ${targetLanguage} in session ${sessionId}`);

    const MAX_START_ATTEMPTS = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
      const bridge = new TranslationBridge(sessionId, targetLanguage, organizerIdentity, config);
      // Store before starting so concurrent requests reuse this in-progress bridge.
      languageMap.set(targetLanguage, bridge);

      try {
        await bridge.start();
        bridge.subscriberCount = opts.countSubscriber ? 1 : 0;
        return bridge;
      } catch (error) {
        lastError = error;
        console.warn(
          `[SessionManager] Bridge start for ${targetLanguage} failed (attempt ${attempt}/${MAX_START_ATTEMPTS}):`,
          (error as Error).message
        );
        await bridge.stop().catch(() => {});
        languageMap.delete(targetLanguage);
        if (attempt < MAX_START_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  getActiveTranslations(sessionId: string): TranslationInfo[] {
    const languageMap = this.translations.get(sessionId);
    if (!languageMap) return [];

    const result: TranslationInfo[] = [];
    for (const [language, bridge] of languageMap) {
      result.push({
        language,
        translatorIdentity: bridge.identity,
        status: bridge.status,
        subscriberCount: bridge.subscriberCount,
      });
    }
    return result;
  }

  /**
   * Decrement subscriber count for a language (best-effort fast path). The
   * presence reaper is the authoritative teardown, so this only needs to handle
   * clean unsubscribes. The default bridge is intentionally left running here —
   * it is torn down by the reaper when the session has no listeners at all.
   */
  async unsubscribe(sessionId: string, targetLanguage: string): Promise<void> {
    const languageMap = this.translations.get(sessionId);
    if (!languageMap) return;

    const bridge = languageMap.get(targetLanguage);
    if (!bridge) return;

    bridge.subscriberCount = Math.max(0, bridge.subscriberCount - 1);
    console.log(
      `[SessionManager] Unsubscribed from ${targetLanguage} in session ${sessionId} (${bridge.subscriberCount} remaining)`
    );

    if (bridge.subscriberCount === 0) {
      console.log(`[SessionManager] No more subscribers for ${targetLanguage}, tearing down bridge`);
      await bridge.stop();
      languageMap.delete(targetLanguage);

      if (languageMap.size === 0) {
        await this.teardownSession(sessionId);
      }
    }
  }

  async removeTranslation(sessionId: string, targetLanguage: string): Promise<void> {
    const languageMap = this.translations.get(sessionId);
    if (!languageMap) return;

    const bridge = languageMap.get(targetLanguage);
    if (bridge) {
      await bridge.stop();
      languageMap.delete(targetLanguage);
      console.log(`[SessionManager] Removed bridge for ${targetLanguage} in session ${sessionId}`);
    }
    if (languageMap.size === 0) {
      await this.teardownSession(sessionId);
    }
  }

  async removeAllTranslations(sessionId: string): Promise<void> {
    await this.teardownSession(sessionId);
    this.sessions.delete(sessionId);
    console.log(`[SessionManager] Removed all bridges and session for ${sessionId}`);
  }

  /** Stop every bridge for a session and close its transcript writer. */
  private async teardownSession(sessionId: string): Promise<void> {
    const languageMap = this.translations.get(sessionId);
    if (languageMap) {
      for (const [, bridge] of languageMap) {
        await bridge.stop().catch(() => {});
      }
      languageMap.clear();
      this.translations.delete(sessionId);
    }

    const writer = this.writers.get(sessionId);
    if (writer) {
      writer.close();
      this.writers.delete(sessionId);
    }

    this.lastHealthyAt.delete(sessionId);
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  // ---------------------------------------------------------------------------
  // Presence reaper: the authoritative teardown. A bot that nobody is listening
  // to — or whose broadcaster has left (no source audio) — is dead weight and is
  // still burning a Gemini session, so we tear the whole session down once it has
  // been unhealthy past a grace window. This does not depend on the client's
  // best-effort unsubscribe beacon firing.
  // ---------------------------------------------------------------------------
  private startReaper(): void {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => {
      void this.reapIdleSessions();
    }, TranslationSessionManager.REAP_INTERVAL_MS);
    // Don't keep the process alive solely for the reaper.
    this.reaperTimer.unref?.();
  }

  async reapIdleSessions(): Promise<void> {
    if (!this.livekitConfig || this.translations.size === 0) return;

    const httpUrl = this.livekitConfig.url.replace(/^ws/, "http");
    const client = new RoomServiceClient(
      httpUrl,
      this.livekitConfig.apiKey,
      this.livekitConfig.apiSecret
    );

    const now = Date.now();
    for (const sessionId of [...this.translations.keys()]) {
      let healthy = false;
      try {
        const participants = await client.listParticipants(sessionId);
        healthy = isSessionHealthy(participants.map((p) => p.identity));
      } catch {
        // Room gone / not found → unhealthy.
        healthy = false;
      }

      if (healthy) {
        this.lastHealthyAt.set(sessionId, now);
        continue;
      }

      const last = this.lastHealthyAt.get(sessionId) ?? now;
      if (now - last > TranslationSessionManager.REAP_GRACE_MS) {
        console.log(
          `[SessionManager] Reaping session ${sessionId} — no listeners or no broadcaster for ${Math.round(
            (now - last) / 1000
          )}s`
        );
        await this.teardownSession(sessionId);
      }
    }
  }
}

export default TranslationSessionManager;
