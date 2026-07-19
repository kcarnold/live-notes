/**
 * TranslationSessionManager: supervises translator bridges by reconciling the set of
 * running bridges against LiveKit room presence — the single source of truth for demand.
 *
 * There is no listener refcount and no client beacon. Who is in the room, and what they
 * asked to hear (the `listen` participant attribute their token carries), IS the demand
 * signal; the supervisor loop diffs that against the bridges actually running and
 * starts, stops, or recreates bridges to close the gap. The loop runs on an interval
 * and on pokes (a token issued, a listener's /translate request), so every failure mode
 * that loses a bridge — server restart, room disconnect, a crashed start — heals on the
 * next tick as long as demand persists. Design rationale and the incident history are
 * in docs/live-audio-state-architecture.md.
 *
 * Usage:
 *   const manager = TranslationSessionManager.getInstance();
 *   manager.init({ documentManager, livekit });   // once, at server boot
 *   const bridge = await manager.getOrCreate(sessionId, targetLanguage, organizerIdentity);
 */

import type { SimulateScenarioKind } from "@livekit/rtc-node";
import type { DocumentManager } from "@y-sweet/sdk";
import { RoomServiceClient } from "livekit-server-sdk";

import { TranscriptWriter } from "./transcript-writer.ts";
import { TranslationBridge } from "./translation-bridge.ts";
import type { BridgeHealth, BridgeStatus } from "./translation-bridge.ts";

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
  health: BridgeHealth;
}

interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/** A room participant as the supervisor sees it: identity + token attributes. */
export interface PresentParticipant {
  identity: string;
  attributes?: Record<string, string>;
}

/**
 * The supervisor's view of LiveKit — which rooms have participants, and who they are.
 * Implemented over RoomServiceClient in production; injectable so the reconcile loop
 * is testable without a LiveKit server.
 */
export interface RoomDirectory {
  listRooms(): Promise<string[]>;
  listParticipants(room: string): Promise<PresentParticipant[]>;
}

/** Participant attribute carrying a listener's requested translation language. */
export const LISTEN_ATTRIBUTE = "listen";

const ORGANIZER_PREFIX = "organizer-";
const TRANSLATOR_PREFIX = "translator-";

// The supervisor cadence, and the two dampers that keep it from thrashing:
// a language keeps its bridge for STOP_GRACE_MS after demand last existed (so a page
// refresh or a transient LiveKit read failure doesn't churn a Gemini session), and a
// language whose bridge fails to start isn't retried for START_RETRY_MS (ensureBridge
// already retries 3× internally per attempt).
const RECONCILE_INTERVAL_MS = 10_000;
const STOP_GRACE_MS = 60_000;
const START_RETRY_MS = 30_000;

/**
 * Which translation languages should be running for a room, given who is present
 * right now. The whole demand model in one pure function:
 *
 *   - No broadcaster → nothing runs. A listener waiting for the talk to start costs
 *     nothing, and the bridge starts on the tick where the organizer appears — the
 *     "waiting-room reap" outage (2026-07-19) is inexpressible in this shape.
 *   - Broadcaster present → every language some listener's `listen` attribute names,
 *     plus the default language (the source-transcript writer) while anyone is
 *     listening — or unconditionally when the silence-gating cost path makes an idle
 *     bridge ~free.
 *
 * Listeners without a `listen` attribute (older clients) still count as listeners, so
 * the default bridge runs for them; their specific language arrives via the
 * `/translate` nudge, which stamps demand directly.
 */
export function computeDesiredLanguages(
  participants: PresentParticipant[],
  opts: { defaultLanguage: string; silenceGatingEnabled: boolean }
): Set<string> {
  const desired = new Set<string>();
  const hasBroadcaster = participants.some((p) => p.identity.startsWith(ORGANIZER_PREFIX));
  if (!hasBroadcaster) return desired;

  const listeners = participants.filter(
    (p) => !p.identity.startsWith(ORGANIZER_PREFIX) && !p.identity.startsWith(TRANSLATOR_PREFIX)
  );
  for (const listener of listeners) {
    const lang = listener.attributes?.[LISTEN_ATTRIBUTE];
    if (lang) desired.add(lang);
  }
  if (opts.silenceGatingEnabled || listeners.length > 0) {
    desired.add(opts.defaultLanguage);
  }
  return desired;
}

export interface RunningBridgeView {
  language: string;
  status: BridgeStatus;
}

/**
 * Diff desired languages against running bridges into actions. Pure so the whole
 * supervisor decision is unit-testable:
 *
 *   - start: desired but missing, or present in a dead state ("error"/"closed" —
 *     ensureBridge cleans those up and recreates, so start doubles as recreate).
 *   - stop: running but undesired for longer than the grace window.
 */
export function planRoomActions(params: {
  desired: ReadonlySet<string>;
  running: RunningBridgeView[];
  lastDesiredAt: ReadonlyMap<string, number>;
  now: number;
  stopGraceMs: number;
}): { start: string[]; stop: string[] } {
  const start: string[] = [];
  const stop: string[] = [];
  const runningByLang = new Map(params.running.map((b) => [b.language, b]));

  for (const lang of params.desired) {
    const bridge = runningByLang.get(lang);
    if (!bridge || bridge.status === "error" || bridge.status === "closed") start.push(lang);
  }
  for (const bridge of params.running) {
    if (params.desired.has(bridge.language)) continue;
    const last = params.lastDesiredAt.get(bridge.language) ?? 0;
    if (params.now - last > params.stopGraceMs) stop.push(bridge.language);
  }
  return { start, stop };
}

/** Production RoomDirectory over the LiveKit server API. */
function roomServiceDirectory(lk: LiveKitConfig): RoomDirectory {
  const client = new RoomServiceClient(lk.url.replace(/^ws/, "http"), lk.apiKey, lk.apiSecret);
  return {
    listRooms: async () => (await client.listRooms()).map((r) => r.name),
    listParticipants: async (room: string) =>
      (await client.listParticipants(room)).map((p) => ({
        identity: p.identity,
        attributes: p.attributes,
      })),
  };
}

export class TranslationSessionManager {
  private static instance: TranslationSessionManager;

  // The primary/default translation language. It runs whenever anyone is
  // listening and is the sole writer of the source (English) transcript.
  static readonly DEFAULT_LANGUAGE = "fr";

  // Map<sessionId, Map<languageCode, TranslationBridge>>
  private translations: Map<string, Map<string, TranslationBridge>> = new Map();

  // Map<sessionId, TranscriptWriter> — one Yjs writer per session, shared by bridges.
  private writers: Map<string, TranscriptWriter> = new Map();

  // Map<sessionId, Map<language, epoch-ms>> — when demand for a language last existed
  // (a matching listener present, or a /translate nudge). Drives the stop grace.
  private lastDesiredAt: Map<string, Map<string, number>> = new Map();

  // Map<`${sessionId}:${language}`, epoch-ms> — last supervisor-initiated start
  // attempt, so a language whose bridge won't start isn't retried every tick.
  private lastStartAttemptAt: Map<string, number> = new Map();

  private documentManager: DocumentManager | null = null;
  private livekitConfig: LiveKitConfig | null = null;
  private telemetry: TelemetryClient | null = null;
  private directory: RoomDirectory | null = null;
  private bridgeFactory: typeof defaultBridgeFactory = defaultBridgeFactory;
  private supervisorTimer: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;

  // Cost optimization master switch (default off). When off, bridges never suspend
  // for silence and the default bridge runs only while someone is listening. When on,
  // silence is free so the default translator runs for any present broadcaster.
  private silenceGatingEnabled: boolean = false;

  static getInstance(): TranslationSessionManager {
    if (!TranslationSessionManager.instance) {
      TranslationSessionManager.instance = new TranslationSessionManager();
    }
    return TranslationSessionManager.instance;
  }

  /**
   * Provide the dependencies the manager needs to persist transcripts and supervise
   * bridges. Called once from the server at boot; tests construct their own instance
   * and inject a fake directory/bridge factory.
   */
  init(opts: {
    documentManager: DocumentManager;
    livekit: LiveKitConfig;
    telemetry?: TelemetryClient;
    silenceGatingEnabled?: boolean;
    directory?: RoomDirectory;
    bridgeFactory?: typeof defaultBridgeFactory;
  }): void {
    this.documentManager = opts.documentManager;
    this.livekitConfig = opts.livekit;
    this.telemetry = opts.telemetry ?? null;
    this.silenceGatingEnabled = opts.silenceGatingEnabled ?? false;
    this.directory = opts.directory ?? roomServiceDirectory(opts.livekit);
    if (opts.bridgeFactory) this.bridgeFactory = opts.bridgeFactory;
    this.startSupervisor();
  }

  /**
   * Ask the supervisor to reconcile a room soon (fire-and-forget). Used by the token
   * route so a broadcaster going live gets their bridges within seconds rather than
   * on the next tick. Purely a latency optimization: the interval loop converges to
   * the same state without it.
   */
  poke(sessionId: string): void {
    void this.reconcileRoom(sessionId).catch((e) => {
      console.error(`[SessionManager] poke reconcile failed for ${sessionId}:`, e);
    });
  }

  /**
   * Ensure translation is running for a language and return its bridge — the fast
   * path behind POST /translate, so the response can carry the translator identity.
   * Also stamps demand for the language, covering listeners whose token predates the
   * `listen` attribute. The supervisor remains the authority on teardown; nothing
   * here counts subscribers.
   */
  async getOrCreate(
    sessionId: string,
    targetLanguage: string,
    organizerIdentity: string
  ): Promise<TranslationBridge> {
    const now = Date.now();
    const stamps = this.getStamps(sessionId);
    stamps.set(targetLanguage, now);
    stamps.set(TranslationSessionManager.DEFAULT_LANGUAGE, now);

    const writer = this.getOrCreateWriter(sessionId);

    // Always keep the default bridge alive (the source-transcript writer).
    const defaultBridge = await this.ensureBridge(
      sessionId,
      TranslationSessionManager.DEFAULT_LANGUAGE,
      organizerIdentity,
      writer
    );
    if (targetLanguage === TranslationSessionManager.DEFAULT_LANGUAGE) {
      return defaultBridge;
    }
    return this.ensureBridge(sessionId, targetLanguage, organizerIdentity, writer);
  }

  private getStamps(sessionId: string): Map<string, number> {
    let stamps = this.lastDesiredAt.get(sessionId);
    if (!stamps) {
      stamps = new Map();
      this.lastDesiredAt.set(sessionId, stamps);
    }
    return stamps;
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
   * startup failures (LiveKit region discovery / Gemini WS can blip). Only the
   * default-language bridge transcribes the source audio.
   */
  private async ensureBridge(
    sessionId: string,
    targetLanguage: string,
    organizerIdentity: string,
    writer: TranscriptWriter | null
  ): Promise<TranslationBridge> {
    let languageMap = this.translations.get(sessionId);
    if (languageMap) {
      const existing = languageMap.get(targetLanguage);
      // Reuse active OR still-starting bridges so concurrent requests (common for
      // the default bridge) don't spin up duplicate Gemini sessions.
      if (existing && (existing.status === "active" || existing.status === "starting")) {
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
      writesSourceTranscript: targetLanguage === TranslationSessionManager.DEFAULT_LANGUAGE,
      recordEvent,
      silenceGatingEnabled: this.silenceGatingEnabled,
    };

    console.log(`[SessionManager] Creating new bridge for ${targetLanguage} in session ${sessionId}`);

    const MAX_START_ATTEMPTS = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
      const bridge = this.bridgeFactory(sessionId, targetLanguage, organizerIdentity, config);
      // Store before starting so concurrent requests reuse this in-progress bridge.
      languageMap.set(targetLanguage, bridge);

      try {
        await bridge.start();
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
        health: bridge.health(),
      });
    }
    return result;
  }

  /**
   * Force a LiveKit reconnection scenario on a session's bridges. **Testing only** — the
   * caller is responsible for gating this (see the dev-only route in server.ts).
   *
   * This exists because the failure it reproduces cannot be waited for: a LiveKit full
   * reconnect is the SDK's escalation when a resume fails, and it took a production outage
   * to observe one. Being able to fire it on demand turns "run a service and hope" into a
   * ten-second check. Returns the languages it fired at.
   */
  async simulateScenario(sessionId: string, kind: SimulateScenarioKind): Promise<string[]> {
    const languageMap = this.translations.get(sessionId);
    if (!languageMap) return [];
    const fired: string[] = [];
    for (const [language, bridge] of languageMap) {
      await bridge.simulateScenario(kind);
      fired.push(language);
    }
    return fired;
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

    this.lastDesiredAt.delete(sessionId);
    for (const key of [...this.lastStartAttemptAt.keys()]) {
      if (key.startsWith(`${sessionId}:`)) this.lastStartAttemptAt.delete(key);
    }
  }

  // ---------------------------------------------------------------------------
  // The supervisor: a bidirectional reconciler. Every tick it drives the running
  // set of bridges toward what room presence says should exist — creating what's
  // missing (including after a server restart, when the in-memory maps are empty
  // but the rooms are not), recreating what failed, and tearing down what nobody
  // wants anymore. No single trigger is load-bearing, which is the same property
  // the bridge's own input-side reconcile is built on.
  // ---------------------------------------------------------------------------
  private startSupervisor(): void {
    if (this.supervisorTimer) return;
    this.supervisorTimer = setInterval(() => {
      void this.reconcileAll();
    }, RECONCILE_INTERVAL_MS);
    // Don't keep the process alive solely for the supervisor.
    this.supervisorTimer.unref?.();
  }

  async reconcileAll(): Promise<void> {
    if (!this.directory || this.reconciling) return;
    this.reconciling = true;
    try {
      let roomNames: string[];
      try {
        roomNames = await this.directory.listRooms();
      } catch (e) {
        // Can't see LiveKit at all — skip the whole tick rather than mistake a
        // blind spot for empty rooms and mass-teardown live sessions.
        console.warn("[SessionManager] listRooms failed; skipping reconcile tick:", e);
        return;
      }
      // Union: rooms with participants (may need bridges — the restart-recovery
      // case) and rooms we hold bridges for (may need teardown).
      const rooms = new Set([...roomNames, ...this.translations.keys()]);
      for (const sessionId of rooms) {
        await this.reconcileRoom(sessionId);
      }
    } finally {
      this.reconciling = false;
    }
  }

  async reconcileRoom(sessionId: string): Promise<void> {
    if (!this.directory) return;
    let participants: PresentParticipant[] = [];
    try {
      participants = await this.directory.listParticipants(sessionId);
    } catch {
      // Room gone or LiveKit briefly unreadable → no visible demand. The stop
      // grace absorbs transient failures; a genuinely closed room winds down.
    }

    const desired = computeDesiredLanguages(participants, {
      defaultLanguage: TranslationSessionManager.DEFAULT_LANGUAGE,
      silenceGatingEnabled: this.silenceGatingEnabled,
    });

    const now = Date.now();
    const stamps = this.getStamps(sessionId);
    for (const lang of desired) stamps.set(lang, now);

    const languageMap = this.translations.get(sessionId);
    const running: RunningBridgeView[] = languageMap
      ? [...languageMap.entries()].map(([language, b]) => ({ language, status: b.status }))
      : [];

    const plan = planRoomActions({
      desired,
      running,
      lastDesiredAt: stamps,
      now,
      stopGraceMs: STOP_GRACE_MS,
    });

    for (const language of plan.stop) {
      console.log(`[SessionManager] Supervisor stopping ${language} in ${sessionId} (no demand)`);
      this.telemetry?.capture({
        distinctId: sessionId,
        event: "supervisor_bridge_stopped",
        properties: { sessionId, language },
      });
      const bridge = languageMap?.get(language);
      if (bridge) {
        await bridge.stop().catch(() => {});
        languageMap?.delete(language);
      }
    }
    if (languageMap && languageMap.size === 0) this.translations.delete(sessionId);

    // desired is non-empty only with a broadcaster present, so this is always set
    // on the start path; the fallback only guards the type.
    const organizerIdentity =
      participants.find((p) => p.identity.startsWith(ORGANIZER_PREFIX))?.identity ??
      "organizer-host";
    const writer = plan.start.length > 0 ? this.getOrCreateWriter(sessionId) : null;
    for (const language of plan.start) {
      const key = `${sessionId}:${language}`;
      if (now - (this.lastStartAttemptAt.get(key) ?? 0) < START_RETRY_MS) continue;
      this.lastStartAttemptAt.set(key, now);
      console.log(`[SessionManager] Supervisor starting ${language} in ${sessionId}`);
      this.telemetry?.capture({
        distinctId: sessionId,
        event: "supervisor_bridge_started",
        properties: { sessionId, language },
      });
      try {
        await this.ensureBridge(sessionId, language, organizerIdentity, writer);
      } catch (e) {
        console.error(`[SessionManager] Supervisor start of ${language} in ${sessionId} failed:`, e);
        this.telemetry?.capture({
          distinctId: sessionId,
          event: "supervisor_bridge_start_failed",
          properties: { sessionId, language, message: (e as Error).message },
        });
      }
    }

    // Dashboard info: listeners per language, from the same presence snapshot.
    // After the starts, so bridges created this tick get their count immediately.
    for (const [language, bridge] of this.translations.get(sessionId) ?? []) {
      bridge.subscriberCount = participants.filter(
        (p) => p.attributes?.[LISTEN_ATTRIBUTE] === language
      ).length;
    }

    // Session-level wind-down: nothing running, nothing wanted, nobody present.
    if (
      (this.translations.get(sessionId)?.size ?? 0) === 0 &&
      desired.size === 0 &&
      participants.length === 0 &&
      (this.writers.has(sessionId) || this.lastDesiredAt.has(sessionId))
    ) {
      await this.teardownSession(sessionId);
    }
  }
}

/** Production bridge factory; tests inject a fake via init({ bridgeFactory }). */
function defaultBridgeFactory(
  sessionId: string,
  targetLanguage: string,
  organizerIdentity: string,
  config: ConstructorParameters<typeof TranslationBridge>[3]
): TranslationBridge {
  return new TranslationBridge(sessionId, targetLanguage, organizerIdentity, config);
}

export default TranslationSessionManager;
