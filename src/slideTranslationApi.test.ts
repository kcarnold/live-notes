import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseSlidesInput,
  lookupLibrary,
  upsertLibraryEntry,
  translateItem,
} from './slideTranslationApi';

describe('parseSlidesInput', () => {
  it('splits on explicit -- delimiters', () => {
    const text = 'Slide one\nline two\n--\nSlide two';
    expect(parseSlidesInput(text)).toEqual(['Slide one\nline two', 'Slide two']);
  });

  it('uses blank lines when there are no -- delimiters', () => {
    const text = 'Slide one\n\nSlide two\n\n\nSlide three';
    expect(parseSlidesInput(text)).toEqual(['Slide one', 'Slide two', 'Slide three']);
  });

  it('keeps blank lines inside a slide when -- delimiters are present', () => {
    const text = 'Verse line\n\nstill same slide\n--\nNext slide';
    expect(parseSlidesInput(text)).toEqual(['Verse line\n\nstill same slide', 'Next slide']);
  });

  it('ignores leading/trailing whitespace and empty slides', () => {
    expect(parseSlidesInput('\n\n--\n  \n--\nOnly slide\n')).toEqual(['Only slide']);
  });

  it('returns an empty array for blank input', () => {
    expect(parseSlidesInput('   \n  \n')).toEqual([]);
  });
});

describe('api clients', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lookupLibrary posts texts and returns aligned entries', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ entries: [{ text: 'Bonjour', status: 'reviewed', provenance: 'human' }, null] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const entries = await lookupLibrary('French', ['Hello', 'Unknown']);
    expect(entries).toEqual([{ text: 'Bonjour', status: 'reviewed', provenance: 'human' }, null]);

    const [url, options] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/slideLibrary/lookup');
    expect(JSON.parse(options.body)).toEqual({ language: 'French', texts: ['Hello', 'Unknown'] });
  });

  it('upsertLibraryEntry returns the saved record', async () => {
    const record = { language: 'French', sourceText: 'Hello', text: 'Bonjour', status: 'reviewed', provenance: 'human' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ record }) }));
    await expect(upsertLibraryEntry({ language: 'French', sourceText: 'Hello', text: 'Bonjour' })).resolves.toEqual(record);
  });

  it('translateItem returns the per-language translation map', async () => {
    const translations = { French: [{ text: 'Bonjour', status: 'auto', provenance: 'llm' }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ translations }) }));
    await expect(translateItem(['Hello'], ['French'])).resolves.toEqual(translations);
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(translateItem(['Hello'], ['French'])).rejects.toThrow('500');
  });
});
