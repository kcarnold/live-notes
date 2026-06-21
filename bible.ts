/**
 * Canonical Bible text lookup against the no-auth helloao.org API.
 *
 * The slide-drafting model (see `draftItemTranslations` in nlp.ts) calls this as a tool:
 * when a slide is or quotes Scripture, it asks for the passage and gets the canonical
 * wording in each target language, then adapts that rather than translating from scratch.
 *
 * The API returns a whole chapter as JSON; we fetch it (cached per chapter+translation),
 * pick the requested verse range, and flatten each verse's content into plain text.
 * Shape sampled from e.g. https://bible.helloao.org/api/hatbsa/JHN/3.json:
 *   chapter.content = [{ type: 'verse', number, content: (string | { text })[] }, { type: 'line_break' }, ...]
 */

/** Target language name → helloao translation id. Adjust as better translations appear. */
export const BIBLE_TRANSLATIONS: Record<string, string> = {
  'Haitian Creole': 'hatbsa',
  French: 'fra_ncl',
  Spanish: 'spa_r09',
};

const API_BASE = 'https://bible.helloao.org/api';

interface VerseEntry {
  type: string;
  number?: number;
  content?: Array<string | { text?: string }>;
}
interface ChapterResponse {
  chapter?: { number?: number; content?: VerseEntry[] };
}

// Whole chapters are small and immutable; cache the parsed JSON for the process lifetime.
const chapterCache = new Map<string, Promise<ChapterResponse | null>>();

async function fetchChapter(
  translationId: string,
  book: string,
  chapter: number,
): Promise<ChapterResponse | null> {
  const url = `${API_BASE}/${translationId}/${book}/${chapter}.json`;
  let pending = chapterCache.get(url);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        return (await response.json()) as ChapterResponse;
      } catch {
        return null;
      }
    })();
    chapterCache.set(url, pending);
  }
  const result = await pending;
  // Don't cache transient failures — let a later call retry.
  if (result === null) chapterCache.delete(url);
  return result;
}

function flattenVerse(content: VerseEntry['content']): string {
  if (!content) return '';
  return content
    .map((item) => (typeof item === 'string' ? item : item.text ?? ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch a passage in one translation, returning the verses joined (one per line), or
 * null if the chapter couldn't be fetched or the range is empty.
 */
export async function fetchPassage(
  translationId: string,
  book: string,
  chapter: number,
  startVerse?: number,
  endVerse?: number,
): Promise<string | null> {
  const data = await fetchChapter(translationId, book.toUpperCase(), chapter);
  const entries = data?.chapter?.content;
  if (!entries) return null;

  const last = endVerse ?? startVerse;
  const verses = entries.filter((entry) => {
    if (entry.type !== 'verse' || typeof entry.number !== 'number') return false;
    if (startVerse == null) return true;
    return entry.number >= startVerse && entry.number <= (last ?? startVerse);
  });
  if (verses.length === 0) return null;

  const text = verses.map((verse) => flattenVerse(verse.content)).join('\n').trim();
  return text || null;
}

export interface BibleLookupArgs {
  book: string;
  chapter: number;
  startVerse?: number;
  endVerse?: number;
}

/** Observability record for one tool call — surfaced to PostHog and the review screen. */
export interface BibleToolCall {
  reference: string;
  /** Languages for which canonical text was found. */
  foundLanguages: string[];
  /** Requested languages with no canonical text (chapter/verse missing or no translation). */
  missingLanguages: string[];
  ok: boolean;
}

export interface BibleLookupResult {
  reference: string;
  /** language → canonical passage text (only languages that resolved). */
  passages: Record<string, string>;
  call: BibleToolCall;
}

/** Human-readable reference like "JHN 3:16" or "PSA 23" or "ROM 8:1-4". */
export function formatReference(args: BibleLookupArgs): string {
  const book = args.book.toUpperCase();
  if (args.startVerse == null) return `${book} ${args.chapter}`;
  const end = args.endVerse != null && args.endVerse !== args.startVerse ? `-${args.endVerse}` : '';
  return `${book} ${args.chapter}:${args.startVerse}${end}`;
}

/**
 * Look up a passage in every requested language that has a configured translation,
 * returning the per-language text plus an observability record.
 */
export async function lookupBiblePassage(
  args: BibleLookupArgs,
  languages: string[],
): Promise<BibleLookupResult> {
  const reference = formatReference(args);
  const passages: Record<string, string> = {};
  const foundLanguages: string[] = [];
  const missingLanguages: string[] = [];

  await Promise.all(
    languages.map(async (language) => {
      const translationId = BIBLE_TRANSLATIONS[language];
      if (!translationId) {
        missingLanguages.push(language);
        return;
      }
      const text = await fetchPassage(
        translationId,
        args.book,
        args.chapter,
        args.startVerse,
        args.endVerse,
      );
      if (text) {
        passages[language] = text;
        foundLanguages.push(language);
      } else {
        missingLanguages.push(language);
      }
    }),
  );

  return {
    reference,
    passages,
    call: {
      reference,
      foundLanguages,
      missingLanguages,
      ok: foundLanguages.length > 0,
    },
  };
}
