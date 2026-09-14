import { describe, it, expect, vi } from 'vitest';
import { translateItem, type MultiLangTranslateFn } from './slideItemTranslation';
import { slideTranslationKey, type SlideTranslationEntry, type SlideTranslationLookup } from './slideTranslation';

function makeLookup(entries: Record<string, SlideTranslationEntry>): SlideTranslationLookup {
  return (language, slideText) => entries[slideTranslationKey(language, slideText)];
}

// Fake model: for each target, echoes a "[<lang>] " prefix for every needed slide.
const fakeTranslate: MultiLangTranslateFn = ({ slides, targets }) =>
  Promise.resolve(
    Object.fromEntries(
      targets.map((target) => [
        target.language,
        slides
          .map((slide, i) => ({ slide, i }))
          .filter(({ i }) => target.isTranslationNeeded[i])
          .map(({ slide }) => ({
            sourceText: slide,
            translatedText: `[${target.language}] ${slide.trim()}`,
          })),
      ]),
    ),
  );

describe('translateItem', () => {
  it('translates all slides for every language when the library has nothing', async () => {
    const result = await translateItem({
      slides: ['Praise the Lord', 'Forever and ever'],
      languages: ['French', 'Haitian Creole'],
      lookup: makeLookup({}),
      translate: fakeTranslate,
    });

    expect(result.French).toEqual([
      { text: '[French] Praise the Lord', provenance: 'llm' },
      { text: '[French] Forever and ever', provenance: 'llm' },
    ]);
    expect(result['Haitian Creole'][0]).toEqual({
      text: '[Haitian Creole] Praise the Lord',
      provenance: 'llm',
    });
  });

  it('returns library slides as-is and only sends the misses to the model', async () => {
    const translate = vi.fn(fakeTranslate);
    const lookup = makeLookup({
      [slideTranslationKey('French', 'Praise the Lord')]: {
        text: 'Louez le Seigneur',
        provenance: 'human',
      },
    });

    const result = await translateItem({
      slides: ['Praise the Lord', 'Forever and ever'],
      languages: ['French'],
      lookup,
      translate,
    });

    expect(result.French[0]).toEqual({
      text: 'Louez le Seigneur',
      provenance: 'human',
    });
    expect(result.French[1]).toEqual({
      text: '[French] Forever and ever',
      provenance: 'llm',
    });

    // Only the untranslated slide is flagged, and the library text feeds context.
    const target = translate.mock.calls[0][0].targets.find((t) => t.language === 'French');
    expect(target?.isTranslationNeeded).toEqual([false, true]);
    expect(target?.context).toContain('Louez le Seigneur');
  });

  it('does not call the model when the library covers every slide in every language', async () => {
    const translate = vi.fn(fakeTranslate);
    const lookup = makeLookup({
      [slideTranslationKey('French', 'Amen')]: {
        text: 'Amen',
        provenance: 'human',
      },
    });

    const result = await translateItem({
      slides: ['Amen'],
      languages: ['French'],
      lookup,
      translate,
    });

    expect(translate).not.toHaveBeenCalled();
    expect(result.French[0]).toEqual({ text: 'Amen', provenance: 'human' });
  });

  it('only includes languages that still need translation in the model call', async () => {
    const translate = vi.fn(fakeTranslate);
    const lookup = makeLookup({
      [slideTranslationKey('French', 'Amen')]: {
        text: 'Amen',
        provenance: 'human',
      },
    });

    await translateItem({
      slides: ['Amen'],
      languages: ['French', 'Haitian Creole'],
      lookup,
      translate,
    });

    const targets = translate.mock.calls[0][0].targets;
    expect(targets.map((t) => t.language)).toEqual(['Haitian Creole']);
  });

  it('translates a repeated slide once but resolves it at every occurrence', async () => {
    const translate = vi.fn(fakeTranslate);
    const result = await translateItem({
      slides: ['V1', 'Chorus', 'V2', 'Chorus', 'Chorus'],
      languages: ['French'],
      lookup: makeLookup({}),
      translate,
    });

    // Only the first 'Chorus' is flagged for the model; later copies are skipped.
    const target = translate.mock.calls[0][0].targets[0];
    expect(target.isTranslationNeeded).toEqual([true, true, true, false, false]);

    // ...yet every chorus index resolves to the same translation.
    expect(result.French.map((r) => r.text)).toEqual([
      '[French] V1',
      '[French] Chorus',
      '[French] V2',
      '[French] Chorus',
      '[French] Chorus',
    ]);
  });

  it('never sends duplicates of an already-reviewed slide to the model', async () => {
    const translate = vi.fn(fakeTranslate);
    const lookup = makeLookup({
      [slideTranslationKey('French', 'Chorus')]: {
        text: 'Refrain',
        provenance: 'human',
      },
    });

    const result = await translateItem({
      slides: ['Chorus', 'V1', 'Chorus'],
      languages: ['French'],
      lookup,
      translate,
    });

    const target = translate.mock.calls[0][0].targets[0];
    expect(target.isTranslationNeeded).toEqual([false, true, false]);
    expect(result.French.map((r) => r.text)).toEqual(['Refrain', '[French] V1', 'Refrain']);
    expect(result.French[0].text).toBe(result.French[2].text);
  });

  it('dedups duplicates per language independently', async () => {
    const translate = vi.fn(fakeTranslate);
    const lookup = makeLookup({
      // In the library for French only; Haitian Creole still needs it.
      [slideTranslationKey('French', 'Chorus')]: {
        text: 'Refrain',
        provenance: 'human',
      },
    });

    const result = await translateItem({
      slides: ['Chorus', 'Chorus'],
      languages: ['French', 'Haitian Creole'],
      lookup,
      translate,
    });

    const targets = translate.mock.calls[0][0].targets;
    // French is fully reviewed, so it drops out of the model call entirely.
    expect(targets.map((t) => t.language)).toEqual(['Haitian Creole']);
    const htTarget = targets[0];
    expect(htTarget.isTranslationNeeded).toEqual([true, false]);

    expect(result.French.map((r) => r.text)).toEqual(['Refrain', 'Refrain']);
    expect(result['Haitian Creole'].map((r) => r.text)).toEqual([
      '[Haitian Creole] Chorus',
      '[Haitian Creole] Chorus',
    ]);
  });

  it('resolves empty slides to empty auto text without translating them', async () => {
    const translate = vi.fn(fakeTranslate);
    const result = await translateItem({
      slides: ['', 'Hallelujah'],
      languages: ['French'],
      lookup: makeLookup({}),
      translate,
    });

    expect(result.French[0]).toEqual({ text: '', provenance: 'llm' });
    expect(result.French[1].text).toBe('[French] Hallelujah');
    const target = translate.mock.calls[0][0].targets[0];
    expect(target.isTranslationNeeded).toEqual([false, true]);
  });
});
