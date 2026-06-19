import { describe, it, expect, vi } from 'vitest';
import { translateItemSlides, type TranslateFn } from './slideItemTranslation';
import { slideTranslationKey, type SlideTranslationEntry, type SlideTranslationLookup } from './slideTranslation';

function makeLookup(entries: Record<string, SlideTranslationEntry>): SlideTranslationLookup {
  return (language, slideText) => entries[slideTranslationKey(language, slideText)];
}

// Fake model: echoes a "[fr] " prefix for every segment that needs translation.
const fakeTranslate: TranslateFn = (todo) =>
  Promise.resolve(
    todo.chunks
      .map((chunk, i) => ({ chunk, i }))
      .filter(({ i }) => todo.isTranslationNeeded[i])
      .map(({ chunk }) => ({ sourceText: chunk, translatedText: `[fr] ${chunk.trim()}` })),
  );

describe('translateItemSlides', () => {
  it('translates all slides when nothing is reviewed', async () => {
    const result = await translateItemSlides({
      slides: ['Praise the Lord', 'Forever and ever'],
      language: 'French',
      lookup: makeLookup({}),
      translate: fakeTranslate,
    });
    expect(result).toEqual([
      { text: '[fr] Praise the Lord', status: 'auto', provenance: 'llm' },
      { text: '[fr] Forever and ever', status: 'auto', provenance: 'llm' },
    ]);
  });

  it('returns reviewed slides as reviewed and only translates the misses', async () => {
    const translate = vi.fn(fakeTranslate);
    const lookup = makeLookup({
      [slideTranslationKey('French', 'Praise the Lord')]: {
        text: 'Louez le Seigneur',
        status: 'reviewed',
        provenance: 'human',
        reviewedAt: 1,
      },
    });

    const result = await translateItemSlides({
      slides: ['Praise the Lord', 'Forever and ever'],
      language: 'French',
      lookup,
      translate,
    });

    expect(result[0]).toEqual({ text: 'Louez le Seigneur', status: 'reviewed', provenance: 'human' });
    expect(result[1]).toEqual({ text: '[fr] Forever and ever', status: 'auto', provenance: 'llm' });

    // Only the un-reviewed slide should have been flagged for translation, and the
    // reviewed translation should have been supplied as context.
    const todo = translate.mock.calls[0][0];
    expect(todo.isTranslationNeeded).toEqual([false, true]);
    expect(todo.translatedContext).toContain('Louez le Seigneur');
  });

  it('does not call the model when every slide is reviewed', async () => {
    const translate = vi.fn(fakeTranslate);
    const lookup = makeLookup({
      [slideTranslationKey('French', 'Amen')]: {
        text: 'Amen',
        status: 'reviewed',
        provenance: 'human',
        reviewedAt: 1,
      },
    });

    const result = await translateItemSlides({
      slides: ['Amen'],
      language: 'French',
      lookup,
      translate,
    });

    expect(translate).not.toHaveBeenCalled();
    expect(result[0].status).toBe('reviewed');
  });

  it('uses a first draft as an imported auto entry instead of translating', async () => {
    const translate = vi.fn(fakeTranslate);
    const result = await translateItemSlides({
      slides: ['Praise the Lord', 'Forever and ever'],
      language: 'French',
      lookup: makeLookup({}),
      translate,
      firstDraftBySlide: ['Louez le Seigneur (existant)', undefined],
    });

    expect(result[0]).toEqual({
      text: 'Louez le Seigneur (existant)',
      status: 'auto',
      provenance: 'imported',
    });
    expect(result[1]).toEqual({ text: '[fr] Forever and ever', status: 'auto', provenance: 'llm' });

    // Only the slide without a draft is sent to the model; the draft feeds context.
    const todo = translate.mock.calls[0][0];
    expect(todo.isTranslationNeeded).toEqual([false, true]);
    expect(todo.translatedContext).toContain('Louez le Seigneur (existant)');
  });

  it('prefers a reviewed entry over a first draft', async () => {
    const lookup = makeLookup({
      [slideTranslationKey('French', 'Praise the Lord')]: {
        text: 'Louez le Seigneur',
        status: 'reviewed',
        provenance: 'human',
        reviewedAt: 1,
      },
    });
    const result = await translateItemSlides({
      slides: ['Praise the Lord'],
      language: 'French',
      lookup,
      translate: vi.fn(fakeTranslate),
      firstDraftBySlide: ['some imported draft'],
    });
    expect(result[0]).toEqual({ text: 'Louez le Seigneur', status: 'reviewed', provenance: 'human' });
  });

  it('does not call the model when every slide has a reviewed entry or a first draft', async () => {
    const translate = vi.fn(fakeTranslate);
    await translateItemSlides({
      slides: ['Hallelujah'],
      language: 'French',
      lookup: makeLookup({}),
      translate,
      firstDraftBySlide: ['Alléluia'],
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it('resolves empty slides to empty auto text without translating them', async () => {
    const translate = vi.fn(fakeTranslate);
    const result = await translateItemSlides({
      slides: ['', 'Hallelujah'],
      language: 'French',
      lookup: makeLookup({}),
      translate,
    });
    expect(result[0]).toEqual({ text: '', status: 'auto', provenance: 'llm' });
    expect(result[1].text).toBe('[fr] Hallelujah');
    expect(translate.mock.calls[0][0].isTranslationNeeded).toEqual([false, true]);
  });
});
