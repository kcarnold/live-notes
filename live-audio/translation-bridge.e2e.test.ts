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
 * talks to — a LiveKit room and a provider websocket — and assert on the one thing that
 * actually matters to a listener: **is audio still reaching the provider?** Nothing here inspects
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

/**
 * `new AudioStream(track, opts)` in the bridge resolves to a reader over that track. The
 * `opts` are recorded because the sample rate in them is how the bridge asks LiveKit to
 * resample organizer audio to whatever its provider expects — 16 kHz for Gemini, 24 kHz
 * for OpenAI. Get that wrong and the audio still flows, still reports healthy, and is
 * pitched and paced wrong on arrival: a failure you can only hear.
 */
class FakeAudioStream {
  static instances: FakeAudioStream[] = [];
  constructor(
    private readonly track: FakeRemoteTrack,
    readonly opts?: { sampleRate?: number; numChannels?: number; frameSizeMs?: number }
  ) {
    FakeAudioStream.instances.push(this);
  }
  getReader() {
    return { read: () => this.track.read() };
  }
}

class FakePublication {
  subscribed = false;
  // undefined by default, like the SDK's `muted?: boolean` — the bridge must treat
  // unknown as live, so only an explicit `true` reads as a muted mic.
  muted: boolean | undefined = undefined;
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
  // The real SDK emits Disconnected (CLIENT_INITIATED) on a manual disconnect, so every
  // test that calls bridge.stop() also exercises the "deliberate disconnect" guard.
  async disconnect(): Promise<void> {
    this.emit(RoomEvent.Disconnected, 0);
  }

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

/**
 * The bridge's *output* leg: translated audio it publishes into the room. Recorded here
 * (rather than dropped, as it used to be) so a test can assert the last hop — provider
 * audio actually reaching a LiveKit track — instead of stopping at "we sent input".
 */
class FakeAudioSource {
  static instances: FakeAudioSource[] = [];
  readonly captured: unknown[] = [];
  constructor(
    readonly sampleRate: number,
    readonly channels: number
  ) {
    FakeAudioSource.instances.push(this);
  }
  async captureFrame(frame: unknown): Promise<void> {
    this.captured.push(frame);
  }
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
// Fake provider socket
//
// Speaks both wire protocols, because both are now in production: Gemini Live for most
// languages and OpenAI Realtime for Haitian Creole. One fake rather than two, so every
// resilience test below is provider-agnostic by construction — if a reconnect path only
// worked for Gemini, pointing these tests at the other provider would say so.
//
// The load-bearing asymmetry is the handshake. Gemini answers `setup` with
// `setupComplete` and nothing before it. OpenAI sends `session.created` the moment you
// connect — *before* our `session.update` is applied, when the session is still a plain
// chatbot — and only `session.updated` means "configured as an interpreter". A bridge
// that mistook the first for the second would stream the opening of the talk into an
// unconfigured model, so the fake reproduces that order faithfully.
// ---------------------------------------------------------------------------

/** Records every audio frame the bridge sends us — the assertion surface of these tests. */
class FakeProviderSocket extends EventEmitter {
  static OPEN = 1;
  static instances: FakeProviderSocket[] = [];

  readyState = FakeProviderSocket.OPEN;
  readonly audioFramesReceived: string[] = [];

  /**
   * "createdOnly" answers `session.update` with `session.created` and then goes quiet —
   * a session that connected but was never configured. See the handshake note above.
   */
  static openaiHandshake: "full" | "createdOnly" = "full";

  constructor(
    readonly url: string,
    readonly options?: unknown
  ) {
    super();
    FakeProviderSocket.instances.push(this);
    setTimeout(() => this.emit("open"), 0);
  }

  private reply(message: unknown): void {
    setTimeout(() => this.emit("message", Buffer.from(JSON.stringify(message))), 0);
  }

  send(raw: string): void {
    const msg = JSON.parse(raw);

    // --- Gemini ---
    if (msg.setup) {
      // Gemini answers setup with setupComplete; until it does, the bridge won't send audio.
      this.reply({ setupComplete: {} });
      return;
    }
    if (msg.realtimeInput?.audio?.data) {
      this.audioFramesReceived.push(msg.realtimeInput.audio.data);
      return;
    }

    // --- OpenAI ---
    if (msg.type === "session.update") {
      this.reply({ type: "session.created", session: {} }); // NOT ready yet
      if (FakeProviderSocket.openaiHandshake === "full") {
        this.reply({ type: "session.updated", session: {} }); // now configured
      }
      return;
    }
    if (msg.type === "input_audio_buffer.append") {
      this.audioFramesReceived.push(msg.audio);
      return;
    }
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }
}

vi.mock("ws", () => ({ default: FakeProviderSocket }));

// ---------------------------------------------------------------------------

const { TranslationBridge, SILENCE_THRESHOLD_DBFS, SILENCE_GATING_OFF_DBFS } = await import(
  "./translation-bridge.ts"
);
const { OpenAIProvider } = await import("./openai-provider.ts");
const { GeminiProvider } = await import("./gemini-provider.ts");

const ORGANIZER = "organizer-host";

/**
 * Frames the provider has received, across every socket it opened — a `goAway` reconnect
 * makes a new one, and we don't care which socket the audio landed on, only that it landed.
 */
const framesToProvider = () =>
  FakeProviderSocket.instances.reduce((n, s) => n + s.audioFramesReceived.length, 0);

/** Speak `count` 100ms frames into a mic track and let them propagate. */
async function speak(track: FakeRemoteTrack, count = 3): Promise<void> {
  for (let i = 0; i < count; i++) {
    track.push(new FakeAudioFrame());
    await vi.advanceTimersByTimeAsync(10);
  }
}

/**
 * A 100ms frame loud enough to read as *voice* (~-18 dBFS, well above the -30 voice bar),
 * as opposed to the all-zero `FakeAudioFrame()` an open mic streams during a pause. The
 * silence-gating path only cares about this distinction: voice resets the suspend clock,
 * true silence does not.
 */
function voiceFrame(): FakeAudioFrame {
  return new FakeAudioFrame(new Int16Array(1600).fill(4000));
}

/** Speak `count` frames of real voice into a mic track. */
async function speakVoice(track: FakeRemoteTrack, count = 3): Promise<void> {
  for (let i = 0; i < count; i++) {
    track.push(voiceFrame());
    await vi.advanceTimersByTimeAsync(10);
  }
}

/**
 * Hold the mic open but silent for `ms`, delivering one room-tone frame every 100ms just
 * like a real open mic. The frames matter: each one stamps the bridge's liveness signal, so
 * this is a *live input that happens to be quiet* — not a dead one. That difference is the
 * whole point of the two paths meeting.
 */
async function holdSilence(track: FakeRemoteTrack, ms: number): Promise<void> {
  const steps = Math.round(ms / 100);
  for (let i = 0; i < steps; i++) {
    track.push(new FakeAudioFrame());
    await vi.advanceTimersByTimeAsync(100);
  }
}

/**
 * Start a bridge. `seat` runs once the bridge has a Room but before its provider handshake
 * completes, which is where the room's starting state gets decided (and where outage 1's
 * race lives). Whatever `seat` returns is handed back to the test.
 */
async function boot<T>(
  seat: (room: FakeRoom) => T,
  configOverrides: Partial<ConstructorParameters<typeof TranslationBridge>[3]> = {},
  language = "fr"
): Promise<{
  bridge: InstanceType<typeof TranslationBridge>;
  room: FakeRoom;
  seated: T;
}> {
  const bridge = new TranslationBridge("doc-test", language, ORGANIZER, {
    geminiApiKey: "fake-key",
    livekitUrl: "wss://fake.livekit",
    livekitApiKey: "fake",
    livekitApiSecret: "fake",
    ...configOverrides,
  });
  const started = bridge.start();
  await vi.advanceTimersByTimeAsync(10); // the bridge has constructed its Room
  const room = lastRoom as FakeRoom;
  const seated = seat(room);
  await vi.advanceTimersByTimeAsync(300); // connectProvider polls for readiness every 100ms
  await started;
  await vi.advanceTimersByTimeAsync(10); // deliver the pending TrackSubscribed
  return { bridge, room, seated };
}

describe("TranslationBridge (end-to-end, faked LiveKit + provider)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeProviderSocket.instances = [];
    FakeProviderSocket.openaiHandshake = "full";
    FakeAudioSource.instances = [];
    FakeAudioStream.instances = [];
    lastRoom = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pipes the organizer's mic to Gemini (happy path)", async () => {
    const { bridge, seated: mic } = await boot((room) => room.seatOrganizer(ORGANIZER));

    await speak(mic, 3);

    expect(framesToProvider()).toBe(3);
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

    expect(framesToProvider()).toBe(2);
    await bridge.stop();
  });

  it("survives a LiveKit full reconnect (outage 2: 2026-07-12)", async () => {
    // The regression test this whole rework exists for. Before the fix the bridge stayed
    // `active` here and streamed silence to Gemini until someone redeployed the server.
    const { bridge, room, seated: mic } = await boot((r) => r.seatOrganizer(ORGANIZER));

    await speak(mic, 3);
    expect(framesToProvider()).toBe(3);

    // LiveKit rebuilds the session. The bridge is handed nothing but ParticipantConnected
    // and a dead AudioStream: no TrackPublished, no Disconnected, no error.
    const newMic = room.fullReconnect();
    await vi.advanceTimersByTimeAsync(50);

    // The speaker keeps talking, now into the new track object.
    await speak(newMic, 4);

    expect(framesToProvider()).toBe(7); // audio resumed — we are not deaf
    expect(bridge.status).toBe("active");
    await bridge.stop();
  });

  it("recovers when the input dies with no room event at all (the unknown-unknown)", async () => {
    // Neither outage's trigger: the media path just stops and LiveKit tells us nothing --
    // no reconnect, no unsubscribe, no disconnect, no error. Only reconciling from a
    // liveness signal can catch this, which is what the stall watchdog is for.
    const { bridge, room, seated: mic } = await boot((r) => r.seatOrganizer(ORGANIZER));

    await speak(mic, 2);
    expect(framesToProvider()).toBe(2);

    // Swap the organizer's publication behind the bridge's back and kill the old stream.
    mic.end();
    const organizer = room.remoteParticipants.get(ORGANIZER) as FakeParticipant;
    organizer.trackPublications.clear();
    const newMic = new FakeRemoteTrack();
    organizer.publish(new FakePublication(newMic, organizer, room));

    // Let the watchdog run (15s stall threshold, checked every 5s).
    await vi.advanceTimersByTimeAsync(25_000);
    await speak(newMic, 3);

    expect(framesToProvider()).toBe(5);
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

    expect(framesToProvider()).toBe(4);
    await bridge.stop();
  });

  it("is recreatable, not a zombie, after an unexpected room disconnect", async () => {
    // A room Disconnected the bridge didn't ask for (duplicate identity, LiveKit server
    // restart, lost connectivity). Before the fix this set status="closed" and nothing
    // else: the bridge stayed in the manager's map looking deliberately stopped, held
    // its Gemini socket open, and the language was dead until a brand-new listener
    // happened to request it. Now it must read as failed ("error", which ensureBridge
    // treats as stale) with the Gemini side torn down.
    const events: string[] = [];
    const { bridge, room, seated: mic } = await boot((r) => r.seatOrganizer(ORGANIZER), {
      recordEvent: (event: string) => events.push(event),
    });
    await speak(mic, 2);
    expect(framesToProvider()).toBe(2);

    room.emit(RoomEvent.Disconnected, 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(bridge.status).toBe("error");
    expect(events).toContain("livekit_disconnected");
    // No paid-for zombie: every Gemini socket is closed.
    for (const socket of FakeProviderSocket.instances) {
      expect(socket.readyState).not.toBe(FakeProviderSocket.OPEN);
    }

    // A deliberate stop stays "closed" — the disconnect its room.disconnect() emits
    // must not be mistaken for a failure.
    await bridge.stop();
    expect(bridge.status).toBe("closed");
  });

  it("escalates to teardown when reconcile cannot bring a dead input back", async () => {
    // The watchdog's level-1 recovery (reconcile) assumes re-subscribing fixes the pipe.
    // Here it doesn't: the publication still exists and claims to be subscribed, but its
    // stream is dead and no replacement ever appears. Before the fix the bridge
    // reconciled forever, deaf but "active". Now, after repeated fruitless recoveries,
    // it must tear itself down — leaving the room so listeners see the translator gone
    // and re-request the language, which recreates the bridge from scratch.
    const events: string[] = [];
    const { bridge, seated: mic } = await boot((r) => r.seatOrganizer(ORGANIZER), {
      recordEvent: (event: string) => events.push(event),
    });
    await speak(mic, 2);
    expect(framesToProvider()).toBe(2);

    // The stream dies; the publication stays, already-subscribed, so reconcile is a no-op.
    mic.end();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(events).toContain("organizer_audio_stalled"); // level 1 was tried...
    expect(events).toContain("organizer_audio_unrecoverable"); // ...and gave way to level 2
    expect(bridge.status).toBe("closed"); // stop(): out of the room, recreatable on demand
  });

  it("drops a setupComplete that lost a race with stop() — no socket resurrection", async () => {
    // The epoch guard. A goAway starts a make-before-break replacement; the bridge is
    // stopped before that socket finishes setup, but its setupComplete is already in
    // flight. Pre-fix, onSocketReady swapped the dead-on-arrival socket in anyway —
    // an open, paid-for Gemini session strapped to a closed bridge, invisible to
    // every monitor. The guard must drop it instead.
    const events: string[] = [];
    const { bridge, seated: mic } = await boot((r) => r.seatOrganizer(ORGANIZER), {
      recordEvent: (event: string) => events.push(event),
    });
    await speak(mic, 1);

    // Gemini warns it will terminate → the bridge opens a pending replacement...
    FakeProviderSocket.instances[0].emit(
      "message",
      Buffer.from(JSON.stringify({ goAway: { timeLeft: "5s" } }))
    );
    // ...and the bridge is stopped before that replacement completes setup.
    await bridge.stop();
    await vi.advanceTimersByTimeAsync(100); // the replacement's setupComplete lands now

    expect(events.filter((e) => e === "gemini_session_setup_complete")).toHaveLength(1); // initial only
    expect(events).toContain("gemini_stale_socket_dropped");
    expect(bridge.status).toBe("closed");
  });

  it("never escalates against a muted mic — that silence is expected", async () => {
    // Same dead-frames signal, opposite meaning: the organizer muted their mic. Frames
    // stopping is correct behavior, and recreating the bridge wouldn't (and shouldn't)
    // end it — escalation here would churn a Gemini session every ~45s for the whole
    // mute. The mute state on the publication is what tells the two apart.
    const events: string[] = [];
    const { bridge, room, seated: mic } = await boot((r) => r.seatOrganizer(ORGANIZER), {
      recordEvent: (event: string) => events.push(event),
    });
    await speak(mic, 2);

    mic.end();
    const organizer = room.remoteParticipants.get(ORGANIZER) as FakeParticipant;
    for (const [, pub] of organizer.trackPublications) pub.muted = true;
    await vi.advanceTimersByTimeAsync(90_000);

    expect(events).not.toContain("organizer_audio_unrecoverable");
    expect(bridge.status).toBe("active");
    await bridge.stop();
  });

  // -------------------------------------------------------------------------
  // Silence gating × stall watchdog — the seam the merge created.
  //
  // These two subsystems arrived on different branches and now coexist in
  // sendAudioToProvider: the watchdog treats "no organizer frames" as a dead input to
  // rebuild, while silence gating treats "no *voice*" as a cue to suspend Gemini to save
  // cost. They read the same frames and must not fight. The load-bearing decision in the
  // merge is that liveness is stamped on *every* organizer frame, silence included —
  // BEFORE the suspend early-return — so a quiet speaker is never mistaken for a dead mic.
  //
  // The timing is what makes this sharp: the stall threshold (15s) is crossed well before
  // the silence-suspend window (30s). A merge that stamped liveness only on voice, or only
  // after the suspend check, would have the watchdog tear down a perfectly healthy input
  // 15s into every long pause.
  // -------------------------------------------------------------------------

  it("a long pause suspends Gemini WITHOUT the watchdog tearing down the live input", async () => {
    const events: string[] = [];
    const { bridge, seated: mic } = await boot((room) => room.seatOrganizer(ORGANIZER), {
      silenceThresholdDbfs: SILENCE_THRESHOLD_DBFS,
      recordEvent: (event: string) => events.push(event),
    });

    await speakVoice(mic, 3);
    expect(framesToProvider()).toBeGreaterThanOrEqual(3);

    // 29s of open-mic room tone: past the 15s stall threshold, short of the 30s suspend.
    await holdSilence(mic, 29_000);
    // The merge's core assertion: silence frames keep the liveness signal fresh, so the
    // watchdog must NOT confuse a pause with a dead input.
    expect(events).not.toContain("organizer_audio_stalled");
    expect(events).not.toContain("gemini_suspended_silence");
    expect(bridge.status).toBe("active");

    // Keep quiet past the 30s window: now the *cost* path acts and suspends Gemini —
    // and still without the watchdog firing, because frames are still arriving.
    await holdSilence(mic, 10_000);
    expect(events).toContain("gemini_suspended_silence");
    expect(events).not.toContain("organizer_audio_stalled");

    // Speech returns → Gemini resumes and audio reaches it again (buffered pre-roll +
    // fresh frames flushed into the new session).
    const before = framesToProvider();
    await speakVoice(mic, 4);
    await vi.advanceTimersByTimeAsync(300); // let the replacement socket set up and flush
    expect(events).toContain("gemini_resumed_voice");
    expect(framesToProvider()).toBeGreaterThan(before);
    await bridge.stop();
  });

  it("with silence gating ON, a truly dead input still trips the watchdog", async () => {
    // The other direction of the seam: enabling the cost path must not smother the
    // resilience path. Here the input genuinely dies — no frames of any kind, not even
    // silence — so the liveness signal goes stale and the watchdog is the only thing that
    // can notice. (Same failure as the "unknown-unknown" test, now with gating enabled.)
    const events: string[] = [];
    const { bridge, room, seated: mic } = await boot((r) => r.seatOrganizer(ORGANIZER), {
      silenceThresholdDbfs: SILENCE_THRESHOLD_DBFS,
      recordEvent: (event: string) => events.push(event),
    });

    await speakVoice(mic, 2);
    expect(framesToProvider()).toBeGreaterThanOrEqual(2);

    // Swap the publication behind the bridge's back and kill the old stream — no frames
    // arrive on the new one until we resubscribe.
    mic.end();
    const organizer = room.remoteParticipants.get(ORGANIZER) as FakeParticipant;
    organizer.trackPublications.clear();
    const newMic = new FakeRemoteTrack();
    organizer.publish(new FakePublication(newMic, organizer, room));

    // 20s: past the 15s stall threshold, still short of the 30s suspend window (so this is
    // unambiguously the watchdog's recovery, not a silence suspend).
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events).toContain("organizer_audio_stalled");
    expect(events).not.toContain("gemini_suspended_silence");

    // Audio flows again through the resubscribed track.
    const before = framesToProvider();
    await speakVoice(newMic, 3);
    expect(framesToProvider()).toBeGreaterThan(before);
    await bridge.stop();
  });

  // Gating off is expressed as a voice bar of -Infinity rather than a separate flag, so
  // these two pin down that the bar alone really does mean "never suspends" — across both
  // routes into suspendForSilence. Without that, "off" would be a config that runs half
  // the gating machinery, which is exactly the shape that made this hard to reason about.

  it("with the voice bar off, open-mic room tone never suspends Gemini", async () => {
    // The per-frame route. Room tone is digital silence here (-Infinity dBFS), the worst
    // case for a `>=` test — it still has to read as voice at the off bar, or the quietest
    // possible input would be the one thing that suspends a bridge with gating disabled.
    const events: string[] = [];
    const { bridge, seated: mic } = await boot((room) => room.seatOrganizer(ORGANIZER), {
      silenceThresholdDbfs: SILENCE_GATING_OFF_DBFS,
      recordEvent: (event: string) => events.push(event),
    });

    await speakVoice(mic, 3);
    await holdSilence(mic, 90_000); // 3x the suspend window
    expect(events).not.toContain("gemini_suspended_silence");
    expect(bridge.status).toBe("active");
    await bridge.stop();
  });

  it("with the voice bar off, a muted mic sending nothing never suspends Gemini", async () => {
    // The timer route, and the reason the off bar is checked when starting the monitor
    // instead of being left to fall out of the per-frame test: with no frames arriving
    // there is nothing to read as voice, `lastVoiceAt` just stops advancing, and the
    // window elapses on a bridge that is supposed to stay up. The stall watchdog may
    // fire here — a genuinely dead input is its job — but suspending is not.
    const events: string[] = [];
    const { bridge } = await boot((room) => room.seatOrganizer(ORGANIZER), {
      silenceThresholdDbfs: SILENCE_GATING_OFF_DBFS,
      recordEvent: (event: string) => events.push(event),
    });

    await vi.advanceTimersByTimeAsync(45_000); // past the 30s suspend window, no frames at all
    expect(events).not.toContain("gemini_suspended_silence");
    await bridge.stop();
  });

  // -------------------------------------------------------------------------
  // The second provider.
  //
  // Haitian Creole runs on OpenAI Realtime because Gemini Live Translate has no voice
  // for it. The bridge around it is the *same* bridge — that's the point of the provider
  // seam — so these tests deliberately don't re-test reconnects or the watchdog. They
  // test the two things a new provider can get wrong on its own: the handshake (when is
  // it safe to send audio) and the full audio round trip in both directions.
  // -------------------------------------------------------------------------

  /** A bridge translating into Haitian Creole over the OpenAI protocol. */
  const bootOpenAI = (
    seat: (room: FakeRoom) => FakeRemoteTrack,
    overrides: Partial<ConstructorParameters<typeof TranslationBridge>[3]> = {}
  ) =>
    boot(
      seat,
      {
        provider: new OpenAIProvider(
          { apiKey: "fake-openai-key", targetLanguage: "ht", transcribeInput: false },
          {}
        ),
        ...overrides,
      },
      "ht"
    );

  it("carries Haitian Creole end-to-end over the OpenAI protocol", async () => {
    // Organizer mic → input_audio_buffer.append → (translation) → output audio delta →
    // published LiveKit frame, plus the Creole transcript into Yjs. The whole product,
    // on the provider that exists solely to make this language possible.
    const transcript: Array<[string, string]> = [];
    const writer = {
      appendDelta: (code: string, text: string) => transcript.push([code, text]),
    };
    const { bridge, seated: mic } = await bootOpenAI((room) => room.seatOrganizer(ORGANIZER), {
      writer: writer as unknown as ConstructorParameters<typeof TranslationBridge>[3]["writer"],
    });

    await speak(mic, 3);
    expect(framesToProvider()).toBe(3);
    expect(bridge.status).toBe("active");

    // The model answers with Creole audio and its transcript.
    const socket = FakeProviderSocket.instances[0];
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.alloc(480).toString("base64") })
      )
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "Bonjou tout moun" })
      )
    );
    await vi.advanceTimersByTimeAsync(10);

    // Translated audio reached a LiveKit track, and the transcript reached Yjs under the
    // Creole code (not the source code — that would overwrite the English transcript).
    expect(FakeAudioSource.instances[0].captured).toHaveLength(1);
    expect(transcript).toEqual([["ht", "Bonjou tout moun"]]);

    await bridge.stop();
  });

  it("asks LiveKit for each provider's own input sample rate", async () => {
    // Gemini wants 16 kHz, OpenAI 24 kHz, and the bridge declares that rate to the
    // provider — so a mismatch isn't an error anywhere, just audio that arrives at the
    // wrong speed and pitch and translates badly. Nothing but this pins it.
    const { bridge } = await bootOpenAI((room) => room.seatOrganizer(ORGANIZER));
    expect(FakeAudioStream.instances[0].opts?.sampleRate).toBe(24_000);
    await bridge.stop();

    FakeAudioStream.instances = [];
    const gemini = await boot((room) => room.seatOrganizer(ORGANIZER), {
      provider: new GeminiProvider({
        apiKey: "fake-gemini-key",
        targetLanguage: "fr",
        transcribeInput: false,
      }),
    });
    expect(FakeAudioStream.instances[0].opts?.sampleRate).toBe(16_000);
    await gemini.bridge.stop();
  });

  it("sends no audio to an OpenAI session that never got configured", async () => {
    // `session.created` arrives before our `session.update` is applied — at that moment
    // the model is a plain chatbot with no interpreter instructions. If the bridge read
    // that as ready it would stream the opening of the talk into it and publish whatever
    // came back. So a session stuck at `created` must fail to start, loudly, and leave
    // the supervisor to retry rather than go live half-configured.
    FakeProviderSocket.openaiHandshake = "createdOnly";

    const bridge = new TranslationBridge("doc-test", "ht", ORGANIZER, {
      geminiApiKey: "unused",
      provider: new OpenAIProvider(
        { apiKey: "fake-openai-key", targetLanguage: "ht", transcribeInput: false },
        {}
      ),
      livekitUrl: "wss://fake.livekit",
      livekitApiKey: "fake",
      livekitApiSecret: "fake",
    });
    const started = bridge.start();
    // Claim the rejection before advancing time — the timeout fires inside the tick
    // below, and an unclaimed rejection there is an unhandled one.
    const rejects = expect(started).rejects.toThrow(/setup timeout/);
    await vi.advanceTimersByTimeAsync(10);
    (lastRoom as FakeRoom).seatOrganizer(ORGANIZER);
    // The setup timeout is 15s; nothing but session.created ever arrives.
    await vi.advanceTimersByTimeAsync(16_000);

    await rejects;
    expect(bridge.status).toBe("error");
    expect(framesToProvider()).toBe(0);
    await bridge.stop();
  });
});
