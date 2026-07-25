// Shared primitives for the live speech-translation transcripts. The pipeline
// publishes each language into a `liveTranscript-{code}` Y.Text (see
// live-audio/transcript-writer.ts); both the client (LiveTranscript,
// TranscriptHealth) and the server-side session export need to agree on that
// namespace and on how to label a code. Kept free of any runtime dependency (the
// Y import is type-only) so either side can import it without pulling the other's
// bundle in.
import type * as Y from 'yjs';

/** Prefix the live-audio pipeline uses for per-language transcript Y.Text keys. */
export const LIVE_TRANSCRIPT_PREFIX = 'liveTranscript-';

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

/** Scan a doc's root types for the transcript codes present, English source first. */
export function liveTranscriptCodes(doc: Y.Doc): string[] {
  const codes: string[] = [];
  for (const key of doc.share.keys()) {
    if (key.startsWith(LIVE_TRANSCRIPT_PREFIX)) {
      codes.push(key.slice(LIVE_TRANSCRIPT_PREFIX.length));
    }
  }
  return codes.sort((a, b) => {
    const aSource = a === LIVE_TRANSCRIPT_SOURCE_CODE;
    const bSource = b === LIVE_TRANSCRIPT_SOURCE_CODE;
    if (aSource !== bSource) return aSource ? -1 : 1;
    return liveTranscriptLabel(a).localeCompare(liveTranscriptLabel(b));
  });
}
