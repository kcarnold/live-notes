import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { TranscriptSegmentLog, endsSentence } from "./transcript-writer.ts";
import {
  TRANSCRIPT_PAUSE_MS,
  readTranscriptSegments,
} from "../src/transcriptKeys.ts";

// Gemini Live Translate streams transcription as a continuous flow of deltas with
// no turnComplete, so the writer starts a fresh segment after a delta that ends
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

/**
 * The segmentation is what makes a pause representable at all: a gap can only be
 * reported where a segment boundary exists, so these tests are really about where
 * boundaries land and what silence gets attributed to them. The clock is injected,
 * so "a minute of silence" is a number, not a wait.
 */
describe("TranscriptSegmentLog", () => {
  const T0 = 1_700_000_000_000;

  /** Drive a log with (offsetMs, text) deltas and read back what a viewer would see. */
  function run(deltas: [number, string][], code = "en") {
    const doc = new Y.Doc();
    const log = new TranscriptSegmentLog(doc);
    for (const [offset, text] of deltas) log.append(code, text, T0 + offset);
    return readTranscriptSegments(doc, code);
  }

  it("accumulates deltas into one segment until a sentence ends", () => {
    const segments = run([
      [0, "The Lord"],
      [500, " is my"],
      [1000, " shepherd."],
    ]);

    expect(segments.map((s) => s.text)).toEqual(["The Lord is my shepherd."]);
  });

  it("opens a new segment on the delta after a sentence ends", () => {
    const segments = run([
      [0, "First one."],
      [700, " Second one."],
    ]);

    expect(segments.map((s) => s.text)).toEqual(["First one.", "Second one."]);
  });

  it("stamps each segment with when its first delta arrived", () => {
    const segments = run([
      [0, "First one."],
      [700, " Second one."],
    ]);

    expect(segments[0].startedAt).toBe(T0);
    expect(segments[1].startedAt).toBe(T0 + 700);
  });

  it("records the silence before a segment, measured from the previous delta", () => {
    const segments = run([
      // A 9s utterance, then 20s of silence. The gap must reflect the silence, not
      // the time the sentence itself took — measuring from the previous segment's
      // *start* would report 29s.
      [0, "A long"],
      [5_000, " opening"],
      [9_000, " sentence."],
      [29_000, " And we resume."],
    ]);

    expect(segments.map((s) => s.text)).toEqual([
      "A long opening sentence.",
      "And we resume.",
    ]);
    expect(segments[1].gapMs).toBe(20_000);
  });

  it("leaves the first segment of a transcript with no gap", () => {
    expect(run([[0, "Opening words."]])[0].gapMs).toBeUndefined();
  });

  it("splits mid-sentence when the silence is long enough to be a pause", () => {
    const segments = run([
      [0, "We were saying"],
      [TRANSCRIPT_PAUSE_MS, " something else entirely"],
    ]);

    expect(segments.map((s) => s.text)).toEqual([
      "We were saying",
      "something else entirely",
    ]);
    expect(segments[1].gapMs).toBe(TRANSCRIPT_PAUSE_MS);
  });

  it("keeps a below-threshold gap inside the segment, so it reads as one utterance", () => {
    const segments = run([
      [0, "We were saying"],
      [TRANSCRIPT_PAUSE_MS - 1, " something else entirely"],
    ]);

    expect(segments.map((s) => s.text)).toEqual([
      "We were saying something else entirely",
    ]);
  });

  it("drops the leading whitespace a delta carries into a new segment", () => {
    const segments = run([
      [0, "Done."],
      [500, "   Next."],
    ]);

    expect(segments[1].text).toBe("Next.");
  });

  it("does not open a segment on a whitespace-only delta, or let it hide a pause", () => {
    const segments = run([
      [0, "Done."],
      [500, "   "], // no speech: must not open an empty segment...
      [60_500, " Back again."], // ...nor restart the pause clock at 500
    ]);

    expect(segments.map((s) => s.text)).toEqual(["Done.", "Back again."]);
    // The full silence since the last actual speech, not 60s from the whitespace.
    expect(segments[1].gapMs).toBe(60_500);
  });

  it("tracks languages independently, so interleaved deltas don't cross-contaminate", () => {
    const doc = new Y.Doc();
    const log = new TranscriptSegmentLog(doc);

    log.append("en", "Good morning.", T0);
    log.append("fr", "Bonjour.", T0 + 100);
    // English has been silent for 30s; French deltas in between must not count as
    // English activity and mask the pause.
    log.append("en", " Let us pray.", T0 + 30_000);
    log.append("fr", " Prions.", T0 + 30_100);

    const en = readTranscriptSegments(doc, "en");
    const fr = readTranscriptSegments(doc, "fr");
    expect(en.map((s) => s.text)).toEqual(["Good morning.", "Let us pray."]);
    expect(fr.map((s) => s.text)).toEqual(["Bonjour.", "Prions."]);
    expect(en[1].gapMs).toBe(30_000);
    expect(fr[1].gapMs).toBe(30_000);
  });

  it("ignores empty deltas entirely", () => {
    expect(run([[0, ""]])).toEqual([]);
  });
});
