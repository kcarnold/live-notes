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
  /**
   * How many AudioStreams have been opened over this track — i.e. how many times the
   * bridge decided to pipe it. Stands in for the native FFI stream a real pipe allocates,
   * so a test can assert "no pipe was opened" directly rather than inferring it from the
   * absence of frames (which a torn-down Gemini socket would suppress anyway).
   */
  streamsOpened = 0;

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
    this.releaseWaiter();
  }

  /** A reader let go of us (cancel): its pending read resolves, the track lives on. */
  releaseWaiter(): void {
    if (!this.waiter) return;
    const w = this.waiter;
    this.waiter = null;
    w({ done: true, value: undefined as never });
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

/**
 * A reader over one track. `cancel()` detaches *this reader* without killing the track —
 * which is the case that matters: the 2026-08-01 bug is a track that keeps producing
 * frames after the bridge should have stopped listening to it. A fake whose cancel ended
 * the track would make the fix look correct for the wrong reason.
 */
class FakeReader {
  private cancelled = false;
  constructor(private readonly track: FakeRemoteTrack) {}

  async read(): Promise<IteratorResult<FakeAudioFrame>> {
    if (this.cancelled) return { done: true, value: undefined as never };
    const result = await this.track.read();
    if (this.cancelled) return { done: true, value: undefined as never };
    return result;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.track.releaseWaiter();
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
  constructor(private readonly track: FakeRemoteTrack) {
    track.streamsOpened++;
  }
  getReader(): FakeReader {
    return new FakeReader(this.track);
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
   * The organizer leaves the room and comes back — what the scheduled audio feeder does at
   * every run boundary, four times in the 2026-08-01 log.
   *
   * The load-bearing detail: LiveKit announces the departure (TrackUnsubscribed, then
   * ParticipantDisconnected) but does **not** end the old AudioStream. It goes quiet while
   * they are away and starts producing again when they return. A bridge that treats those
   * events as news rather than as a teardown instruction ends up with two live pipes into
   * one Gemini session — and Gemini, fed at 2x and emitting at 1x, falls a second behind
   * per second of speech forever.
   *
   * `announceDeparture: false` removes even those two events, leaving only the rejoin.
   */
  organizerRejoins(
    identity: string,
    { announceDeparture = true }: { announceDeparture?: boolean } = {}
  ): FakeRemoteTrack {
    const departing = this.remoteParticipants.get(identity) as FakeParticipant;
    if (announceDeparture) {
      for (const [, pub] of departing.trackPublications) {
        this.emit(RoomEvent.TrackUnsubscribed, pub.track, pub, departing);
      }
      this.emit(RoomEvent.ParticipantDisconnected, departing);
    }

    // Same identity, brand-new participant/publication/track objects — a rejoin, not a resume.
    this.replaced = departing;
    this.remoteParticipants.delete(identity);
    const participant = new FakeParticipant(identity);
    const track = new FakeRemoteTrack();
    participant.publish(new FakePublication(track, participant, this));
    this.remoteParticipants.set(identity, participant);
    this.emit(RoomEvent.ParticipantConnected, participant);
    return track;
  }

  /** The participant object the most recent `organizerRejoins` replaced. */
  private replaced: FakeParticipant | null = null;

  /**
   * The departure notice for the participant a rejoin already replaced, arriving *after*
   * that rejoin — the ordering LiveKit does not rule out. The server kicks the old session
   * on an identity collision, and that kick can easily reach us behind the new session's
   * subscribe round-trip.
   *
   * Two details are load-bearing, both taken from the SDK's event dispatcher:
   *   - the notice names the *old* participant object, which is the only thing that
   *     distinguishes it from an on-time departure (the identity string is identical);
   *   - the SDK deletes from `remoteParticipants` **by identity** before emitting, so a
   *     stale notice evicts whoever currently holds the identity — the rejoined
   *     participant. That is why an over-eager close here is not recoverable: reconcile
   *     walks `remoteParticipants` and, after this, finds no organizer to re-subscribe.
   */
  announceLateDeparture(): void {
    const departed = this.replaced;
    if (!departed) throw new Error("no rejoin has happened for a departure to lag behind");
    this.remoteParticipants.delete(departed.identity);
    this.emit(RoomEvent.ParticipantDisconnected, departed);
  }

  /**
   * The subscription drops while the organizer stays put (LiveKit bandwidth management, a
   * subscription reset). The pipe must end *and* come back: the fix must not buy its
   * correctness by leaving the bridge deaf.
   */
  unsubscribeOrganizerTrack(identity: string): void {
    const participant = this.remoteParticipants.get(identity) as FakeParticipant;
    for (const [, pub] of participant.trackPublications) {
      pub.subscribed = false; // so a reconcile can genuinely re-subscribe
      this.emit(RoomEvent.TrackUnsubscribed, pub.track, pub, participant);
    }
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
  /** Setup messages this socket was handed, so tests can assert what we asked Gemini for. */
  readonly setups: Record<string, unknown>[] = [];

  constructor(readonly url: string) {
    super();
    FakeGeminiSocket.instances.push(this);
    setTimeout(() => this.emit("open"), 0);
  }

  send(raw: string): void {
    const msg = JSON.parse(raw);
    if (msg.setup) {
      this.setups.push(msg.setup);
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

  /** Push a serverContent message at the bridge, as Gemini would. */
  deliver(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}

vi.mock("ws", () => ({ default: FakeGeminiSocket }));

// ---------------------------------------------------------------------------

const { TranslationBridge, SILENCE_THRESHOLD_DBFS, SILENCE_GATING_OFF_DBFS } = await import(
  "./translation-bridge.ts"
);

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
 * Start a bridge. `seat` runs once the bridge has a Room but before its Gemini handshake
 * completes, which is where the room's starting state gets decided (and where outage 1's
 * race lives). Whatever `seat` returns is handed back to the test.
 */
async function boot<T>(
  seat: (room: FakeRoom) => T,
  configOverrides: Partial<ConstructorParameters<typeof TranslationBridge>[3]> = {}
): Promise<{
  bridge: InstanceType<typeof TranslationBridge>;
  room: FakeRoom;
  seated: T;
}> {
  const bridge = new TranslationBridge("doc-test", "fr", ORGANIZER, {
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

  // -------------------------------------------------------------------------
  // Outage 3 (2026-08-01): fed twice, not once.
  //
  // Every earlier test asks "is audio still reaching Gemini?". These ask the question
  // that failure inverted: is it reaching Gemini *only once*? The bridge stayed active
  // and audible the whole time — it just fell further behind every minute, because the
  // organizer's rejoin left the previous pipe running alongside the new one. Counting
  // frames is the entire assertion; a test that only checked "> 0" would pass on the bug.
  // -------------------------------------------------------------------------

  it("feeds Gemini once, not twice, when the organizer leaves and rejoins", async () => {
    const { bridge, room, seated: oldMic } = await boot((r) => r.seatOrganizer(ORGANIZER));

    await speak(oldMic, 2);
    expect(framesToGemini()).toBe(2);

    const newMic = room.organizerRejoins(ORGANIZER);
    await vi.advanceTimersByTimeAsync(50);

    // The old media path was never torn down by LiveKit, so it resumes right alongside
    // the new one. Only the new one may reach Gemini.
    await speak(oldMic, 5);
    await speak(newMic, 3);

    expect(framesToGemini()).toBe(5); // 2 before + 3 after; the orphan's 5 are dropped
    expect(bridge.status).toBe("active");
    await bridge.stop();
  });

  it("supersedes an orphaned pipe even when no departure event fires at all", async () => {
    // The defense that doesn't depend on getting LiveKit's event vocabulary right — the
    // same reasoning as reconcile, applied to teardown. Here the organizer's rejoin is the
    // *only* thing the bridge is told; no TrackUnsubscribed, no ParticipantDisconnected.
    const events: string[] = [];
    const { bridge, room, seated: oldMic } = await boot((r) => r.seatOrganizer(ORGANIZER), {
      recordEvent: (event: string) => events.push(event),
    });
    await speak(oldMic, 1);

    const newMic = room.organizerRejoins(ORGANIZER, { announceDeparture: false });
    await vi.advanceTimersByTimeAsync(50);

    await speak(oldMic, 4);
    await speak(newMic, 2);

    expect(framesToGemini()).toBe(3); // 1 + 2
    // ...and it says so, because a supersede here means an event we should have handled.
    expect(events).toContain("organizer_audio_pipe_superseded");
    await bridge.stop();
  });

  it("re-pipes after an unsubscribe — teardown must not leave the bridge deaf", async () => {
    // The other side of the fix. Closing the pipe on TrackUnsubscribed is only correct if
    // the subscription coming back brings audio with it; a fix that just stopped listening
    // would pass both tests above and lose the service.
    const { bridge, room, seated: mic } = await boot((r) => r.seatOrganizer(ORGANIZER));
    await speak(mic, 2);

    room.unsubscribeOrganizerTrack(ORGANIZER);
    await vi.advanceTimersByTimeAsync(50); // close → reconcile → re-subscribe → re-pipe

    await speak(mic, 3);

    expect(framesToGemini()).toBe(5); // resumed, and still exactly once per frame
    expect(bridge.status).toBe("active");
    await bridge.stop();
  });

  it("keeps the rejoin's pipe when the old session's departure notice arrives late", async () => {
    // The mirror image of the two tests above, and the case an over-eager teardown gets
    // wrong. LiveKit does not guarantee that "the old session left" is delivered before
    // "the new session joined" — on an identity collision the server's kick races the
    // rejoin's subscribe round-trip. A bridge that reacts to the leave by closing whatever
    // the organizer had open then retires the pipe it opened moments ago, and cannot get
    // it back (see FakeRoom.announceLateDeparture): reconcile has no organizer left to
    // find in the room, and the stall watchdog won't escalate for a mic it can't see, so
    // the bridge sits `active` and permanently deaf. Closing by participant *object* is
    // what makes the stale notice a no-op.
    const { bridge, room, seated: oldMic } = await boot((r) => r.seatOrganizer(ORGANIZER));
    await speak(oldMic, 1);

    const newMic = room.organizerRejoins(ORGANIZER, { announceDeparture: false });
    await vi.advanceTimersByTimeAsync(50);
    await speak(newMic, 2);
    expect(framesToGemini()).toBe(3); // the rejoin is live and feeding

    room.announceLateDeparture();
    await vi.advanceTimersByTimeAsync(50);

    await speak(newMic, 4);
    expect(framesToGemini()).toBe(7); // ...and still feeding afterwards
    expect(bridge.status).toBe("active");
    await bridge.stop();
  });

  it("stops feeding Gemini once the bridge is stopped, even if the mic keeps streaming", async () => {
    // stop() disconnects the room, but the track object in a test (and an FFI stream in
    // production) can outlive that. Nothing may reach a torn-down Gemini session.
    const { bridge, seated: mic } = await boot((r) => r.seatOrganizer(ORGANIZER));
    await speak(mic, 2);

    await bridge.stop();
    const after = framesToGemini();
    await speak(mic, 5);

    expect(framesToGemini()).toBe(after);
    // The frame count alone would pass on a bridge that never stopped reading, because a
    // torn-down Gemini socket drops frames anyway. The buffer is where a still-running
    // read loop actually shows up.
    expect(bridge.health().bufferedFrames).toBe(0);
  });

  it("opens no pipe for a subscription that lands after the bridge is stopped", async () => {
    // LiveKit events are FFI-queued, so a TrackSubscribed can be delivered during stop()'s
    // `await room.disconnect()` or after a fatal Disconnected. A pipe opened then is
    // unreachable by every teardown path that has already run — a native AudioStream and a
    // read loop that outlive the bridge the supervisor has discarded, once per recycle.
    const { bridge, room, seated: mic } = await boot((r) => r.seatOrganizer(ORGANIZER));
    await speak(mic, 1);

    await bridge.stop();

    const organizer = room.remoteParticipants.get(ORGANIZER) as FakeParticipant;
    const strayTrack = new FakeRemoteTrack();
    room.emit(
      RoomEvent.TrackSubscribed,
      strayTrack,
      new FakePublication(strayTrack, organizer, room),
      organizer
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(strayTrack.streamsOpened).toBe(0);
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
    expect(framesToGemini()).toBe(2);

    room.emit(RoomEvent.Disconnected, 0);
    await vi.advanceTimersByTimeAsync(10);

    expect(bridge.status).toBe("error");
    expect(events).toContain("livekit_disconnected");
    // No paid-for zombie: every Gemini socket is closed.
    for (const socket of FakeGeminiSocket.instances) {
      expect(socket.readyState).not.toBe(FakeGeminiSocket.OPEN);
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
    expect(framesToGemini()).toBe(2);

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
    FakeGeminiSocket.instances[0].emit(
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
  // sendAudioToGemini: the watchdog treats "no organizer frames" as a dead input to
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
    expect(framesToGemini()).toBeGreaterThanOrEqual(3);

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
    const before = framesToGemini();
    await speakVoice(mic, 4);
    await vi.advanceTimersByTimeAsync(300); // let the replacement socket set up and flush
    expect(events).toContain("gemini_resumed_voice");
    expect(framesToGemini()).toBeGreaterThan(before);
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
    expect(framesToGemini()).toBeGreaterThanOrEqual(2);

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
    const before = framesToGemini();
    await speakVoice(newMic, 3);
    expect(framesToGemini()).toBeGreaterThan(before);
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
  // Which language the two transcripts are filed under. Getting this wrong is the
  // quietest failure in the system: everything keeps flowing, and a Spanish talk is
  // simply recorded — and exported, and labelled in the picker — as English.
  // -------------------------------------------------------------------------

  it("files the speaker's own words under the language being spoken", async () => {
    const appended: Array<[string, string]> = [];
    const transcript = {
      append: (code: string, text: string) => appended.push([code, text]),
    };
    const { bridge } = await boot((room) => room.seatOrganizer(ORGANIZER), {
      transcript: transcript as unknown as ConstructorParameters<
        typeof TranslationBridge
      >[3]["transcript"],
      writesSourceTranscript: true,
      sourceLanguage: "es",
    });

    FakeGeminiSocket.instances[0].deliver({
      serverContent: {
        inputTranscription: { text: "Buenos días." },
        outputTranscription: { text: "Good morning." },
      },
    });
    await vi.advanceTimersByTimeAsync(10);

    // The target transcript goes under the bridge's own language, as always; the input
    // one goes under what was actually said, not under a hard-coded `en`.
    expect(appended).toEqual([
      ["fr", "Good morning."],
      ["es", "Buenos días."],
    ]);
    await bridge.stop();
  });

  it("asks Gemini to detect the spoken language rather than naming it", async () => {
    // Gemini Live Translate has no source-language field — it detects the input itself,
    // which is exactly what lets a non-English speaker work at all. If a future setup
    // change ever tries to pin it, this is where that shows up.
    const { bridge } = await boot((room) => room.seatOrganizer(ORGANIZER), {
      writesSourceTranscript: true,
      sourceLanguage: "es",
    });

    const setup = FakeGeminiSocket.instances[0].setups[0];
    expect(setup).toHaveProperty("inputAudioTranscription");
    const translationConfig = (setup.generationConfig as { translationConfig: object })
      .translationConfig;
    // The target is named; the source is conspicuously absent — no sourceLanguageCode,
    // no locale hint, nothing that could pin detection to the wrong language.
    expect(Object.keys(translationConfig).sort()).toEqual([
      "echoTargetLanguage",
      "targetLanguageCode",
    ]);
    expect((translationConfig as { targetLanguageCode: string }).targetLanguageCode).toBe("fr");
    await bridge.stop();
  });
});
