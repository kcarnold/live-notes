import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  TRANSCRIPT_PAUSE_MS,
  formatPauseGap,
  isLongPause,
  liveTranscriptCodes,
  readTranscriptSegments,
  transcriptPlainText,
  transcriptSegmentsKey,
} from './transcriptKeys';

/** Write a segment the way live-audio/transcript-writer.ts does. */
function pushSegment(
  doc: Y.Doc,
  code: string,
  fields: { text: string; startedAt?: number; gapMs?: number },
) {
  const segment = new Y.Map<unknown>();
  doc.getArray<Y.Map<unknown>>(transcriptSegmentsKey(code)).push([segment]);
  if (fields.startedAt !== undefined) segment.set('startedAt', fields.startedAt);
  if (fields.gapMs !== undefined) segment.set('gapMs', fields.gapMs);
  segment.set('text', new Y.Text(fields.text));
}

describe('liveTranscriptCodes', () => {
  it('discovers only transcript root types, English source first', () => {
    const doc = new Y.Doc();
    // Touching a root type registers it in doc.share, mirroring what the transcript
    // writer does on the server as each language comes online.
    pushSegment(doc, 'fr', { text: 'bonjour' });
    pushSegment(doc, 'en', { text: 'hello' });
    pushSegment(doc, 'es', { text: 'hola' });
    doc.getText('sourceBlocks'); // unrelated root type — must be ignored
    doc.getMap('proclaimStatus');

    // en is the source, so it sorts first; the rest by localized label
    // (English "French" < "Spanish").
    expect(liveTranscriptCodes(doc)).toEqual(['en', 'fr', 'es']);
  });

  it('returns an empty list when no transcripts exist yet', () => {
    const doc = new Y.Doc();
    doc.getArray('sourceBlocks');
    expect(liveTranscriptCodes(doc)).toEqual([]);
  });

  it('picks up a language that appears after the first scan', () => {
    const doc = new Y.Doc();
    pushSegment(doc, 'en', { text: 'hello' });
    expect(liveTranscriptCodes(doc)).toEqual(['en']);

    pushSegment(doc, 'ht', { text: 'bonjou' });
    expect(liveTranscriptCodes(doc)).toEqual(['en', 'ht']);
  });

  it('still finds a pre-segments session, whose transcript is a flat Y.Text', () => {
    const doc = new Y.Doc();
    doc.getText('liveTranscript-en').insert(0, 'hello');
    doc.getText('liveTranscript-fr').insert(0, 'bonjour');

    expect(liveTranscriptCodes(doc)).toEqual(['en', 'fr']);
  });

  it('lists a language once when it has both a segments array and a legacy Y.Text', () => {
    const doc = new Y.Doc();
    doc.getText('liveTranscript-en').insert(0, 'hello');
    pushSegment(doc, 'en', { text: 'hello again' });

    expect(liveTranscriptCodes(doc)).toEqual(['en']);
  });
});

describe('readTranscriptSegments', () => {
  it('reads segments with their timing', () => {
    const doc = new Y.Doc();
    pushSegment(doc, 'en', { text: 'Good morning.', startedAt: 1000 });
    pushSegment(doc, 'en', { text: 'Let us pray.', startedAt: 61_000, gapMs: 55_000 });

    expect(readTranscriptSegments(doc, 'en')).toEqual([
      { text: 'Good morning.', startedAt: 1000 },
      { text: 'Let us pray.', startedAt: 61_000, gapMs: 55_000 },
    ]);
  });

  it('skips segments with no text, so a half-written one never renders blank', () => {
    const doc = new Y.Doc();
    pushSegment(doc, 'en', { text: 'Real text.', startedAt: 1000 });
    pushSegment(doc, 'en', { text: '   ', startedAt: 2000 });

    expect(readTranscriptSegments(doc, 'en').map((s) => s.text)).toEqual(['Real text.']);
  });

  it('returns nothing for a language with no transcript', () => {
    expect(readTranscriptSegments(new Y.Doc(), 'en')).toEqual([]);
  });

  // Sessions recorded before segments existed hold one flat Y.Text with blank lines
  // between utterances. They carry no timing, but their text must still come back.
  it('falls back to a pre-segments transcript, splitting it on blank lines', () => {
    const doc = new Y.Doc();
    doc.getText('liveTranscript-en').insert(0, 'The Lord is my shepherd.\n\nI shall not want.\n\n');

    expect(readTranscriptSegments(doc, 'en')).toEqual([
      { text: 'The Lord is my shepherd.' },
      { text: 'I shall not want.' },
    ]);
  });

  it('prefers segments over the legacy Y.Text when both exist', () => {
    const doc = new Y.Doc();
    doc.getText('liveTranscript-en').insert(0, 'stale');
    pushSegment(doc, 'en', { text: 'current', startedAt: 1000 });

    expect(readTranscriptSegments(doc, 'en').map((s) => s.text)).toEqual(['current']);
  });
});

describe('isLongPause', () => {
  it('is true only at or above the threshold', () => {
    expect(isLongPause({ text: 'x', gapMs: TRANSCRIPT_PAUSE_MS })).toBe(true);
    expect(isLongPause({ text: 'x', gapMs: TRANSCRIPT_PAUSE_MS - 1 })).toBe(false);
  });

  it('is false when no gap was recorded (first segment, or a legacy transcript)', () => {
    expect(isLongPause({ text: 'x' })).toBe(false);
  });
});

describe('formatPauseGap', () => {
  it('reports short pauses in seconds', () => {
    expect(formatPauseGap(12_000, 'en-US')).toBe('12s');
  });

  it('switches to minutes once seconds stop being readable', () => {
    expect(formatPauseGap(240_000, 'en-US')).toBe('4m');
  });

  it('localizes the unit', () => {
    expect(formatPauseGap(12_000, 'fr-FR')).toContain('12');
  });
});

describe('transcriptPlainText', () => {
  it('joins utterances with a blank line between them', () => {
    expect(transcriptPlainText([{ text: 'One.' }, { text: 'Two.' }])).toBe('One.\n\nTwo.');
  });
});
