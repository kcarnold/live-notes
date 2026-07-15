import { describe, expect, it } from "vitest";

import { isSessionHealthy } from "./translation-session-manager.ts";

// The presence reaper tears a session down once it is unhealthy past a grace
// window. `isSessionHealthy` is that decision, and it depends on whether the cost
// path is enabled.
describe("isSessionHealthy", () => {
  // Cost path ON (requireListener: false): keep running while a broadcaster is
  // present, so a live talk always has at least an English transcript even with zero
  // listeners. Silence suspension keeps an idle broadcaster cheap.
  describe("with the cost path enabled (requireListener: false)", () => {
    const healthy = (ids: string[]) => isSessionHealthy(ids, { requireListener: false });

    it("is healthy with a listener and the broadcaster present", () => {
      expect(healthy(["organizer-host", "translator-fr", "attendee-abc123"])).toBe(true);
    });

    it("stays healthy with the broadcaster present but no listeners", () => {
      // The always-on transcript case: the default translator keeps running so the
      // organizer sees their English transcript even before anyone joins.
      expect(healthy(["organizer-host", "translator-fr", "translator-es"])).toBe(true);
    });

    it("is unhealthy when the broadcaster has left (no source audio)", () => {
      expect(healthy(["translator-fr", "attendee-abc123"])).toBe(false);
    });

    it("does not count translator bots as a broadcaster", () => {
      expect(healthy(["translator-fr", "translator-es"])).toBe(false);
    });
  });

  // Cost path OFF (the default): the original rule — a human listener AND a
  // broadcaster must both be present, since without silence-suspend an idle bot would
  // burn a Gemini session.
  describe("with the cost path disabled (default, requireListener: true)", () => {
    const healthy = (ids: string[]) => isSessionHealthy(ids, { requireListener: true });

    it("is healthy with a listener and the broadcaster present", () => {
      expect(healthy(["organizer-host", "translator-fr", "attendee-abc123"])).toBe(true);
    });

    it("is unhealthy with a broadcaster but no listeners (only bots remain)", () => {
      expect(healthy(["organizer-host", "translator-fr", "translator-es"])).toBe(false);
    });

    it("is unhealthy when the broadcaster has left", () => {
      expect(healthy(["translator-fr", "attendee-abc123"])).toBe(false);
    });

    it("defaults to requiring a listener when no options are passed", () => {
      // The exported default is the conservative (cost-path-off) behavior.
      expect(isSessionHealthy(["organizer-host", "translator-fr"])).toBe(false);
      expect(isSessionHealthy(["organizer-host", "attendee-abc"])).toBe(true);
    });
  });

  it("is unhealthy for an empty room in either mode", () => {
    expect(isSessionHealthy([], { requireListener: false })).toBe(false);
    expect(isSessionHealthy([], { requireListener: true })).toBe(false);
  });
});
