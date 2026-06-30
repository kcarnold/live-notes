/**
 * Pure orchestration for translating a whole service item at once.
 *
 * The unit of caching/review is the slide, but the unit of *translation* is the
 * item — and now the whole item is translated into every target language in a single
 * model call, so the model has full-item context (responsive readings, recurring
 * refrains) and can distribute a multilingual reference dump across the languages in one
 * pass. Slides already reviewed in the library are passed as context (so terminology
 * stays consistent) and are not re-translated.
 *
 * This module has no Node/Gemini/Express dependencies — the caller injects a
 * `translate` function — so it is unit-testable in isolation.
 */
import {
  normalizeSlideText,
  type SlideProvenance,
  type SlideStatus,
  type SlideTranslationEntry,
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

/** One target language for the model: which slides it must translate, plus context. */
export interface TranslateTarget {
  language: string;
  isTranslationNeeded: boolean[];
  context: string;
}

/**
 * Translate the needed slides for several languages in one model call, returning the
 * translated segments per language (only for slides that were requested).
 */
export type MultiLangTranslateFn = (params: {
  slides: string[];
  targets: TranslateTarget[];
}) => Promise<Record<string, TranslatedSegment[]>>;

/**
 * Resolve a translation for every slide of an item, for every requested language, in one
 * model call.
 *
 * Precedence per slide+language:
 * - a `reviewed` library entry → returned as `reviewed`, fed to the model as context;
 * - else the model translates it (with the language's reviewed slides as context, plus
 *   any reference the caller wired into `translate`), returned as `auto`/`llm`.
 * Empty slides resolve to empty `auto` text without hitting the model.
 */
export async function translateItem(params: {
  slides: string[];
  languages: string[];
  lookup: SlideTranslationLookup;
  translate: MultiLangTranslateFn;
}): Promise<Record<string, PerSlideTranslation[]>> {
  const { slides, languages, lookup, translate } = params;

  const reviewedByLang: Record<string, (SlideTranslationEntry | undefined)[]> = {};
  const targets: TranslateTarget[] = [];
  for (const language of languages) {
    const reviewed = slides.map((slide) =>
      slide.trim() === '' ? undefined : lookup(language, slide),
    );
    reviewedByLang[language] = reviewed;
    const isTranslationNeeded = slides.map(
      (slide, i) => slide.trim() !== '' && !reviewed[i],
    );
    // Reviewed slides are already in-language, so they feed the model as context.
    const context = slides
      .map((_, i) => reviewed[i]?.text)
      .filter((text): text is string => Boolean(text))
      .join('\n');
    targets.push({ language, isTranslationNeeded, context });
  }

  const needyTargets = targets.filter((target) =>
    target.isTranslationNeeded.some(Boolean),
  );
  const translatedByLang: Record<string, Map<string, string>> = {};
  if (needyTargets.length > 0) {
    const result = await translate({ slides, targets: needyTargets });
    for (const [language, segments] of Object.entries(result)) {
      const byText = new Map<string, string>();
      for (const segment of segments) {
        byText.set(normalizeSlideText(segment.sourceText), segment.translatedText);
      }
      translatedByLang[language] = byText;
    }
  }

  const out: Record<string, PerSlideTranslation[]> = {};
  for (const language of languages) {
    const reviewed = reviewedByLang[language];
    const byText = translatedByLang[language] ?? new Map<string, string>();
    out[language] = slides.map((slide, i) => {
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
        text: byText.get(normalizeSlideText(slide)) ?? '',
        status: 'auto',
        provenance: 'llm',
      };
    });
  }
  return out;
}
