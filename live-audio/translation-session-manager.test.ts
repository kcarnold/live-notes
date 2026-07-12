import { describe, expect, it } from "vitest";

import { isSessionHealthy } from "./translation-session-manager.ts";

// The presence reaper tears a session down once it is unhealthy past a grace
// window. `isSessionHealthy` is that decision: keep running while a broadcaster
// (organizer) is present, so a live talk always has at least an English transcript,
// even with zero listeners. Silence suspension keeps an idle broadcaster cheap.
describe("isSessionHealthy", () => {
  it("is healthy with a listener and the broadcaster present", () => {
    expect(
      isSessionHealthy(["organizer-host", "translator-fr", "attendee-abc123"])
    ).toBe(true);
  });

  it("stays healthy with the broadcaster present but no listeners", () => {
    // The always-on transcript case: the default translator keeps running so the
    // organizer sees their English transcript even before anyone joins.
    expect(isSessionHealthy(["organizer-host", "translator-fr", "translator-es"])).toBe(true);
  });

  it("is unhealthy when the broadcaster has left (no source audio)", () => {
    expect(isSessionHealthy(["translator-fr", "attendee-abc123"])).toBe(false);
  });

  it("is unhealthy for an empty room", () => {
    expect(isSessionHealthy([])).toBe(false);
  });

  it("does not count translator bots as a broadcaster", () => {
    // A translator identity must never keep a session alive on its own.
    expect(isSessionHealthy(["translator-fr", "translator-es"])).toBe(false);
  });
});
