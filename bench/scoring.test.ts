import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import {
  countLiteralEscapes,
  coversExpectedLookups,
  echoRatio,
  extractToolCalls,
  lookupReferences,
  maxEchoRatio,
  scoreCoverage,
  scoreDraft,
  scoreFollowUp,
  scoreLineStructure,
  scoreNotes,
} from './scoring.ts';
import { HYMN_ITEM, slideTexts } from './fixtures.ts';

const call = (name: string, args: Record<string, unknown>): Content => ({
  role: 'model',
  parts: [{ functionCall: { name, args } }],
});

describe('extractToolCalls', () => {
  it('reads calls in order, including several in one turn', () => {
    const calls = extractToolCalls([
      { role: 'user', parts: [{ text: 'go' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'lookup_bible_passage', args: { book: 'PSA', chapter: 23 } } },
          { functionCall: { name: 'lookup_bible_passage', args: { book: 'JHN', chapter: 3 } } },
        ],
      },
      call('set_translations', { languages: [] }),
    ]);
    expect(calls.map((entry) => entry.name)).toEqual([
      'lookup_bible_passage',
      'lookup_bible_passage',
      'set_translations',
    ]);
  });
});

describe('countLiteralEscapes', () => {
  it('finds a literal backslash-n however deeply nested in the arguments', () => {
    const calls = extractToolCalls([
      call('set_translations', {
        languages: [{ language: 'French', segments: [{ segmentId: 0, translation: 'ligne un\\nligne deux' }] }],
      }),
    ]);
    expect(countLiteralEscapes(calls)).toBe(1);
  });

  it('does not flag a real newline', () => {
    const calls = extractToolCalls([
      call('set_translations', {
        languages: [{ language: 'French', segments: [{ segmentId: 0, translation: 'ligne un\nligne deux' }] }],
      }),
    ]);
    expect(countLiteralEscapes(calls)).toBe(0);
  });
});

describe('lookupReferences', () => {
  it('formats whole-chapter, single-verse, and range lookups', () => {
    const calls = extractToolCalls([
      call('lookup_bible_passage', { book: 'psa', chapter: 23 }),
      call('lookup_bible_passage', { book: 'JHN', chapter: 3, startVerse: 16 }),
      call('lookup_bible_passage', { book: 'ROM', chapter: 8, startVerse: 1, endVerse: 4 }),
    ]);
    expect(lookupReferences(calls)).toEqual(['PSA 23', 'JHN 3:16', 'ROM 8:1-4']);
  });
});

describe('coversExpectedLookups', () => {
  it('accepts a verse-range lookup for an expected whole-chapter reference', () => {
    expect(coversExpectedLookups(['PSA 23'], ['PSA 23:1-6'])).toBe(true);
  });

  it('rejects a lookup of a different chapter', () => {
    expect(coversExpectedLookups(['PSA 23'], ['PSA 24'])).toBe(false);
  });

  it('is trivially satisfied when nothing was expected', () => {
    expect(coversExpectedLookups([], [])).toBe(true);
  });
});

describe('scoreCoverage', () => {
  const slides = ['one', 'two', 'three'];

  it('counts only the ids that were actually requested', () => {
    const coverage = scoreCoverage(
      { French: [{ sourceText: 'one', translatedText: 'un' }] },
      { French: [0, 1] },
      slides,
    );
    expect(coverage.French).toEqual({ requested: 2, covered: 1, extra: 0 });
  });

  it('treats a blank translation as not covered', () => {
    const coverage = scoreCoverage(
      { French: [{ sourceText: 'one', translatedText: '   ' }] },
      { French: [0] },
      slides,
    );
    expect(coverage.French.covered).toBe(0);
  });

  it('counts translations of slides nobody asked for as extra', () => {
    const coverage = scoreCoverage(
      {
        French: [
          { sourceText: 'one', translatedText: 'un' },
          { sourceText: 'three', translatedText: 'trois' },
        ],
      },
      { French: [0] },
      slides,
    );
    expect(coverage.French).toEqual({ requested: 1, covered: 1, extra: 1 });
  });
});

describe('scoreLineStructure', () => {
  it('credits a verse slide that keeps its line count', () => {
    const score = scoreLineStructure(
      { French: [{ sourceText: 'a\nb\nc', translatedText: 'x\ny\nz' }] },
      ['a\nb\nc'],
      ['verse'],
    );
    expect(score).toMatchObject({ verseMatched: 1, verseTotal: 1 });
  });

  it('fails a verse slide that was flattened into prose', () => {
    const score = scoreLineStructure(
      { French: [{ sourceText: 'a\nb\nc', translatedText: 'x y z' }] },
      ['a\nb\nc'],
      ['verse'],
    );
    expect(score).toMatchObject({ verseMatched: 0, verseTotal: 1 });
  });

  it('credits a prose slide that dropped the source hard wraps', () => {
    const score = scoreLineStructure(
      { French: [{ sourceText: 'a\nb\nc', translatedText: 'x y z' }] },
      ['a\nb\nc'],
      ['prose'],
    );
    expect(score).toMatchObject({ proseReflowed: 1, proseTotal: 1 });
  });

  it('fails a prose slide that copied the English wrapping', () => {
    const score = scoreLineStructure(
      { French: [{ sourceText: 'a\nb\nc', translatedText: 'x\ny\nz' }] },
      ['a\nb\nc'],
      ['prose'],
    );
    expect(score).toMatchObject({ proseReflowed: 0, proseTotal: 1 });
  });

  it('scores each language separately for the same slide', () => {
    const score = scoreLineStructure(
      {
        French: [{ sourceText: 'a\nb', translatedText: 'x\ny' }],
        Spanish: [{ sourceText: 'a\nb', translatedText: 'x y' }],
      },
      ['a\nb'],
      ['verse'],
    );
    expect(score).toMatchObject({ verseMatched: 1, verseTotal: 2 });
  });

  it('ignores slides marked either', () => {
    const score = scoreLineStructure(
      { French: [{ sourceText: 'a\nb', translatedText: 'x y' }] },
      ['a\nb'],
      ['either'],
    );
    expect(score).toEqual({ verseMatched: 0, verseTotal: 0, proseReflowed: 0, proseTotal: 0 });
  });
});

describe('echoRatio', () => {
  it('is 1 when the source came back untranslated', () => {
    expect(echoRatio('Amazing grace how sweet the sound', 'Amazing grace how sweet the sound')).toBe(1);
  });

  it('is 0 for a genuine translation', () => {
    expect(echoRatio('Amazing grace, how sweet the sound', 'Grâce infinie, que ce chant est doux')).toBe(0);
  });

  it('ignores short words, which collide across languages by accident', () => {
    // "the" and "sound" differ in length; only the long one counts as a match.
    expect(echoRatio('the sound', 'le sound')).toBe(1);
    expect(echoRatio('the cat', 'le chat')).toBe(0);
  });

  it('reports the worst slide, not the average', () => {
    expect(
      maxEchoRatio({
        French: [
          { sourceText: 'Amazing grace', translatedText: 'Grâce infinie' },
          { sourceText: 'Praise blessings', translatedText: 'Praise blessings' },
        ],
      }),
    ).toBe(1);
  });
});

describe('scoreDraft', () => {
  const slides = slideTexts(HYMN_ITEM);

  it('summarises a clean run', () => {
    const messages: Content[] = [
      call('set_translations', {
        languages: [
          {
            language: 'French',
            segments: [{ segmentId: 0, translation: 'a\nb\nc\nd' }],
          },
        ],
      }),
    ];
    const score = scoreDraft({
      item: HYMN_ITEM,
      slides,
      requestedIds: { French: [0] },
      translations: { French: [{ sourceText: slides[0], translatedText: 'a\nb\nc\nd' }] },
      messages,
      setTranslationsCalled: true,
    });

    expect(score.setTranslationsCalled).toBe(true);
    expect(score.coveredTotal).toBe(1);
    expect(score.requestedTotal).toBe(1);
    expect(score.lineStructure).toMatchObject({ verseMatched: 1, verseTotal: 1 });
    expect(score.literalEscapes).toBe(0);
    expect(score.toolCallCounts).toEqual({ set_translations: 1 });
  });

  it('flags a run that answered in prose instead of calling the tool', () => {
    const score = scoreDraft({
      item: HYMN_ITEM,
      slides,
      requestedIds: { French: [0, 1] },
      translations: {},
      messages: [{ role: 'model', parts: [{ text: 'Here are your translations: ...' }] }],
      setTranslationsCalled: false,
    });

    expect(score.setTranslationsCalled).toBe(false);
    expect(score.coveredTotal).toBe(0);
    expect(score.requestedTotal).toBe(2);
  });
});

describe('scoreFollowUp', () => {
  const slides = slideTexts(HYMN_ITEM);
  const target = { language: 'French', slideIndex: 0, slideText: slides[0] };

  it('rewards a targeted single-slide edit', () => {
    const score = scoreFollowUp({
      translations: { French: [{ sourceText: slides[0], translatedText: 'Grâce infinie ! que le son est doux' }] },
      messages: [call('revise_translation', { language: 'French', segmentId: 0, find: 'x', replace: 'y' })],
      setTranslationsCalled: false,
      target,
      expectedSubstring: 'Grâce infinie',
      objectionableSubstring: 'Grâce étonnante',
    });

    expect(score).toMatchObject({
      usedRevise: true,
      usedSetTranslations: false,
      blastRadius: 1,
      appliedRequestedChange: true,
      leftObjectionableWording: false,
    });
  });

  it('records the blast radius when the model re-sent every slide', () => {
    const score = scoreFollowUp({
      translations: {
        French: slides.map((slide) => ({ sourceText: slide, translatedText: 'Grâce infinie' })),
      },
      messages: [call('set_translations', { languages: [] })],
      setTranslationsCalled: true,
      target,
      expectedSubstring: 'Grâce infinie',
      objectionableSubstring: 'Grâce étonnante',
    });

    expect(score.blastRadius).toBe(4);
    expect(score.usedRevise).toBe(false);
    expect(score.usedSetTranslations).toBe(true);
  });

  it('notices when the objectionable wording survived the edit', () => {
    const score = scoreFollowUp({
      translations: { French: [{ sourceText: slides[0], translatedText: 'Grâce étonnante encore' }] },
      messages: [call('revise_translation', {})],
      setTranslationsCalled: false,
      target,
      expectedSubstring: 'Grâce infinie',
      objectionableSubstring: 'Grâce étonnante',
    });

    expect(score.appliedRequestedChange).toBe(false);
    expect(score.leftObjectionableWording).toBe(true);
  });
});

describe('scoreNotes', () => {
  const chunks = ['a', 'b', 'c', 'd'];
  const isTranslationNeeded = [false, false, true, true];

  it('counts coverage of the T segments', () => {
    const score = scoreNotes({
      chunks,
      isTranslationNeeded,
      returnedIds: [2, 3],
      blocks: [
        { sourceText: 'c', translatedText: 'ce' },
        { sourceText: 'd', translatedText: 'de' },
      ],
    });
    expect(score).toMatchObject({ requestedIds: [2, 3], covered: 2, spurious: 0 });
  });

  it('flags context segments the model translated anyway', () => {
    const score = scoreNotes({
      chunks,
      isTranslationNeeded,
      returnedIds: [0, 1, 2, 3],
      blocks: chunks.map((chunk) => ({ sourceText: chunk, translatedText: `${chunk}!` })),
    });
    expect(score.spurious).toBe(2);
  });

  it('flags ids that do not exist', () => {
    const score = scoreNotes({ chunks, isTranslationNeeded, returnedIds: [2, 99], blocks: [] });
    expect(score.spurious).toBe(1);
    expect(score.covered).toBe(0);
  });
});
