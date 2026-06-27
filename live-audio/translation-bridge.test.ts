import { describe, expect, it } from "vitest";

import { nextBackoffMs, parseGoAwayTimeLeftMs } from "./translation-bridge.ts";

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
