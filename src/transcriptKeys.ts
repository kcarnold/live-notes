// Shared primitives for the live speech-translation transcripts. The pipeline
// publishes each language into a `liveTranscriptSegments-{code}` Y.Array (see
// live-audio/transcript-writer.ts); both the client (LiveTranscript,
// TranscriptHealth) and the server-side session export need to agree on that
// namespace, on the segment shape, and on how to label a code. Kept free of any
// runtime dependency (the Y import is type-only) so either side can import it
// without pulling the other's bundle in.
import type * as Y from 'yjs';

/**
 * Legacy prefix: transcripts used to be one flat, append-only Y.Text per language,
 * with `\n\n` between utterances and no timestamps anywhere. Sessions recorded
 * before the move to segments still hold their transcript here, so the reader below
 * falls back to it — nothing writes it any more.
 */
export const LIVE_TRANSCRIPT_PREFIX = 'liveTranscript-';

/** Prefix the live-audio pipeline uses for per-language transcript Y.Array keys. */
export const LIVE_TRANSCRIPT_SEGMENTS_PREFIX = 'liveTranscriptSegments-';

/** Root-type key holding one language's transcript segments. */
export function transcriptSegmentsKey(code: string): string {
  return `${LIVE_TRANSCRIPT_SEGMENTS_PREFIX}${code}`;
}

/**
 * Silence long enough to be worth showing the reader as a break rather than
 * letting two unrelated utterances run together. Also the writer's threshold for
 * splitting a segment mid-sentence, so it bounds what a gap can even be attributed
 * to: shorter pauses are still recorded, they just fall inside a segment.
 */
export const TRANSCRIPT_PAUSE_MS = 10_000;

/**
 * One utterance of a transcript. The writer opens a segment on the first delta
 * after a sentence ends or after a long silence, so segment boundaries are exactly
 * where a pause can be reported.
 */
export interface TranscriptSegment {
  text: string;
  /** Epoch ms of this segment's first delta; undefined for legacy transcripts. */
  startedAt?: number;
  /**
   * Silence (ms) between the previous delta — in this language — and this segment's
   * first one. Undefined for the first segment of a transcript and for legacy ones.
   * Measured against the last delta rather than the previous segment's start, so a
   * long utterance is never mistaken for a pause.
   */
  gapMs?: number;
}

/** Whether the silence before this segment is worth marking in the UI. */
export function isLongPause(segment: TranscriptSegment): boolean {
  return segment.gapMs !== undefined && segment.gapMs >= TRANSCRIPT_PAUSE_MS;
}

/**
 * Read one language's transcript. Falls back to the legacy flat Y.Text (split on
 * blank lines, no timing) when no segments exist, so exports and viewers of older
 * sessions still show their transcript.
 */
export function readTranscriptSegments(doc: Y.Doc, code: string): TranscriptSegment[] {
  const segments = segmentsFromArray(doc.getArray<Y.Map<unknown>>(transcriptSegmentsKey(code)));
  if (segments.length > 0) return segments;
  return legacySegments(doc, code);
}

/** Project a segments Y.Array into plain objects. Split out for the client's snapshot cache. */
export function segmentsFromArray(yArray: Y.Array<Y.Map<unknown>>): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const yMap of yArray.toArray()) {
    const text = yTextValue(yMap.get('text')).trim();
    if (text === '') continue;
    const startedAt = yMap.get('startedAt');
    const gapMs = yMap.get('gapMs');
    segments.push({
      text,
      ...(typeof startedAt === 'number' ? { startedAt } : {}),
      ...(typeof gapMs === 'number' ? { gapMs } : {}),
    });
  }
  return segments;
}

/** The pre-segments representation: one Y.Text, utterances separated by blank lines. */
function legacySegments(doc: Y.Doc, code: string): TranscriptSegment[] {
  return yTextValue(doc.getText(`${LIVE_TRANSCRIPT_PREFIX}${code}`))
    .split('\n\n')
    .map((text) => text.trim())
    .filter((text) => text !== '')
    .map((text) => ({ text }));
}

/**
 * Stringify a Y.Text field. Yjs doesn't declare Y.Text's (working) toString()
 * override, hence the disable — same reason as yjsUtils.yTextToString, repeated here
 * because this module can't take a runtime dependency on the client's utils.
 */
function yTextValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);
}

/** Flatten segments back to plain text, blank line between utterances. */
export function transcriptPlainText(segments: TranscriptSegment[]): string {
  return segments.map((s) => s.text).join('\n\n');
}

/**
 * A pause length for display: rounded to a single unit, since "about how long was
 * the silence" is all the indicator claims. Localized via Intl rather than hard-coded
 * "s"/"m" suffixes.
 */
export function formatPauseGap(gapMs: number, locale: string): string {
  const seconds = Math.max(0, Math.round(gapMs / 1000));
  const format = (value: number, unit: 'second' | 'minute') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value);
  return seconds < 90 ? format(seconds, 'second') : format(Math.round(seconds / 60), 'minute');
}

/** Code of the English source transcript (matches TranslationBridge.SOURCE_CODE). */
export const LIVE_TRANSCRIPT_SOURCE_CODE = 'en';

const liveTranscriptDisplayNames = new Intl.DisplayNames(['en'], { type: 'language' });

/** Localized display name for a transcript's BCP-47 code, falling back to the code itself. */
export function liveTranscriptLabel(code: string): string {
  try {
    return liveTranscriptDisplayNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Scan a doc's root types for the transcript codes present, English source first.
 * Both namespaces count: a session recorded before segments existed has only the
 * legacy Y.Text, and `readTranscriptSegments` will read it.
 */
export function liveTranscriptCodes(doc: Y.Doc): string[] {
  const codes = new Set<string>();
  for (const key of doc.share.keys()) {
    // Order matters: `liveTranscriptSegments-` is not a `liveTranscript-` key
    // (the char after the prefix is 'S', not '-'), but check the longer one first
    // anyway so this stays correct if either prefix is ever renamed.
    if (key.startsWith(LIVE_TRANSCRIPT_SEGMENTS_PREFIX)) {
      codes.add(key.slice(LIVE_TRANSCRIPT_SEGMENTS_PREFIX.length));
    } else if (key.startsWith(LIVE_TRANSCRIPT_PREFIX)) {
      codes.add(key.slice(LIVE_TRANSCRIPT_PREFIX.length));
    }
  }
  return [...codes].sort((a, b) => {
    const aSource = a === LIVE_TRANSCRIPT_SOURCE_CODE;
    const bSource = b === LIVE_TRANSCRIPT_SOURCE_CODE;
    if (aSource !== bSource) return aSource ? -1 : 1;
    return liveTranscriptLabel(a).localeCompare(liveTranscriptLabel(b));
  });
}
