import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * End-to-end tests for the *wiring*, not the pure helpers.
 *
 * The unit tests in translation-bridge.test.ts prove `reconcileOrganizerAudio` does the
 * right thing when it's called. They cannot prove it *gets* called — and every outage this
 * bridge has had lived precisely there: the logic was fine, the trigger was missing. A test
 * suite that only exercises pure functions would have passed, green, through both.
 *
 * So these tests drive the real TranslationBridge against fakes of the only two things it
 * talks to — a LiveKit room and a Gemini websocket — and assert on the one thing that
 * actually matters to a listener: **is audio still reaching Gemini?** Nothing here inspects
 * internal state; each test breaks the input the way production broke it and checks that
 * frames resume.
 *
 * The LiveKit fake reproduces the documented full-reconnect sequence exactly, including the
 * detail that caused the 2026-07-12 outage: `ParticipantConnected` fires for everyone
 * already in the room, but **no `TrackPublished`** for their existing publications.
 */

// ---------------------------------------------------------------------------
// Fake LiveKit
// ---------------------------------------------------------------------------

const RoomEvent = {
  ParticipantConnected: "participantConnected",
  ParticipantDisconnected: "participantDisconnected",
  TrackPublished: "trackPublished",
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  TrackSubscriptionFailed: "trackSubscriptionFailed",
  Disconnected: "disconnected",
  Reconnecting: "reconnecting",
  Reconnected: "reconnected",
} as const;

const TrackKind = { KIND_AUDIO: 1, KIND_VIDEO: 2 } as const;
const TrackSource = { SOURCE_MICROPHONE: 2 } as const;
const DisconnectReason: Record<number, string> = { 0: "UNKNOWN_REASON" };

/** A remote audio track whose AudioStream we can feed and kill, like a real mic track. */
class FakeRemoteTrack {
  private queue: FakeAudioFrame[] = [];
  private waiter: ((v: IteratorResult<FakeAudioFrame>) => void) | null = null;
  private ended = false;

  /** Speak: deliver one 100ms frame to whoever is reading this track. */
  push(frame: FakeAudioFrame): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ done: false, value: frame });
      return;
    }
    this.queue.push(frame);
  }

  /** The stream dies — what a LiveKit full reconnect does to an existing track. */
  end(): void {
    this.ended = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ done: true, value: undefined as never });
    }
  }

  read(): Promise<IteratorResult<FakeAudioFrame>> {
    const next = this.queue.shift();
    if (next) return Promise.resolve({ done: false, value: next });
    if (this.ended) return Promise.resolve({ done: true, value: undefined as never });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

class FakeAudioFrame {
  constructor(
    public data: Int16Array = new Int16Array(1600),
    public sampleRate = 16000,
    public channels = 1,
    public samplesPerChannel = 1600
  ) {}
}

/** `new AudioStream(track)` in the bridge resolves to a reader over that track. */
class FakeAudioStream {
  constructor(private readonly track: FakeRemoteTrack) {}
  getReader() {
    return { read: () => this.track.read() };
  }
}

class FakePublication {
  subscribed = false;
  constructor(
    readonly track: FakeRemoteTrack,
    readonly participant: FakeParticipant,
    readonly room: FakeRoom,
    readonly kind: number = TrackKind.KIND_AUDIO,
    readonly sid = "TR_fake"
  ) {}

  // The real SDK delivers TrackSubscribed after a server round-trip, never inline.
  setSubscribed(subscribed: boolean): void {
    if (!subscribed || this.subscribed) return;
    this.subscribed = true;
    setTimeout(() => {
      this.room.emit(RoomEvent.TrackSubscribed, this.track, this, this.participant);
    }, 0);
  }
}

class FakeParticipant {
  readonly trackPublications = new Map<string, FakePublication>();
  constructor(readonly identity: string) {}
  publish(pub: FakePublication): FakePublication {
    this.trackPublications.set(String(this.trackPublications.size), pub);
    return pub;
  }
}

let lastRoom: FakeRoom | null = null;

class FakeRoom extends EventEmitter {
  readonly remoteParticipants = new Map<string, FakeParticipant>();
  readonly localParticipant = {
    trackPublications: new Map<string, { sid: string; track: unknown }>(),
    publishTrack: vi.fn(async () => {}),
  };

  constructor() {
    super();
    // The bridge constructs its own Room, so this registry is how the test gets hold of it.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastRoom = this;
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  /** Put a participant in the room with a live mic, as if they were already publishing. */
  seatOrganizer(identity: string): FakeRemoteTrack {
    const participant = new FakeParticipant(identity);
    const track = new FakeRemoteTrack();
    participant.publish(new FakePublication(track, participant, this));
    this.remoteParticipants.set(identity, participant);
    return track;
  }

  /** The organizer joins with no mic yet, then publishes it a beat later (outage 1's race). */
  seatOrganizerWithoutMic(identity: string): FakeParticipant {
    const participant = new FakeParticipant(identity);
    this.remoteParticipants.set(identity, participant);
    return participant;
  }

  publishMicLate(participant: FakeParticipant): FakeRemoteTrack {
    const track = new FakeRemoteTrack();
    const pub = participant.publish(new FakePublication(track, participant, this));
    this.emit(RoomEvent.TrackPublished, pub, participant);
    return track;
  }

  /**
   * LiveKit's documented full-reconnect sequence — "identical to having everyone leave the
   * room, then coming back". Note step 5: ParticipantConnected fires for everyone already
   * present, and *no TrackPublished* fires for their existing publications. That gap is the
   * entire 2026-07-12 outage, so it is the load-bearing detail of this fake.
   */
  fullReconnect(): FakeRemoteTrack {
    const stale = [...this.remoteParticipants.values()];

    // 1. The old media path dies.
    for (const p of stale) {
      for (const [, pub] of p.trackPublications) pub.track.end();
    }
    // 2. ParticipantDisconnected for the others, then Reconnecting.
    for (const p of stale) this.emit(RoomEvent.ParticipantDisconnected, p);
    this.emit(RoomEvent.Reconnecting);

    // 3. Session is rebuilt: brand-new participant, publication and track objects.
    this.remoteParticipants.clear();
    const revived: FakeRemoteTrack[] = [];
    for (const p of stale) {
      const participant = new FakeParticipant(p.identity);
      const track = new FakeRemoteTrack();
      participant.publish(new FakePublication(track, participant, this));
      this.remoteParticipants.set(p.identity, participant);
      revived.push(track);
    }

    // 4/5. Reconnected, then ParticipantConnected for everyone. NO TrackPublished.
    this.emit(RoomEvent.Reconnected);
    for (const p of this.remoteParticipants.values()) {
      this.emit(RoomEvent.ParticipantConnected, p);
    }
    return revived[0];
  }
}

class FakeAudioSource {
  constructor(
    readonly sampleRate: number,
    readonly channels: number
  ) {}
  async captureFrame(): Promise<void> {}
}

vi.mock("@livekit/rtc-node", () => ({
  Room: FakeRoom,
  RoomEvent,
  TrackKind,
  TrackSource,
  DisconnectReason,
  AudioStream: FakeAudioStream,
  AudioSource: FakeAudioSource,
  AudioFrame: FakeAudioFrame,
  LocalAudioTrack: { createAudioTrack: (name: string) => ({ name }) },
  TrackPublishOptions: class {
    source: number | undefined;
  },
  RemoteAudioTrack: class {},
  RemoteTrack: class {},
  RemoteTrackPublication: class {},
  RemoteParticipant: class {},
}));

vi.mock("livekit-server-sdk", () => ({
  AccessToken: class {
    addGrant(): void {}
    async toJwt(): Promise<string> {
      return "fake.jwt";
    }
  },
}));

// ---------------------------------------------------------------------------
// Fake Gemini socket
// ---------------------------------------------------------------------------

/** Records every audio frame the bridge sends us — the assertion surface of these tests. */
class FakeGeminiSocket extends EventEmitter {
  static OPEN = 1;
  static instances: FakeGeminiSocket[] = [];

  readyState = FakeGeminiSocket.OPEN;
  readonly audioFramesReceived: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeGeminiSocket.instances.push(this);
    setTimeout(() => this.emit("open"), 0);
  }

  send(raw: string): void {
    const msg = JSON.parse(raw);
    if (msg.setup) {
      // Gemini answers setup with setupComplete; until it does, the bridge won't send audio.
      setTimeout(() => this.emit("message", Buffer.from(JSON.stringify({ setupComplete: {} }))), 0);
      return;
    }
    if (msg.realtimeInput?.audio?.data) {
      this.audioFramesReceived.push(msg.realtimeInput.audio.data);
    }
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }
}

vi.mock("ws", () => ({ default: FakeGeminiSocket }));

// ---------------------------------------------------------------------------

const { TranslationBridge } = await import("./translation-bridge.ts");

const ORGANIZER = "organizer-host";

/**
 * Frames Gemini has received, across every socket it opened — a Gemini `goAway` reconnect
 * makes a new one, and we don't care which socket the audio landed on, only that it landed.
 */
const framesToGemini = () =>
  FakeGeminiSocket.instances.reduce((n, s) => n + s.audioFramesReceived.length, 0);

/** Speak `count` 100ms frames into a mic track and let them propagate. */
async function speak(track: FakeRemoteTrack, count = 3): Promise<void> {
  for (let i = 0; i < count; i++) {
    track.push(new FakeAudioFrame());
    await vi.advanceTimersByTimeAsync(10);
  }
}

/**
 * Start a bridge. `seat` runs once the bridge has a Room but before its Gemini handshake
 * completes, which is where the room's starting state gets decided (and where outage 1's
 * race lives). Whatever `seat` returns is handed back to the test.
 */
async function boot<T>(seat: (room: FakeRoom) => T): Promise<{
  bridge: InstanceType<typeof TranslationBridge>;
  room: FakeRoom;
  seated: T;
}> {
  const bridge = new TranslationBridge("doc-test", "fr", ORGANIZER, {
    geminiApiKey: "fake-key",
    livekitUrl: "wss://fake.livekit",
    livekitApiKey: "fake",
    livekitApiSecret: "fake",
  });
  const started = bridge.start();
  await vi.advanceTimersByTimeAsync(10); // the bridge has constructed its Room
  const room = lastRoom as FakeRoom;
  const seated = seat(room);
  await vi.advanceTimersByTimeAsync(300); // connectGemini polls for setupComplete every 100ms
  await started;
  await vi.advanceTimersByTimeAsync(10); // deliver the pending TrackSubscribed
  return { bridge, room, seated };
}

describe("TranslationBridge (end-to-end, faked LiveKit + Gemini)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeGeminiSocket.instances = [];
    lastRoom = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pipes the organizer's mic to Gemini (happy path)", async () => {
    const { bridge, seated: mic } = await boot((room) => room.seatOrganizer(ORGANIZER));

    await speak(mic, 3);

    expect(framesToGemini()).toBe(3);
    expect(bridge.status).toBe("active");
    await bridge.stop();
  });

  it("recovers when the organizer's mic publishes late (outage 1: the join/getUserMedia race)", async () => {
    // The organizer is in the room but hasn't finished getUserMedia, so there is nothing to
    // subscribe to when the bridge starts. The mic lands a beat later.
    const { bridge, room, seated: organizer } = await boot((r) =>
      r.seatOrganizerWithoutMic(ORGANIZER)
    );

    const mic = room.publishMicLate(organizer);
    await vi.advanceTimersByTimeAsync(10);
    await speak(mic, 2);

    expect(framesToGemini()).toBe(2);
    await bridge.stop();
  });

  it("survives a LiveKit full reconnect (outage 2: 2026-07-12)", async () => {
    // The regression test this whole rework exists for. Before the fix the bridge stayed
    // `active` here and streamed silence to Gemini until someone redeployed the server.
    const { bridge, room, seated: mic } = await boot((r) => r.seatOrganizer(ORGANIZER));

    await speak(mic, 3);
    expect(framesToGemini()).toBe(3);

    // LiveKit rebuilds the session. The bridge is handed nothing but ParticipantConnected
    // and a dead AudioStream: no TrackPublished, no Disconnected, no error.
    const newMic = room.fullReconnect();
    await vi.advanceTimersByTimeAsync(50);

    // The speaker keeps talking, now into the new track object.
    await speak(newMic, 4);

    expect(framesToGemini()).toBe(7); // audio resumed — we are not deaf
    expect(bridge.status).toBe("active");
    await bridge.stop();
  });

  it("recovers when the input dies with no room event at all (the unknown-unknown)", async () => {
    // Neither outage's trigger: the media path just stops and LiveKit tells us nothing --
    // no reconnect, no unsubscribe, no disconnect, no error. Only reconciling from a
    // liveness signal can catch this, which is what the stall watchdog is for.
    const { bridge, room, seated: mic } = await boot((r) => r.seatOrganizer(ORGANIZER));

    await speak(mic, 2);
    expect(framesToGemini()).toBe(2);

    // Swap the organizer's publication behind the bridge's back and kill the old stream.
    mic.end();
    const organizer = room.remoteParticipants.get(ORGANIZER) as FakeParticipant;
    organizer.trackPublications.clear();
    const newMic = new FakeRemoteTrack();
    organizer.publish(new FakePublication(newMic, organizer, room));

    // Let the watchdog run (15s stall threshold, checked every 5s).
    await vi.advanceTimersByTimeAsync(25_000);
    await speak(newMic, 3);

    expect(framesToGemini()).toBe(5);
    await bridge.stop();
  });

  it("restores audio when only ONE reconnect trigger fires (no trigger is load-bearing)", async () => {
    // The convergence claim in the docs: reconcile is driven by several triggers, and none
    // of them individually matters. Here the room emits Reconnected and *nothing else* --
    // simulating an SDK whose event semantics we guessed wrong, which is precisely the
    // mistake that caused both outages. Audio must still come back.
    const { bridge, room, seated: mic } = await boot((r) => r.seatOrganizer(ORGANIZER));
    await speak(mic, 1);

    mic.end();
    room.remoteParticipants.clear();
    const organizer = new FakeParticipant(ORGANIZER);
    const newMic = new FakeRemoteTrack();
    organizer.publish(new FakePublication(newMic, organizer, room));
    room.remoteParticipants.set(ORGANIZER, organizer);
    room.emit(RoomEvent.Reconnected); // ...and no ParticipantConnected, no TrackPublished

    await vi.advanceTimersByTimeAsync(50);
    await speak(newMic, 3);

    expect(framesToGemini()).toBe(4);
    await bridge.stop();
  });
});
