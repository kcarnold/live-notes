import { describe, expect, it } from "vitest";

import {
  nextBackoffMs,
  parseGoAwayTimeLeftMs,
  reconcileOrganizerAudio,
  shouldRecoverStalledInput,
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
// reconcileOrganizerAudio is the fix for two production outages, both of which left the
// bridge "active but deaf" — joined, publishing, holding a healthy Gemini socket, and
// receiving no audio at all. Both had the same root cause: subscription was decided once,
// from an event, and then drifted from reality.
//
//   1. The organizer was in the room but published their mic a beat late, and the
//      "organizer is here" path returned early without listening for the publish.
//   2. A LiveKit full reconnect re-created the participants and their tracks as new
//      objects. Per LiveKit's documented sequence that emits ParticipantConnected for
//      everyone already in the room, but *no* TrackPublished for their existing
//      publications — so nothing re-subscribed, and two bridges streamed silence for six
//      minutes while reporting healthy.
//
// Reconciling against current room state makes both unrepresentable: there is no stored
// decision to go stale. These tests pin that — especially that it reads the room as it
// *is*, not as it was when the bridge started.
describe("reconcileOrganizerAudio", () => {
  const ORGANIZER = "organizer-host";

  class FakePublication implements AudioPublicationLike {
    subscribed = false;
    setSubscribedCalls = 0;
    constructor(readonly kind: string = "audio") {}
    setSubscribed(subscribed: boolean): void {
      this.setSubscribedCalls++;
      this.subscribed = subscribed;
    }
  }

  class FakeParticipant implements AudioParticipantLike {
    readonly trackPublications = new Map<string, FakePublication>();
    constructor(readonly identity: string) {}
    publish(pub: FakePublication): this {
      this.trackPublications.set(String(this.trackPublications.size), pub);
      return this;
    }
  }

  const reconcile = (participants: FakeParticipant[]) =>
    reconcileOrganizerAudio({
      organizerIdentity: ORGANIZER,
      participants,
      isAudio: (pub) => (pub as FakePublication).kind === "audio",
    });

  it("subscribes to the organizer's published audio", () => {
    const mic = new FakePublication();
    const organizer = new FakeParticipant(ORGANIZER).publish(mic);

    expect(reconcile([organizer])).toBe(1);
    expect(mic.subscribed).toBe(true);
  });

  it("is a no-op when the organizer is present but hasn't published yet (outage 1's race)", () => {
    // The bridge starts inside the organizer's join/getUserMedia window. Reconcile finds
    // nothing to do — and, crucially, stores no decision that would need undoing. The
    // TrackPublished trigger will simply run it again a moment later.
    const organizer = new FakeParticipant(ORGANIZER);

    expect(reconcile([organizer])).toBe(0);
  });

  it("subscribes to the organizer's new track objects after a full reconnect (outage 2)", () => {
    const firstMic = new FakePublication();
    const before = new FakeParticipant(ORGANIZER).publish(firstMic);
    expect(reconcile([before])).toBe(1);

    // LiveKit rebuilds the session: same identity, brand-new participant and publication
    // objects, and no TrackPublished event. Reconcile reads the room as it is now.
    const republishedMic = new FakePublication();
    const after = new FakeParticipant(ORGANIZER).publish(republishedMic);

    expect(reconcile([after])).toBe(1);
    expect(republishedMic.subscribed).toBe(true);
  });

  it("is idempotent — repeated reconciles don't thrash the subscription", () => {
    // The watchdog reconciles on a timer, and several triggers can fire at once. None of
    // that may disturb a healthy subscription.
    const mic = new FakePublication();
    const organizer = new FakeParticipant(ORGANIZER).publish(mic);

    reconcile([organizer]);
    reconcile([organizer]);
    reconcile([organizer]);

    expect(mic.subscribed).toBe(true);
    expect(mic.setSubscribedCalls).toBe(3); // always true, never toggled off
  });

  it("ignores non-organizer participants and the organizer's non-audio tracks", () => {
    const organizerVideo = new FakePublication("video");
    const organizer = new FakeParticipant(ORGANIZER).publish(organizerVideo);
    // Another translator bot's published audio, and an attendee — neither is our input.
    const otherBot = new FakeParticipant("translator-es").publish(new FakePublication());
    const attendee = new FakeParticipant("attendee-xyz").publish(new FakePublication());

    expect(reconcile([organizer, otherBot, attendee])).toBe(0);
    expect(organizerVideo.subscribed).toBe(false);
  });

  it("subscribes to every organizer audio publication, not just the first", () => {
    const a = new FakePublication();
    const b = new FakePublication();
    const organizer = new FakeParticipant(ORGANIZER).publish(a).publish(b);

    expect(reconcile([organizer])).toBe(2);
    expect(a.subscribed && b.subscribed).toBe(true);
  });

  it("tolerates an empty room", () => {
    expect(reconcile([])).toBe(0);
  });
});

// The watchdog is the layer that doesn't need to know why the audio stopped. Organizer
// audio arrives every 100ms, so a long gap is unambiguous — but "never started" is the
// startup case, which the subscription wiring owns, and firing there would fight it.
describe("shouldRecoverStalledInput", () => {
  const stallMs = 15_000;

  it("recovers when audio was flowing and then stopped", () => {
    expect(
      shouldRecoverStalledInput({ now: 100_000, lastFrameAt: 80_000, lastRecoveryAt: 0, stallMs })
    ).toBe(true);
  });

  it("does not fire while audio is flowing", () => {
    expect(
      shouldRecoverStalledInput({ now: 100_000, lastFrameAt: 99_900, lastRecoveryAt: 0, stallMs })
    ).toBe(false);
  });

  it("does not fire before any audio has ever arrived (that's the startup path)", () => {
    expect(
      shouldRecoverStalledInput({ now: 100_000, lastFrameAt: 0, lastRecoveryAt: 0, stallMs })
    ).toBe(false);
  });

  it("holds off during the cooldown, so a muted speaker yields one event not a storm", () => {
    // Stalled for 40s, but we already attempted recovery 5s ago.
    expect(
      shouldRecoverStalledInput({
        now: 100_000,
        lastFrameAt: 60_000,
        lastRecoveryAt: 95_000,
        stallMs,
      })
    ).toBe(false);
  });

  it("retries once the cooldown elapses and the input is still dead", () => {
    expect(
      shouldRecoverStalledInput({
        now: 100_000,
        lastFrameAt: 60_000,
        lastRecoveryAt: 85_000,
        stallMs,
      })
    ).toBe(true);
  });
});
