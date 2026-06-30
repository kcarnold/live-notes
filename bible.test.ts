import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPassage, formatReference, lookupBiblePassage } from './bible.ts';

const chapter = {
  chapter: {
    number: 3,
    content: [
      { type: 'line_break' },
      { type: 'verse', number: 15, content: ['so that whoever believes may have eternal life.'] },
      { type: 'verse', number: 16, content: ['For God so loved ', { text: 'the world,' }] },
      { type: 'verse', number: 17, content: ['For God did not send his Son to condemn.'] },
      { type: 'line_break' },
    ],
  },
};

function mockChapter(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('formatReference', () => {
  it('formats whole chapter, single verse, and range', () => {
    expect(formatReference({ book: 'psa', chapter: 23 })).toBe('PSA 23');
    expect(formatReference({ book: 'jhn', chapter: 3, startVerse: 16 })).toBe('JHN 3:16');
    expect(formatReference({ book: 'rom', chapter: 8, startVerse: 1, endVerse: 4 })).toBe('ROM 8:1-4');
    // endVerse equal to startVerse collapses to a single verse.
    expect(formatReference({ book: 'jhn', chapter: 3, startVerse: 16, endVerse: 16 })).toBe('JHN 3:16');
  });
});

describe('fetchPassage', () => {
  it('selects a verse range and flattens string + {text} content', async () => {
    mockChapter(chapter);
    const text = await fetchPassage('fra_ncl', 'JHN', 3, 16, 17);
    expect(text).toBe('For God so loved the world,\nFor God did not send his Son to condemn.');
  });

  it('returns a single verse when only startVerse is given', async () => {
    mockChapter(chapter);
    expect(await fetchPassage('fra_ncl', 'JHN', 3, 16)).toBe('For God so loved the world,');
  });

  it('returns null for a missing verse range', async () => {
    mockChapter(chapter);
    expect(await fetchPassage('fra_ncl', 'JHN', 3, 99)).toBeNull();
  });

  it('returns null when the fetch fails', async () => {
    mockChapter(null, false);
    expect(await fetchPassage('fra_ncl', 'XXX', 1, 1)).toBeNull();
  });
});

describe('lookupBiblePassage', () => {
  it('returns per-language text and an ok call record', async () => {
    mockChapter(chapter);
    const result = await lookupBiblePassage({ book: 'JHN', chapter: 3, startVerse: 16 }, [
      'French',
      'Haitian Creole',
    ]);
    expect(result.reference).toBe('JHN 3:16');
    expect(result.passages.French).toBe('For God so loved the world,');
    expect(result.passages['Haitian Creole']).toBe('For God so loved the world,');
    expect(result.call).toEqual({
      reference: 'JHN 3:16',
      foundLanguages: expect.arrayContaining(['French', 'Haitian Creole']),
      missingLanguages: [],
      ok: true,
    });
  });

  it('marks a language with no configured translation as missing', async () => {
    mockChapter(chapter);
    const result = await lookupBiblePassage({ book: 'JHN', chapter: 3, startVerse: 16 }, ['Klingon']);
    expect(result.passages).toEqual({});
    expect(result.call.ok).toBe(false);
    expect(result.call.missingLanguages).toEqual(['Klingon']);
  });
});
