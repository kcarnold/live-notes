import { describe, expect, it } from "vitest";

import {
  nextBackoffMs,
  parseGoAwayTimeLeftMs,
  wireOrganizerAudioSubscription,
  type AudioParticipantLike,
  type AudioPublicationLike,
} from "./translation-bridge.ts";

// The Gemini Live session is periodically terminated; the bridge reconnects with
// backoff and reads the goAway `timeLeft` to reconnect proactively. These pure
// helpers back that logic and are the testable seams (the socket plumbing is not).
describe("parseGoAwayTimeLeftMs", () => {
  it("parses protobuf Duration strings (seconds)", () => {
    expect(parseGoAwayTimeLeftMs("10s")).toBe(10_000);
    expect(parseGoAwayTimeLeftMs("10.5s")).toBe(10_500);
    expect(parseGoAwayTimeLeftMs(" 2s ")).toBe(2_000);
  });

  it("parses a bare numeric string as seconds", () => {
    expect(parseGoAwayTimeLeftMs("10")).toBe(10_000);
  });

  it("parses a number as seconds", () => {
    expect(parseGoAwayTimeLeftMs(7)).toBe(7_000);
  });

  it("parses an expanded { seconds, nanos } Duration object", () => {
    expect(parseGoAwayTimeLeftMs({ seconds: 8 })).toBe(8_000);
    expect(parseGoAwayTimeLeftMs({ seconds: "8", nanos: 500_000_000 })).toBe(8_500);
  });

  it("returns null for missing or unparseable values", () => {
    expect(parseGoAwayTimeLeftMs(null)).toBeNull();
    expect(parseGoAwayTimeLeftMs(undefined)).toBeNull();
    expect(parseGoAwayTimeLeftMs("soon")).toBeNull();
    expect(parseGoAwayTimeLeftMs({})).toBeNull();
  });
});

describe("nextBackoffMs", () => {
  const opts = { initialMs: 1_000, maxMs: 30_000 };

  it("returns a value in [cap/2, cap] (equal jitter) for the first attempt", () => {
    for (let i = 0; i < 50; i++) {
      const ms = nextBackoffMs(0, opts);
      expect(ms).toBeGreaterThanOrEqual(500);
      expect(ms).toBeLessThanOrEqual(1_000);
    }
  });

  it("grows the cap exponentially with the attempt", () => {
    // attempt 2 → cap = 4000 → [2000, 4000]
    for (let i = 0; i < 50; i++) {
      const ms = nextBackoffMs(2, opts);
      expect(ms).toBeGreaterThanOrEqual(2_000);
      expect(ms).toBeLessThanOrEqual(4_000);
    }
  });

  it("never exceeds maxMs once the cap saturates", () => {
    for (let i = 0; i < 50; i++) {
      const ms = nextBackoffMs(20, opts);
      expect(ms).toBeGreaterThanOrEqual(15_000);
      expect(ms).toBeLessThanOrEqual(30_000);
    }
  });

  it("uses the default bounds when none are given", () => {
    const ms = nextBackoffMs(0);
    expect(ms).toBeGreaterThanOrEqual(500);
    expect(ms).toBeLessThanOrEqual(1_000);
  });
});

// wireOrganizerAudioSubscription is the fix for a production outage where the
// bridge went "active but deaf": when the organizer was already in the room but
// published their mic a beat late (the join/getUserMedia race), the old early
// return meant no TrackPublished listener was ever registered, so the late track
// was never subscribed and no audio reached Gemini. These tests exercise the four
// publish-timing cases against a fake room that delivers TrackSubscribed
// asynchronously (as LiveKit does), asserting each organizer track is piped once.
describe("wireOrganizerAudioSubscription", () => {
  const ORGANIZER = "organizer-host";

  // A published track. Calling setSubscribed(true) doesn't fire TrackSubscribed
  // inline — the real SDK delivers it after a server round-trip — so we queue it on
  // the room and let the test flush(), which is what makes registration order
  // (enumerate vs. listen) irrelevant, exactly as in production.
  class FakePublication implements AudioPublicationLike {
    subscribed = false;
    setSubscribedCalls = 0;
    constructor(
      readonly track: object,
      readonly participant: FakeParticipant,
      private readonly room: FakeRoom,
      readonly kind: string = "audio"
    ) {}
    setSubscribed(subscribed: boolean): void {
      this.setSubscribedCalls++;
      if (subscribed && !this.subscribed) {
        this.subscribed = true;
        this.room.queueSubscribed(this.track, this, this.participant);
      }
    }
  }

  class FakeParticipant implements AudioParticipantLike {
    readonly trackPublications = new Map<string, FakePublication>();
    constructor(readonly identity: string) {}
    publish(pub: FakePublication): void {
      this.trackPublications.set(String(this.trackPublications.size), pub);
    }
  }

  type PublishedHandler = (pub: AudioPublicationLike, p: AudioParticipantLike) => void;
  type SubscribedHandler = (
    track: object,
    pub: AudioPublicationLike,
    p: AudioParticipantLike
  ) => void;

  class FakeRoom {
    readonly participants: FakeParticipant[] = [];
    private publishedHandlers: PublishedHandler[] = [];
    private subscribedHandlers: SubscribedHandler[] = [];
    private pending: Array<[object, AudioPublicationLike, AudioParticipantLike]> = [];

    participant(identity: string): FakeParticipant {
      const p = new FakeParticipant(identity);
      this.participants.push(p);
      return p;
    }

    onTrackPublished = (h: PublishedHandler) => this.publishedHandlers.push(h);
    onTrackSubscribed = (h: SubscribedHandler) => this.subscribedHandlers.push(h);

    // Simulate the organizer publishing a track after the bridge has started.
    emitPublished(pub: FakePublication, p: FakeParticipant): void {
      p.publish(pub);
      for (const h of this.publishedHandlers) h(pub, p);
    }

    queueSubscribed(track: object, pub: AudioPublicationLike, p: AudioParticipantLike): void {
      this.pending.push([track, pub, p]);
    }

    // Deliver all queued TrackSubscribed events (the async server round-trip).
    flush(): void {
      const batch = this.pending;
      this.pending = [];
      for (const [track, pub, p] of batch) {
        for (const h of this.subscribedHandlers) h(track, pub, p);
      }
    }

    wire(pipe: (track: object) => void): void {
      wireOrganizerAudioSubscription<object>({
        organizerIdentity: ORGANIZER,
        existingParticipants: this.participants,
        isAudio: (pub) => (pub as FakePublication).kind === "audio",
        onTrackPublished: this.onTrackPublished,
        onTrackSubscribed: this.onTrackSubscribed,
        pipe,
      });
    }
  }

  it("subscribes and pipes when the organizer's mic is already published (happy path)", () => {
    const room = new FakeRoom();
    const organizer = room.participant(ORGANIZER);
    const track = {};
    const pub = new FakePublication(track, organizer, room);
    organizer.publish(pub);

    const piped: object[] = [];
    room.wire((t) => piped.push(t));
    room.flush();

    expect(pub.subscribed).toBe(true);
    expect(piped).toEqual([track]);
  });

  it("subscribes and pipes when the organizer joins and publishes later", () => {
    const room = new FakeRoom();
    const piped: object[] = [];
    room.wire((t) => piped.push(t));

    // Organizer wasn't in the room at start; they join and publish now.
    const organizer = room.participant(ORGANIZER);
    const track = {};
    room.emitPublished(new FakePublication(track, organizer, room), organizer);
    room.flush();

    expect(piped).toEqual([track]);
  });

  it("subscribes and pipes when the organizer is present but publishes the mic late (the outage race)", () => {
    const room = new FakeRoom();
    // Organizer is already in the room, but with no published track yet.
    const organizer = room.participant(ORGANIZER);

    const piped: object[] = [];
    room.wire((t) => piped.push(t));

    // The mic track lands a beat after the bridge started — the case the old early
    // return dropped on the floor, leaving the bridge active but deaf.
    const track = {};
    room.emitPublished(new FakePublication(track, organizer, room), organizer);
    room.flush();

    expect(piped).toEqual([track]);
  });

  it("pipes each track exactly once even if TrackSubscribed is delivered twice", () => {
    const room = new FakeRoom();
    const organizer = room.participant(ORGANIZER);
    const track = {};
    const pub = new FakePublication(track, organizer, room);
    organizer.publish(pub);

    const piped: object[] = [];
    room.wire((t) => piped.push(t));
    room.flush();
    // A redundant delivery of the same subscription must not double-pipe.
    room.queueSubscribed(track, pub, organizer);
    room.flush();

    expect(piped).toEqual([track]);
  });

  it("ignores non-organizer participants and non-audio tracks", () => {
    const room = new FakeRoom();
    const organizer = room.participant(ORGANIZER);
    const someoneElse = room.participant("attendee-xyz");
    // Organizer publishes video (not audio); attendee publishes audio.
    organizer.publish(new FakePublication({}, organizer, room, "video"));
    someoneElse.publish(new FakePublication({}, someoneElse, room, "audio"));

    const piped: object[] = [];
    room.wire((t) => piped.push(t));
    room.flush();

    expect(piped).toEqual([]);
  });
});
