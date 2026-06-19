/**
 * Pure orchestration for translating a whole service item at once.
 *
 * The unit of caching/review is the slide, but the unit of *translation* is the
 * item: all slides go to the model in one request so it has full-item context
 * (responsive readings, recurring refrains). Slides already reviewed in the library
 * are passed as context (so terminology stays consistent) and are not re-translated.
 *
 * This module has no Node/Gemini/Express dependencies — the caller injects a
 * `translate` function — so it is unit-testable in isolation.
 */
import {
  normalizeSlideText,
  type SlideProvenance,
  type SlideStatus,
  type SlideTranslationLookup,
} from './slideTranslation.ts';

export interface PerSlideTranslation {
  text: string;
  status: SlideStatus;
  provenance: SlideProvenance;
}

/** One translated segment returned by the model (shape of nlp.ts TranslationBlockResult). */
export interface TranslatedSegment {
  sourceText: string;
  translatedText: string;
}

export interface TranslateTodo {
  chunks: string[];
  offset: number;
  isTranslationNeeded: boolean[];
  translatedContext: string;
}

export type TranslateFn = (todo: TranslateTodo) => Promise<TranslatedSegment[]>;

/**
 * Resolve a translation for every slide of an item in one model call.
 *
 * - Slides with a reviewed library entry are returned as `reviewed` and supplied to
 *   the model as already-translated context.
 * - Empty slides resolve to empty `auto` text without hitting the model.
 * - Remaining slides are translated together and returned as `auto`.
 */
export async function translateItemSlides(params: {
  slides: string[];
  language: string;
  lookup: SlideTranslationLookup;
  translate: TranslateFn;
}): Promise<PerSlideTranslation[]> {
  const { slides, language, lookup, translate } = params;

  const reviewed = slides.map((slide) =>
    slide.trim() === '' ? undefined : lookup(language, slide),
  );
  const isTranslationNeeded = slides.map(
    (slide, i) => slide.trim() !== '' && !reviewed[i],
  );

  const translatedByText = new Map<string, string>();
  if (isTranslationNeeded.some(Boolean)) {
    // Reviewed slides feed the model as context for style/terminology consistency.
    const translatedContext = slides
      .map((_, i) => reviewed[i]?.text)
      .filter((text): text is string => Boolean(text))
      .join('\n');

    const segments = await translate({
      chunks: slides,
      offset: 0,
      isTranslationNeeded,
      translatedContext,
    });
    for (const segment of segments) {
      translatedByText.set(normalizeSlideText(segment.sourceText), segment.translatedText);
    }
  }

  return slides.map((slide, i) => {
    const reviewedEntry = reviewed[i];
    if (reviewedEntry) {
      return {
        text: reviewedEntry.text,
        status: 'reviewed',
        provenance: reviewedEntry.provenance,
      };
    }
    if (slide.trim() === '') {
      return { text: '', status: 'auto', provenance: 'llm' };
    }
    return {
      text: translatedByText.get(normalizeSlideText(slide)) ?? '',
      status: 'auto',
      provenance: 'llm',
    };
  });
}
