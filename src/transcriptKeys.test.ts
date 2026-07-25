import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { liveTranscriptCodes } from './transcriptKeys';

describe('liveTranscriptCodes', () => {
  it('discovers only liveTranscript-* root types, English source first', () => {
    const doc = new Y.Doc();
    // Touching a Y.Text registers the root type in doc.share, mirroring what the
    // transcript writer does on the server as each language comes online.
    doc.getText('liveTranscript-fr').insert(0, 'bonjour');
    doc.getText('liveTranscript-en').insert(0, 'hello');
    doc.getText('liveTranscript-es').insert(0, 'hola');
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
    doc.getText('liveTranscript-en').insert(0, 'hello');
    expect(liveTranscriptCodes(doc)).toEqual(['en']);

    doc.getText('liveTranscript-ht').insert(0, 'bonjou');
    expect(liveTranscriptCodes(doc)).toEqual(['en', 'ht']);
  });
});
