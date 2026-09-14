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

/** Where a translation came from. Pure metadata — the data model treats them alike. */
export type SlideProvenance = 'human' | 'bible' | 'creed' | 'llm' | 'llm-agent' | 'imported';

export interface SlideTranslationEntry {
  /** The translated text. */
  text: string;
  provenance: SlideProvenance;
}

/**
 * A caveat the translating model attached to one slide — the ambiguity or judgement call
 * it wants a human to look at before the service. Keyed by content like everything else
 * here, so it stays attached to the slide across re-runs and re-orderings.
 */
export interface SlideReviewNote {
  language: string;
  sourceText: string;
  text: string;
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
 * Haitian Creole viewers also understand French — so a French text is better than no
 * text at all. The requested language always wins where it has one; the chain is only
 * consulted when it doesn't. Languages absent here fall back to themselves only.
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

/**
 * Whether a slide has no text at all. Blank slides are real slides (Proclaim emits
 * them for image slideshows and spacer screens), but there is nothing to translate —
 * so they render blank rather than as an untranslated slide.
 */
export function isBlankSlide(slideText: string): boolean {
  return slideText.trim() === '';
}

/** Content-addressed key combining language and normalized slide text. */
export function slideTranslationKey(language: string, slideText: string): string {
  return `${language}:${normalizeSlideText(slideText)}`;
}

/**
 * Undo JSON-style escape sequences that were written as *literal characters*.
 *
 * A translating model shown JSON-encoded text tends to mimic the encoding and emit a
 * backslash followed by `n` where it means a line break. That survives JSON parsing intact,
 * so it reaches storage — and the slide — as two visible characters. The prompts now hand
 * the model plain text with real line breaks, which is the actual fix; this runs on both
 * sides of that (on the model's output, and on read, so entries stored before the fix still
 * render as intended).
 *
 * Only `\n`, `\r`, `\t` and `\\` are recognized, in one left-to-right pass so an escaped
 * backslash (`\\n`) correctly yields the literal text `\n` rather than a line break. Any
 * other backslash sequence is left alone.
 */
export function unescapeLiteralEscapes(text: string): string {
  return text.replace(/\\([nrt\\])/g, (_match, code: string) =>
    code === 'n' ? '\n' : code === 'r' ? '\r' : code === 't' ? '\t' : '\\',
  );
}

/** Split a stored translation into display lines, tolerating literal escape sequences. */
export function slideTextLines(text: string): string[] {
  return unescapeLiteralEscapes(text).split('\n');
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
 * Resolve which translation to show for a slide: the first entry along the language's
 * fallback chain, which starts with the requested language itself.
 *
 * Returns undefined when nothing is available (caller should trigger translation).
 */
export function resolveSlideTranslation(
  requestedLanguage: string,
  slideText: string,
  lookup: SlideTranslationLookup,
): ResolvedSlideTranslation | undefined {
  for (const language of fallbackChain(requestedLanguage)) {
    const entry = lookup(language, slideText);
    if (entry) {
      return {
        entry,
        displayLanguage: language,
        requestedLanguage,
        isFallbackLanguage: language !== requestedLanguage,
      };
    }
  }
  return undefined;
}
