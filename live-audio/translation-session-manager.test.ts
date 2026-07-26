import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentManager } from "@y-sweet/sdk";

import {
  computeDesiredLanguages,
  planRoomActions,
  summarizePresence,
  TranslationSessionManager,
  type PresentParticipant,
  type RoomDirectory,
} from "./translation-session-manager.ts";
import type { TranslationBridge, BridgeStatus } from "./translation-bridge.ts";

// ---------------------------------------------------------------------------
// Pure decisions: the whole demand model and the reconcile diff.
// ---------------------------------------------------------------------------

const organizer: PresentParticipant = { identity: "organizer-host", attributes: { role: "organizer" } };
const bot = (code: string): PresentParticipant => ({ identity: `translator-${code}` });
const listener = (id: string, listen?: string): PresentParticipant => ({
  identity: `attendee-${id}`,
  attributes: listen ? { listen } : undefined,
});

describe("computeDesiredLanguages", () => {
  const opts = { defaultLanguage: "fr" };

  it("wants nothing without a broadcaster — the waiting room costs nothing", () => {
    // The 2026-07-19 outage shape: a listener waiting for the talk to start must not
    // spin bridges that immediately look idle; they start when the organizer appears.
    expect(computeDesiredLanguages([listener("a", "es")], opts).size).toBe(0);
    expect(computeDesiredLanguages([], opts).size).toBe(0);
  });

  it("wants each listener's language plus the default (source-transcript) bridge", () => {
    const desired = computeDesiredLanguages(
      [organizer, listener("a", "es"), listener("b", "ht")],
      opts
    );
    expect(desired).toEqual(new Set(["es", "ht", "fr"]));
  });

  it("runs the default bridge for attribute-less listeners (older clients)", () => {
    expect(computeDesiredLanguages([organizer, listener("a")], opts)).toEqual(new Set(["fr"]));
  });

  it("runs the default bridge for a lone broadcaster, whatever the cost setting", () => {
    // The default bridge is the sole writer of the English transcript, so it can't be
    // conditional on listeners: a talk that starts before anyone tunes in must still be
    // transcribed, or the first listener arrives mid-sentence with no history. Cost is
    // the bridge's own concern (silenceThresholdDbfs), not a reason to not exist.
    expect(computeDesiredLanguages([organizer], opts)).toEqual(new Set(["fr"]));
  });

  it("never counts translator bots as listeners", () => {
    // Only the default — the bots' own languages must not keep themselves alive, or a
    // bridge nobody wants would justify its own existence and never wind down.
    expect(computeDesiredLanguages([organizer, bot("es"), bot("fr")], opts)).toEqual(
      new Set(["fr"])
    );
  });
});

describe("planRoomActions", () => {
  const plan = (over: Partial<Parameters<typeof planRoomActions>[0]>) =>
    planRoomActions({
      desired: new Set<string>(),
      running: [],
      lastDesiredAt: new Map(),
      now: 100_000,
      stopGraceMs: 60_000,
      ...over,
    });

  it("starts what is desired but missing", () => {
    expect(plan({ desired: new Set(["es", "fr"]) })).toEqual({ start: ["es", "fr"], stop: [] });
  });

  it("restarts a bridge that died (error or closed) while still desired", () => {
    const p = plan({
      desired: new Set(["es", "fr"]),
      running: [
        { language: "es", status: "error" as BridgeStatus },
        { language: "fr", status: "active" as BridgeStatus },
      ],
    });
    expect(p.start).toEqual(["es"]);
  });

  it("holds an undesired bridge through the grace window, then stops it", () => {
    const running = [{ language: "es", status: "active" as BridgeStatus }];
    const lastDesiredAt = new Map([["es", 70_000]]);
    expect(plan({ running, lastDesiredAt, now: 100_000 }).stop).toEqual([]); // 30s ago: hold
    expect(plan({ running, lastDesiredAt, now: 140_000 }).stop).toEqual(["es"]); // 70s ago: stop
  });

  it("leaves a desired, active bridge alone", () => {
    const p = plan({
      desired: new Set(["es"]),
      running: [{ language: "es", status: "active" as BridgeStatus }],
    });
    expect(p).toEqual({ start: [], stop: [] });
  });
});

// ---------------------------------------------------------------------------
// The supervisor loop, wired: fake directory + fake bridges. These prove the
// reconcile *runs and converges* — starts what presence demands (including from a
// cold start, the server-restart case), recreates failures, and winds down
// abandoned rooms. The pure tests above can't prove any of that.
// ---------------------------------------------------------------------------

class FakeBridge {
  status: BridgeStatus = "starting";
  subscriberCount = 0;
  readonly identity: string;
  constructor(
    readonly sessionId: string,
    readonly targetLanguage: string
  ) {
    this.identity = `translator-${targetLanguage}`;
  }
  async start(): Promise<void> {
    this.status = "active";
  }
  async stop(): Promise<void> {
    this.status = "closed";
  }
  health() {
    return {
      status: this.status,
      gemini: "ready" as const,
      lastInputFrameAt: 0,
      lastOutputFrameAt: 0,
      reconnects: 0,
      bufferedFrames: 0,
    };
  }
  async simulateScenario(): Promise<void> {}
}

function makeManager(rooms: Map<string, PresentParticipant[]>) {
  const created: FakeBridge[] = [];
  const directory: RoomDirectory = {
    listRooms: async () => [...rooms.keys()],
    listParticipants: async (room) => {
      const p = rooms.get(room);
      if (!p) throw new Error("room not found");
      return p;
    },
  };
  const manager = new TranslationSessionManager();
  manager.init({
    // The writer needs a real DocumentManager; null-object it — TranscriptWriter is
    // only constructed lazily per session and these tests never await its sync.
    documentManager: null as unknown as DocumentManager,
    livekit: { url: "ws://fake", apiKey: "k", apiSecret: "s" },
    directory,
    bridgeFactory: (sessionId, targetLanguage) => {
      const bridge = new FakeBridge(sessionId, targetLanguage);
      created.push(bridge);
      return bridge as unknown as TranslationBridge;
    },
  });
  return { manager, created, rooms };
}

const runningLanguages = (manager: TranslationSessionManager, sessionId: string) =>
  manager
    .getActiveTranslations(sessionId)
    .filter((t) => t.status === "active")
    .map((t) => t.language)
    .sort();

describe("TranslationSessionManager supervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds bridges from presence alone — the server-restart recovery", async () => {
    // Cold manager (empty maps), populated room: exactly the state after a redeploy
    // mid-talk. One tick must rebuild everything the participants imply.
    const { manager } = makeManager(
      new Map([["doc-1", [organizer, listener("a", "es")]]])
    );
    await manager.reconcileAll();
    expect(runningLanguages(manager, "doc-1")).toEqual(["es", "fr"]);
  });

  it("starts nothing for a waiting room, then everything when the broadcaster arrives", async () => {
    const { manager, rooms } = makeManager(new Map([["doc-1", [listener("a", "es")]]]));
    await manager.reconcileAll();
    expect(manager.getActiveTranslations("doc-1")).toEqual([]);

    rooms.set("doc-1", [organizer, listener("a", "es")]);
    await manager.reconcileAll();
    expect(runningLanguages(manager, "doc-1")).toEqual(["es", "fr"]);
  });

  it("recreates a bridge that failed while demand persists", async () => {
    const { manager, created } = makeManager(
      new Map([["doc-1", [organizer, listener("a", "es")]]])
    );
    await manager.reconcileAll();
    const es = created.find((b) => b.targetLanguage === "es")!;
    es.status = "error"; // e.g. its room connection dropped

    // The start damper (START_RETRY_MS) keys off the last attempt; step past it.
    await vi.advanceTimersByTimeAsync(31_000);
    await manager.reconcileAll();

    const esBridges = created.filter((b) => b.targetLanguage === "es");
    expect(esBridges).toHaveLength(2);
    expect(esBridges[1].status).toBe("active");
    expect(runningLanguages(manager, "doc-1")).toEqual(["es", "fr"]);
  });

  it("winds a language down only after the demand grace", async () => {
    const rooms = new Map([["doc-1", [organizer, listener("a", "es")]]]);
    const { manager, created } = makeManager(rooms);
    await manager.reconcileAll();

    // The es listener leaves (page refresh, say) — bridge survives the grace...
    rooms.set("doc-1", [organizer, listener("b", "fr")]);
    await vi.advanceTimersByTimeAsync(10_000);
    await manager.reconcileAll();
    expect(runningLanguages(manager, "doc-1")).toContain("es");

    // ...and is stopped once demand has been gone for over a minute.
    await vi.advanceTimersByTimeAsync(70_000);
    await manager.reconcileAll();
    expect(runningLanguages(manager, "doc-1")).toEqual(["fr"]);
    expect(created.find((b) => b.targetLanguage === "es")!.status).toBe("closed");
  });

  it("tears the whole session down after everyone leaves", async () => {
    const rooms = new Map([["doc-1", [organizer, listener("a", "es")]]]);
    const { manager, created } = makeManager(rooms);
    await manager.reconcileAll();

    rooms.delete("doc-1"); // room gone from LiveKit entirely
    await vi.advanceTimersByTimeAsync(70_000);
    await manager.reconcileAll();

    expect(manager.getActiveTranslations("doc-1")).toEqual([]);
    for (const bridge of created) expect(bridge.status).toBe("closed");
  });

  it("skips the tick — no mass teardown — when LiveKit itself is unreadable", async () => {
    const { manager } = makeManager(new Map([["doc-1", [organizer, listener("a", "es")]]]));
    await manager.reconcileAll();

    const blind: RoomDirectory = {
      listRooms: async () => {
        throw new Error("livekit down");
      },
      listParticipants: async () => [],
    };
    manager.init({
      documentManager: null as unknown as DocumentManager,
      livekit: { url: "ws://fake", apiKey: "k", apiSecret: "s" },
      directory: blind,
    });
    await vi.advanceTimersByTimeAsync(300_000);
    await manager.reconcileAll();

    // A blind spot must read as "can't see", never as "rooms are empty".
    expect(runningLanguages(manager, "doc-1")).toEqual(["es", "fr"]);
  });

  it("stamps per-language listener counts for the dashboard", async () => {
    const { manager } = makeManager(
      new Map([["doc-1", [organizer, listener("a", "es"), listener("b", "es"), listener("c", "fr")]]])
    );
    await manager.reconcileAll();
    const infos = manager.getActiveTranslations("doc-1");
    expect(infos.find((t) => t.language === "es")?.subscriberCount).toBe(2);
    expect(infos.find((t) => t.language === "fr")?.subscriberCount).toBe(1);
  });

  it("getOrCreate stamps demand so a nudged language survives until presence shows it", async () => {
    // A listener whose token predates the `listen` attribute nudges via /translate;
    // the stamp must hold the bridge through the grace even though no attribute
    // matches, and the supervisor must not stop it on its next tick.
    const rooms = new Map([["doc-1", [organizer, listener("old-client")]]]);
    const { manager } = makeManager(rooms);
    const bridge = await manager.getOrCreate("doc-1", "es", "organizer-host");
    expect(bridge.status).toBe("active");

    await manager.reconcileAll();
    expect(runningLanguages(manager, "doc-1")).toEqual(["es", "fr"]);
  });
});

// ---------------------------------------------------------------------------
// Presence reporting: the half of the status picture LiveKit owns. The rules that
// matter are about *honesty under failure* — a status view that quietly reports an
// empty room during a LiveKit blip is worse than one that reports nothing.
// ---------------------------------------------------------------------------

describe("summarizePresence", () => {
  it("splits the room into broadcaster, human listeners, and bots", () => {
    const p = summarizePresence(
      [organizer, bot("es"), listener("a", "es"), listener("b")],
      0
    );
    expect(p.broadcasterPresent).toBe(true);
    expect(p.broadcasterIdentity).toBe("organizer-host");
    expect(p.translatorIdentities).toEqual(["translator-es"]);
    expect(p.listeners).toEqual([
      { identity: "attendee-a", listenLanguage: "es" },
      // Listening to the original audio: counted, with no language. No subscriberCount
      // anywhere would ever show this person.
      { identity: "attendee-b", listenLanguage: null },
    ]);
  });

  it("reports an empty room without a broadcaster", () => {
    const p = summarizePresence([], 0);
    expect(p.broadcasterPresent).toBe(false);
    expect(p.broadcasterIdentity).toBeNull();
    expect(p.listeners).toEqual([]);
  });
});

describe("TranslationSessionManager.getRoomPresence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makePresenceManager(initial: PresentParticipant[] = [organizer, listener("a", "es")]) {
    let participants = initial;
    let failing = false;
    let calls = 0;
    const directory: RoomDirectory = {
      listRooms: async () => ["doc-1"],
      listParticipants: async () => {
        calls += 1;
        if (failing) throw new Error("livekit unreachable");
        return participants;
      },
    };
    const manager = new TranslationSessionManager();
    manager.init({
      documentManager: null as unknown as DocumentManager,
      livekit: { url: "ws://fake", apiKey: "k", apiSecret: "s" },
      directory,
      bridgeFactory: (sessionId, targetLanguage) =>
        new FakeBridge(sessionId, targetLanguage) as unknown as TranslationBridge,
    });
    return {
      manager,
      calls: () => calls,
      setParticipants: (p: PresentParticipant[]) => {
        participants = p;
      },
      setFailing: (v: boolean) => {
        failing = v;
      },
    };
  }

  it("serves the supervisor's own snapshot instead of re-reading LiveKit", async () => {
    // The whole point of caching: a status page open through a service must not turn
    // into a LiveKit read per poll per viewer.
    const { manager, calls } = makePresenceManager();
    await manager.reconcileAll();
    const before = calls();

    const presence = await manager.getRoomPresence("doc-1");
    expect(presence?.broadcasterPresent).toBe(true);
    expect(presence?.listeners).toHaveLength(1);
    expect(calls()).toBe(before);
  });

  it("refreshes once the snapshot ages past the window", async () => {
    const { manager, calls, setParticipants } = makePresenceManager();
    await manager.reconcileAll();
    const before = calls();

    setParticipants([organizer, listener("a", "es"), listener("b", "ht")]);
    await vi.advanceTimersByTimeAsync(5_000);
    const presence = await manager.getRoomPresence("doc-1");

    expect(calls()).toBeGreaterThan(before);
    expect(presence?.listeners).toHaveLength(2);
  });

  it("keeps reporting the last real snapshot when LiveKit goes unreadable", async () => {
    // The failure that matters: reporting "nobody is here" from a blind spot would
    // read, on the status page, exactly like everyone having left.
    const { manager, setFailing } = makePresenceManager();
    await manager.reconcileAll();

    setFailing(true);
    await vi.advanceTimersByTimeAsync(20_000);
    const presence = await manager.getRoomPresence("doc-1");

    expect(presence?.broadcasterPresent).toBe(true);
    expect(presence?.snapshotAgeMs).toBeGreaterThanOrEqual(20_000);
  });

  it("reports nothing for a room it has never seen", async () => {
    const { manager, setFailing } = makePresenceManager();
    setFailing(true);
    expect(await manager.getRoomPresence("doc-1")).toBeNull();
  });

  it("collapses concurrent status reads into a single LiveKit call", async () => {
    const { manager, calls } = makePresenceManager();
    const [a, b, c] = await Promise.all([
      manager.getRoomPresence("doc-1"),
      manager.getRoomPresence("doc-1"),
      manager.getRoomPresence("doc-1"),
    ]);
    expect(calls()).toBe(1);
    expect([a, b, c].every((p) => p?.broadcasterPresent)).toBe(true);
  });
});
