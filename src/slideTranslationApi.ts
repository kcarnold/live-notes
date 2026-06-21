/**
 * Browser-side client for the slide-translation server endpoints, plus a small
 * helper for turning pasted text into slides.
 */
import type {
  SlideLibraryRecord,
  SlideProvenance,
  SlideTranslationEntry,
} from './slideTranslation.ts';
import type { PerSlideTranslation } from './slideItemTranslation.ts';

/**
 * Split pasted/edited text into slides, mirroring the Proclaim convention: a line
 * that is exactly `--` is an explicit slide break; if there are none, blank lines
 * separate slides. (Song-section and {Credits}/{Source} handling is Proclaim-only
 * and lives in the Python service.)
 */
export function parseSlidesInput(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const hasExplicitDelimiter = /^[ \t]*--[ \t]*$/m.test(normalized);

  const slides: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const slide = current.join('\n').trim();
    if (slide) slides.push(slide);
    current = [];
  };

  for (const line of normalized.split('\n')) {
    const isExplicitBreak = /^[ \t]*--[ \t]*$/.test(line);
    const isBlankBreak = !hasExplicitDelimiter && line.trim() === '';
    if (isExplicitBreak || isBlankBreak) {
      flush();
    } else {
      current.push(line);
    }
  }
  flush();
  return slides;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Fetch all reviewed library entries. */
export async function fetchLibrary(): Promise<SlideLibraryRecord[]> {
  const response = await fetch('/api/slideLibrary');
  if (!response.ok) throw new Error(`/api/slideLibrary failed: ${response.status}`);
  const data = (await response.json()) as { entries: SlideLibraryRecord[] };
  return data.entries;
}

/** Look up reviewed entries for a language, aligned with `texts` (null = no entry). */
export async function lookupLibrary(
  language: string,
  texts: string[],
): Promise<(SlideTranslationEntry | null)[]> {
  const data = await postJson<{ entries: (SlideTranslationEntry | null)[] }>(
    '/api/slideLibrary/lookup',
    { language, texts },
  );
  return data.entries;
}

/** Upsert a reviewed translation into the library. */
export async function upsertLibraryEntry(input: {
  language: string;
  sourceText: string;
  text: string;
  provenance?: SlideProvenance;
}): Promise<SlideLibraryRecord> {
  const data = await postJson<{ record: SlideLibraryRecord }>('/api/slideLibrary', input);
  return data.record;
}

/**
 * Translate a whole item: per language, reviewed-or-auto for every slide.
 *
 * `reference` is an optional free-text dump (possibly multilingual) the model uses where
 * it covers a target language and ignores otherwise.
 */
export async function translateItem(
  slides: string[],
  languages: string[],
  reference?: string,
): Promise<Record<string, PerSlideTranslation[]>> {
  const data = await postJson<{ translations: Record<string, PerSlideTranslation[]> }>(
    '/api/translateItem',
    { slides, languages, reference },
  );
  return data.translations;
}
