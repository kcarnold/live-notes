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
  it('translates all slides for every language when nothing is reviewed', async () => {
    const result = await translateItem({
      slides: ['Praise the Lord', 'Forever and ever'],
      languages: ['French', 'Haitian Creole'],
      lookup: makeLookup({}),
      translate: fakeTranslate,
    });

    expect(result.French).toEqual([
      { text: '[French] Praise the Lord', status: 'auto', provenance: 'llm' },
      { text: '[French] Forever and ever', status: 'auto', provenance: 'llm' },
    ]);
    expect(result['Haitian Creole'][0]).toEqual({
      text: '[Haitian Creole] Praise the Lord',
      status: 'auto',
      provenance: 'llm',
    });
  });

  it('returns reviewed slides as reviewed and only sends the misses to the model', async () => {
    const translate = vi.fn(fakeTranslate);
    const lookup = makeLookup({
      [slideTranslationKey('French', 'Praise the Lord')]: {
        text: 'Louez le Seigneur',
        status: 'reviewed',
        provenance: 'human',
        reviewedAt: 1,
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
      status: 'reviewed',
      provenance: 'human',
    });
    expect(result.French[1]).toEqual({
      text: '[French] Forever and ever',
      status: 'auto',
      provenance: 'llm',
    });

    // Only the un-reviewed slide is flagged, and the reviewed text feeds context.
    const target = translate.mock.calls[0][0].targets.find((t) => t.language === 'French');
    expect(target?.isTranslationNeeded).toEqual([false, true]);
    expect(target?.context).toContain('Louez le Seigneur');
  });

  it('does not call the model when every slide is reviewed in every language', async () => {
    const translate = vi.fn(fakeTranslate);
    const lookup = makeLookup({
      [slideTranslationKey('French', 'Amen')]: {
        text: 'Amen',
        status: 'reviewed',
        provenance: 'human',
        reviewedAt: 1,
      },
    });

    const result = await translateItem({
      slides: ['Amen'],
      languages: ['French'],
      lookup,
      translate,
    });

    expect(translate).not.toHaveBeenCalled();
    expect(result.French[0].status).toBe('reviewed');
  });

  it('only includes languages that still need translation in the model call', async () => {
    const translate = vi.fn(fakeTranslate);
    const lookup = makeLookup({
      [slideTranslationKey('French', 'Amen')]: {
        text: 'Amen',
        status: 'reviewed',
        provenance: 'human',
        reviewedAt: 1,
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

  it('resolves empty slides to empty auto text without translating them', async () => {
    const translate = vi.fn(fakeTranslate);
    const result = await translateItem({
      slides: ['', 'Hallelujah'],
      languages: ['French'],
      lookup: makeLookup({}),
      translate,
    });

    expect(result.French[0]).toEqual({ text: '', status: 'auto', provenance: 'llm' });
    expect(result.French[1].text).toBe('[French] Hallelujah');
    const target = translate.mock.calls[0][0].targets[0];
    expect(target.isTranslationNeeded).toEqual([false, true]);
  });
});
