/**
 * Shared, pure logic for the slide-translation store.
 *
 * This module has no Node or browser dependencies so it can be imported by both
 * the Express server (file-backed library in `slideLibrary.ts`) and the React
 * frontend (review UI + live viewer). Persistence and Yjs concerns live elsewhere.
 *
 * Translations are keyed by *content*, not slide position, so a slide that changes
 * underneath us is a clean cache miss on a new key rather than silent staleness.
 */

/** Whether a translation has been human-reviewed or is a machine fallback. */
export type SlideStatus = 'reviewed' | 'auto';

/** Where a translation came from. Pure metadata — the data model treats them alike. */
export type SlideProvenance = 'human' | 'bible' | 'creed' | 'llm' | 'llm-agent';

export interface SlideTranslationEntry {
  /** The translated text. */
  text: string;
  status: SlideStatus;
  provenance: SlideProvenance;
  /** Epoch millis when the entry was last reviewed/approved (reviewed entries only). */
  reviewedAt?: number;
}

/** A stored entry plus the language and normalized source text it was keyed by. */
export interface SlideLibraryRecord extends SlideTranslationEntry {
  language: string;
  sourceText: string;
}

/**
 * Per-language display fallback chains, used only at read time.
 *
 * Proclaim's single alternate-language screen is imported as `French`, and all our
 * Haitian Creole viewers also understand French — so a reviewed French text is
 * preferred over an unreviewed Creole one. Languages absent here fall back to
 * themselves only.
 */
export const LANGUAGE_FALLBACKS: Record<string, string[]> = {
  'Haitian Creole': ['Haitian Creole', 'French'],
};

/** The display fallback chain for a language (always starts with the language itself). */
export function fallbackChain(language: string): string[] {
  return LANGUAGE_FALLBACKS[language] ?? [language];
}

/**
 * Canonicalize slide text for use as a cache key. Internal line breaks are
 * preserved (responsive readings span lines); only trailing whitespace, line-ending
 * style, Unicode form, and surrounding blank lines are normalized.
 */
export function normalizeSlideText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/** Content-addressed key combining language and normalized slide text. */
export function slideTranslationKey(language: string, slideText: string): string {
  return `${language}:${normalizeSlideText(slideText)}`;
}

/** Looks up a stored entry for a concrete language + slide text, or undefined. */
export type SlideTranslationLookup = (
  language: string,
  slideText: string,
) => SlideTranslationEntry | undefined;

export interface ResolvedSlideTranslation {
  entry: SlideTranslationEntry;
  /** The language actually displayed (may differ from `requestedLanguage`). */
  displayLanguage: string;
  requestedLanguage: string;
  /** True when we fell back to a different language (e.g. French for a Creole viewer). */
  isFallbackLanguage: boolean;
}

/**
 * Resolve which translation to show for a slide, honoring the fallback chain.
 *
 * 1. Quality first: walk the chain and return the first *reviewed* entry.
 * 2. Fallback: otherwise return an *auto* entry in the requested language.
 *
 * Returns undefined when nothing is available (caller should trigger translation).
 */
export function resolveSlideTranslation(
  requestedLanguage: string,
  slideText: string,
  lookup: SlideTranslationLookup,
): ResolvedSlideTranslation | undefined {
  const chain = fallbackChain(requestedLanguage);

  for (const language of chain) {
    const entry = lookup(language, slideText);
    if (entry && entry.status === 'reviewed') {
      return {
        entry,
        displayLanguage: language,
        requestedLanguage,
        isFallbackLanguage: language !== requestedLanguage,
      };
    }
  }

  const auto = lookup(requestedLanguage, slideText);
  if (auto) {
    return {
      entry: auto,
      displayLanguage: requestedLanguage,
      requestedLanguage,
      isFallbackLanguage: false,
    };
  }

  return undefined;
}
