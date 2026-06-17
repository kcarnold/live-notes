import { describe, expect, it } from "vitest";

import { isSessionHealthy } from "./translation-session-manager.ts";

// The presence reaper (fix for: "translator kept running after the last client
// disconnected") tears a session down once it is unhealthy past a grace window.
// `isSessionHealthy` is that decision: keep running only while a human listener
// AND a broadcaster are both present.
describe("isSessionHealthy", () => {
  it("is healthy with a listener and the broadcaster present", () => {
    expect(
      isSessionHealthy(["organizer-host", "translator-fr", "attendee-abc123"])
    ).toBe(true);
  });

  it("is unhealthy when the last listener has left (only bots remain)", () => {
    // This is the reported leak: bots still in the room but nobody listening.
    expect(isSessionHealthy(["organizer-host", "translator-fr", "translator-es"])).toBe(false);
  });

  it("is unhealthy when the broadcaster has left (no source audio)", () => {
    expect(isSessionHealthy(["translator-fr", "attendee-abc123"])).toBe(false);
  });

  it("is unhealthy for an empty room", () => {
    expect(isSessionHealthy([])).toBe(false);
  });

  it("does not count translator bots as listeners", () => {
    // A translator identity must never keep a session alive on its own.
    expect(isSessionHealthy(["organizer-host", "translator-fr"])).toBe(false);
  });
});
