/**
 * TranscriptWriter: a server-side Yjs writer that persists live translation
 * transcripts into the session's shared Y-Sweet doc, so any viewer — including
 * late joiners — can read the full transcript history.
 *
 * One writer per session (doc), shared by all of that session's TranslationBridges.
 * Each language's transcript accumulates in a `liveTranscriptSegments-{code}` Y.Array
 * of segment Y.Maps (`{ startedAt, gapMs?, text: Y.Text }`): Gemini Live Translate
 * streams a continuous flow of transcription deltas (it has no "turns", so no
 * turnComplete to flush on), so we append each delta verbatim into the open segment
 * and start a new one once a sentence finishes. The Y.Array is the single source of
 * truth — there is no separate ephemeral interim stream.
 *
 * Segments exist so the transcript can carry *time*, which a flat Y.Text cannot: this
 * writer is the only place in the system that knows when a delta arrived, so timing has
 * to be recorded here or it's unrecoverable downstream (a viewer can only ever time
 * deltas it was present for). Each segment records when it opened (`startedAt`) and when
 * it last grew (`endedAt`) — observations only. The silence *between* utterances is
 * derived from those at read time, which is what lets the client turn a long gap into a
 * visible break without this writer having to decide, or remember, anything.
 *
 * Mirrors the Proclaim service's "external process writes into Yjs" pattern, but
 * in-process on the Node server using the same Y-Sweet DocumentManager that issues
 * client tokens.
 */

import * as Y from "yjs";
import { createYjsProvider, type YSweetProvider } from "@y-sweet/client";
import type { DocumentManager } from "@y-sweet/sdk";

import {
  TRANSCRIPT_ENDED_AT_RESOLUTION_MS,
  TRANSCRIPT_PAUSE_MS,
  readSegmentFields,
  segmentLastActivityAt,
  transcriptSegmentsKey,
} from "../src/transcriptKeys.ts";

/**
 * Whether a transcription delta ends an utterance, used to close the segment.
 * Cheap heuristic: the trimmed text ends with sentence-ending punctuation,
 * optionally followed by a closing quote or bracket. Abbreviations ("Dr.") may
 * split a segment early — acceptable for a live transcript.
 */
export function endsSentence(text: string): boolean {
  return /[.!?…。！？][")'\]]?\s*$/.test(text);
}

/**
 * The segmentation itself: turns a stream of deltas into timestamped utterances in a
 * Y.Doc. Split out from the transport below so it can be exercised against a plain
 * local Y.Doc — the interesting behavior here is *when a segment opens*, which has
 * nothing to do with being connected to anything.
 */
export class TranscriptSegmentLog {
  // Explicit field, not a constructor parameter property: the server runs as
  // `node server.ts` (strip-only TypeScript), which rejects parameter properties
  // outright because desugaring them needs code generation, not just type removal.
  private readonly doc: Y.Doc;

  constructor(doc: Y.Doc) {
    this.doc = doc;
  }

  /**
   * Append a streamed transcription delta for a language. The delta goes verbatim into
   * the open segment (no trimming — inter-delta spacing is significant). A new segment
   * opens when the open one already ended a sentence, or when this delta follows a
   * silence of at least TRANSCRIPT_PAUSE_MS — a long enough gap is itself an utterance
   * boundary, even mid-sentence, and splitting there is what gives the pause somewhere
   * to be recorded. Edits made before the initial sync are merged by Yjs.
   *
   * Deliberately holds **no state between calls**: both inputs to that decision — when
   * the language last produced speech, and whether it was mid-sentence — are read back
   * out of the doc. A restarted server (see SMOKE_TEST.md §4) therefore picks up exactly
   * where it left off; with either fact cached in memory, the first delta after a
   * restart would silently glue onto the pre-restart utterance, hiding both the boundary
   * and the very gap the restart caused.
   *
   * `now` is injectable so tests can drive the clock.
   */
  append(code: string, text: string, now: number = Date.now()): void {
    if (!text) return;

    const segments = this.doc.getArray<Y.Map<unknown>>(transcriptSegmentsKey(code));
    const open = segments.length > 0 ? segments.get(segments.length - 1) : undefined;

    const lastAt = open === undefined ? undefined : segmentLastActivityAt(open);
    const gapMs = lastAt === undefined ? undefined : Math.max(0, now - lastAt);
    // Read from the accumulated segment rather than the previous delta: the regex is
    // anchored at the end, so this is the same answer, minus the memory.
    const finished = open !== undefined && endsSentence(readSegmentFields(open).text);
    const longPause = gapMs !== undefined && gapMs >= TRANSCRIPT_PAUSE_MS;
    const opensSegment = open === undefined || finished || longPause;

    // A delta that opens a segment gets its leading whitespace dropped — it would
    // otherwise be indentation on the new utterance. If that leaves nothing, there's
    // no speech to open a segment with: drop it and keep waiting, without stamping
    // endedAt, so trailing whitespace can't mask the start of a silence.
    const body = opensSegment ? text.trimStart() : text;
    if (opensSegment && body === "") return;

    this.doc.transact(() => {
      if (opensSegment) {
        const segment = new Y.Map<unknown>();
        segments.push([segment]);
        segment.set("startedAt", now);
        segment.set("endedAt", now);
        segment.set("text", new Y.Text(body));
      } else {
        const openText = open!.get("text") as Y.Text;
        openText.insert(openText.length, body);
        // Rewriting endedAt on every delta splits the Y.Text's merged item run and
        // roughly doubles the doc — see TRANSCRIPT_ENDED_AT_RESOLUTION_MS. Stamp it
        // exactly when this delta ends a sentence (the segment's last delta, ordinarily),
        // otherwise only once the stored value has gone stale.
        const storedEndedAt = segmentLastActivityAt(open!) ?? now;
        if (endsSentence(text) || now - storedEndedAt >= TRANSCRIPT_ENDED_AT_RESOLUTION_MS) {
          // Same transaction as the insert, so this costs one update, not two.
          open!.set("endedAt", now);
        }
      }
    });
  }
}

export class TranscriptWriter {
  public readonly docId: string;
  private doc = new Y.Doc();
  private provider: YSweetProvider;
  private log = new TranscriptSegmentLog(this.doc);

  constructor(docId: string, documentManager: DocumentManager) {
    this.docId = docId;
    this.provider = createYjsProvider(
      this.doc,
      docId,
      () => documentManager.getClientToken(docId),
      { connect: true }
    );
  }

  /** Append a streamed transcription delta for a language. See TranscriptSegmentLog.append. */
  appendDelta(code: string, text: string): void {
    this.log.append(code, text);
  }

  close(): void {
    this.provider.destroy();
    this.doc.destroy();
  }
}
