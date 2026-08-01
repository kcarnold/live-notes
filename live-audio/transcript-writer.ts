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
 * writer is the only place in the system that knows when a delta arrived, so a silence
 * has to be measured and recorded here or it's unrecoverable downstream (a viewer can
 * only ever time deltas it was present for). Each segment records when it opened and
 * how much silence preceded it; the client turns long gaps into a visible break.
 *
 * Mirrors the Proclaim service's "external process writes into Yjs" pattern, but
 * in-process on the Node server using the same Y-Sweet DocumentManager that issues
 * client tokens.
 */

import * as Y from "yjs";
import { createYjsProvider, type YSweetProvider } from "@y-sweet/client";
import type { DocumentManager } from "@y-sweet/sdk";

import {
  TRANSCRIPT_PAUSE_MS,
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
  /** Per language: when its last delta was written, for measuring silence. */
  private lastDeltaAt = new Map<string, number>();
  /** Per language: the last delta finished a sentence, so the next one opens a segment. */
  private breakPending = new Set<string>();

  constructor(private readonly doc: Y.Doc) {}

  /**
   * Append a streamed transcription delta for a language. The delta goes verbatim into
   * the open segment (no trimming — inter-delta spacing is significant). A new segment
   * opens when the previous delta ended a sentence, or when this delta follows a silence
   * of at least TRANSCRIPT_PAUSE_MS — a long enough gap is itself an utterance boundary,
   * even mid-sentence, and splitting there is what gives the pause somewhere to be
   * recorded. Edits made before the initial sync are merged by Yjs.
   *
   * `now` is injectable so tests can drive the clock.
   */
  append(code: string, text: string, now: number = Date.now()): void {
    if (!text) return;

    const segments = this.doc.getArray<Y.Map<unknown>>(transcriptSegmentsKey(code));
    const lastAt = this.lastDeltaAt.get(code);
    const gapMs = lastAt === undefined ? undefined : Math.max(0, now - lastAt);
    const longPause = gapMs !== undefined && gapMs >= TRANSCRIPT_PAUSE_MS;
    const opensSegment = segments.length === 0 || this.breakPending.has(code) || longPause;

    // A delta that opens a segment gets its leading whitespace dropped — it would
    // otherwise be indentation on the new utterance. If that leaves nothing, there's
    // no speech to open a segment with: drop it and keep waiting, without touching the
    // clock, so trailing whitespace can't mask the start of a silence.
    const body = opensSegment ? text.trimStart() : text;
    if (opensSegment && body === "") return;

    this.lastDeltaAt.set(code, now);
    this.breakPending.delete(code);

    this.doc.transact(() => {
      if (opensSegment) {
        const segment = new Y.Map<unknown>();
        segments.push([segment]);
        segment.set("startedAt", now);
        if (gapMs !== undefined) segment.set("gapMs", gapMs);
        segment.set("text", new Y.Text(body));
      } else {
        const open = segments.get(segments.length - 1).get("text") as Y.Text;
        open.insert(open.length, body);
      }
    });

    if (endsSentence(text)) this.breakPending.add(code);
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
