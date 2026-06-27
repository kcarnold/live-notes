import { describe, expect, it } from "vitest";

import { endsSentence } from "./transcript-writer.ts";

// Gemini Live Translate streams transcription as a continuous flow of deltas with
// no turnComplete, so the writer starts a fresh paragraph after a delta that ends
// a sentence. `endsSentence` is that decision.
describe("endsSentence", () => {
  it("is true for deltas ending in sentence punctuation", () => {
    expect(endsSentence("Hello world.")).toBe(true);
    expect(endsSentence("Really?")).toBe(true);
    expect(endsSentence("Stop!")).toBe(true);
  });

  it("tolerates trailing whitespace after the punctuation", () => {
    expect(endsSentence("Done. ")).toBe(true);
    expect(endsSentence("Done.\n")).toBe(true);
  });

  it("allows a closing quote or bracket after the punctuation", () => {
    expect(endsSentence('He said "go."')).toBe(true);
    expect(endsSentence("(an aside.)")).toBe(true);
  });

  it("handles non-Latin sentence punctuation", () => {
    expect(endsSentence("结束。")).toBe(true);
    expect(endsSentence("本当に？")).toBe(true);
  });

  it("is false for mid-sentence deltas", () => {
    expect(endsSentence("Hello")).toBe(false);
    expect(endsSentence("and then we")).toBe(false);
    expect(endsSentence("a comma,")).toBe(false);
  });

  it("is false for empty or whitespace-only text", () => {
    expect(endsSentence("")).toBe(false);
    expect(endsSentence("   ")).toBe(false);
  });
});
