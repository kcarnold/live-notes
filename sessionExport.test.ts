import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { writeSourceLanguage } from './src/liveAudioConfig.ts';
import {
  buildSessionExport,
  renderSessionHtml,
  sessionExportFilename,
} from './sessionExport.ts';
import { slideTranslationKey, type SlideTranslationEntry } from './src/slideTranslation.ts';

/**
 * Append a transcript segment the way live-audio/transcript-log.ts does: stored
 * timings are observations only (when the utterance started and last grew), and the
 * silence between utterances is derived from them at read time.
 */
function transcriptSegment(
  doc: Y.Doc,
  code: string,
  text: string,
  timing: { startedAt: number; endedAt?: number },
) {
  const segment = new Y.Map<unknown>();
  doc.getArray<Y.Map<unknown>>(`liveTranscriptSegments-${code}`).push([segment]);
  segment.set('startedAt', timing.startedAt);
  segment.set('endedAt', timing.endedAt ?? timing.startedAt);
  segment.set('text', new Y.Text(text));
}

/** Build a source block Y.Map the way the block editor stores them. */
function block(id: string, position: string, content: string, opts?: { type?: 'heading' | 'bullet'; level?: number }) {
  const map = new Y.Map<unknown>();
  const text = new Y.Text();
  text.insert(0, content);
  map.set('id', id);
  map.set('position', position);
  map.set('type', opts?.type ?? 'bullet');
  map.set('level', opts?.level ?? 0);
  map.set('content', text);
  return map;
}

describe('buildSessionExport', () => {
  it('extracts notes in fractional-index order with translations', () => {
    const doc = new Y.Doc();
    // Insert out of order to prove sorting by `position`.
    doc.getArray('sourceBlocks').push([
      block('b2', 'a1', 'Second point'),
      block('b1', 'a0', 'First point', { type: 'heading' }),
    ]);
    const cache = doc.getMap<string>('notesTranslationCache');
    cache.set('French:First point', 'Premier point');

    const data = buildSessionExport(doc, 'doc-2026-07-13');

    expect(data.notes.map((n) => n.content)).toEqual(['First point', 'Second point']);
    expect(data.notes[0].type).toBe('heading');
    expect(data.notes[0].translations.French).toBe('Premier point');
    expect(data.notes[1].translations).toEqual({});
    expect(data.noteLanguages).toEqual(['French']);
    expect(data.date).toContain('2026');
  });

  it('discovers note/slide/audio languages independently from the doc', () => {
    const doc = new Y.Doc();
    // Notes translated into Spanish (and a colon in the content must not confuse parsing).
    doc.getArray('sourceBlocks').push([block('b1', 'a0', 'Verse: John 3:16')]);
    doc.getMap<string>('notesTranslationCache').set('Spanish:Verse: John 3:16', 'Versículo: Juan 3:16');
    // Slides translated into French only.
    doc.getMap('proclaimPresentations').set('i1', { title: 'Reading', slides: ['A verse'] });
    doc.getMap<SlideTranslationEntry>('slideTranslations').set(slideTranslationKey('French', 'A verse'), {
      text: 'Un verset',
      status: 'reviewed',
      provenance: 'human',
    });
    // Audio in German.
    doc.getText('liveTranscript-de').insert(0, 'Guten Morgen.');

    const data = buildSessionExport(doc, 'doc-2026-07-13');

    expect(data.noteLanguages).toEqual(['Spanish']);
    expect(data.notes[0].translations.Spanish).toBe('Versículo: Juan 3:16');
    expect(data.slideLanguages).toEqual(['French']);
    expect(data.liveTranscripts.map((t) => t.code)).toEqual(['de']);
  });

  it('drops empty blocks', () => {
    const doc = new Y.Doc();
    doc.getArray('sourceBlocks').push([
      block('b1', 'a0', 'Kept'),
      block('b2', 'a1', '   '),
    ]);
    const data = buildSessionExport(doc, 'doc-2026-07-13');
    expect(data.notes).toHaveLength(1);
  });

  it('extracts presentations in service order with resolved slide translations', () => {
    const doc = new Y.Doc();
    const presentations = doc.getMap('proclaimPresentations');
    presentations.set('item-a', { title: 'Hymn', slides: ['Line one', 'Line two'] });
    presentations.set('item-b', { title: 'Reading', slides: ['A verse'] });
    doc.getMap('proclaimServiceOrder').set('order', ['item-b', 'item-a']);

    const translations = doc.getMap<SlideTranslationEntry>('slideTranslations');
    translations.set(slideTranslationKey('French', 'Line one'), {
      text: 'Ligne un',
      status: 'reviewed',
      provenance: 'human',
    });
    translations.set(slideTranslationKey('French', 'A verse'), {
      text: 'Un verset',
      status: 'auto',
      provenance: 'llm',
    });

    const data = buildSessionExport(doc, 'doc-2026-07-13');

    // Only French has stored slide translations, so it's the only discovered language.
    expect(data.slideLanguages).toEqual(['French']);
    // Service order wins: item-b before item-a.
    expect(data.presentations.map((p) => p.title)).toEqual(['Reading', 'Hymn']);
    expect(data.presentations[0].slides[0].translations.French.entry.text).toBe('Un verset');
    expect(data.presentations[0].slides[0].translations.French.entry.status).toBe('auto');
    expect(data.presentations[1].slides[0].translations.French.entry.text).toBe('Ligne un');
    // Untranslated slide has no entry.
    expect(data.presentations[1].slides[1].translations.French).toBeUndefined();
  });

  it('falls back to all presentation keys when there is no service order', () => {
    const doc = new Y.Doc();
    doc.getMap('proclaimPresentations').set('only', { title: 'Solo', slides: ['x'] });
    const data = buildSessionExport(doc, 'doc-2026-07-13');
    expect(data.presentations).toHaveLength(1);
    expect(data.presentations[0].title).toBe('Solo');
  });

  it('extracts transcript text from the Xml fragment', () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('transcriptDoc');
    const p1 = new Y.XmlElement('p');
    p1.insert(0, [new Y.XmlText('Hello world.')]);
    const p2 = new Y.XmlElement('p');
    p2.insert(0, [new Y.XmlText('Second line.')]);
    fragment.insert(0, [p1, p2]);

    const data = buildSessionExport(doc, 'doc-2026-07-13');
    expect(data.transcript).toBe('Hello world.\nSecond line.');
  });

  it('collects live speech-translation transcripts, source language first', () => {
    const doc = new Y.Doc();
    transcriptSegment(doc, 'en', 'The Lord is my shepherd.', { startedAt: 1000 });
    transcriptSegment(doc, 'fr', "L'Éternel est mon berger.", { startedAt: 1000 });
    transcriptSegment(doc, 'es', 'El Señor es mi pastor.', { startedAt: 1000 });
    doc.getArray('liveTranscriptSegments-de'); // empty — should be dropped

    const data = buildSessionExport(doc, 'doc-2026-07-13');

    // English source is first; the rest are sorted by localized label (French, Spanish).
    expect(data.liveTranscripts.map((t) => t.code)).toEqual(['en', 'fr', 'es']);
    expect(data.liveTranscripts[0].isSource).toBe(true);
    expect(data.liveTranscripts[0].label).toBe('English');
    expect(data.liveTranscripts[1].label).toBe('French');
    expect(data.liveTranscripts[1].text).toBe("L'Éternel est mon berger.");

    const html = renderSessionHtml(data);
    expect(html).toContain('Live speech translation');
    expect(html).toContain('English (source)');
    expect(html).toContain("L'Éternel est mon berger.");
  });

  it('marks the language the service was spoken in as the source, not English', () => {
    // An export is read long after the room emptied, so the doc is the only place that
    // can still say which transcript is the speaker's own words. A visiting Spanish
    // preacher's talk must not come back labelled as a translation of English.
    const doc = new Y.Doc();
    transcriptSegment(doc, 'es', 'El Señor es mi pastor.', { startedAt: 1000 });
    transcriptSegment(doc, 'en', 'The Lord is my shepherd.', { startedAt: 1000 });
    writeSourceLanguage(doc, 'es');

    const data = buildSessionExport(doc, 'doc-2026-07-13');

    expect(data.liveTranscripts.map((t) => t.code)).toEqual(['es', 'en']);
    expect(data.liveTranscripts[0].isSource).toBe(true);
    expect(data.liveTranscripts[1].isSource).toBe(false);
    expect(renderSessionHtml(data)).toContain('Spanish (source)');
  });

  it('marks a long silence between utterances, and leaves short gaps alone', () => {
    const doc = new Y.Doc();
    transcriptSegment(doc, 'en', 'Let us pray.', { startedAt: 1000, endedAt: 2000 });
    transcriptSegment(doc, 'en', 'Amen.', { startedAt: 5000, endedAt: 5000 });
    transcriptSegment(doc, 'en', 'Please be seated.', { startedAt: 125_000, endedAt: 126_000 });

    const data = buildSessionExport(doc, 'doc-2026-07-13');
    expect(data.liveTranscripts[0].segments.map((s) => s.gapMs)).toEqual([
      undefined,
      3000, // 5s − 2s
      120_000, // 125s − 5s
    ]);

    // Exactly one divider: the two-minute gap, not the three-second one.
    const html = renderSessionHtml(data);
    expect(html.match(/class="pause"/g)).toHaveLength(1);
    expect(html).toContain('Pause &middot; 2m');
  });

  it('still exports a pre-segments session, whose transcript is a flat Y.Text', () => {
    const doc = new Y.Doc();
    doc.getText('liveTranscript-en').insert(0, 'The Lord is my shepherd.\n\nI shall not want.\n\n');

    const data = buildSessionExport(doc, 'doc-2026-07-13');

    expect(data.liveTranscripts[0].text).toBe('The Lord is my shepherd.\n\nI shall not want.');
    const html = renderSessionHtml(data);
    expect(html).toContain('I shall not want.');
    expect(html).not.toContain('class="pause"'); // no timing was ever recorded
  });

  it('leaves date undefined for non-date doc ids', () => {
    const doc = new Y.Doc();
    const data = buildSessionExport(doc, 'doc5');
    expect(data.date).toBeUndefined();
  });
});

describe('renderSessionHtml', () => {
  it('produces a self-contained page with the content and escapes HTML', () => {
    const doc = new Y.Doc();
    doc.getArray('sourceBlocks').push([block('b1', 'a0', 'Note with <script> & "quotes"')]);
    const html = renderSessionHtml(buildSessionExport(doc, 'doc-2026-07-13'));

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Notes');
    expect(html).toContain('Note with &lt;script&gt; &amp; &quot;quotes&quot;');
    expect(html).not.toContain('<script>');
  });

  it('shows an empty-state message when there is nothing to export', () => {
    const doc = new Y.Doc();
    const html = renderSessionHtml(buildSessionExport(doc, 'doc-2026-07-13'));
    expect(html).toContain('no notes, slides, or transcript');
  });
});

describe('sessionExportFilename', () => {
  it('sanitizes the doc id into a safe filename', () => {
    expect(sessionExportFilename('doc-2026-07-13')).toBe('live-notes-doc-2026-07-13.html');
    expect(sessionExportFilename('weird/../id')).toBe('live-notes-weird____id.html');
  });
});
