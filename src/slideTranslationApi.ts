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
import type { BibleToolCall } from '../bible.ts';
import type { Content } from '@google/genai';

export type { BibleToolCall };
export type { Content };

export interface TranslateItemResult {
  translations: Record<string, PerSlideTranslation[]>;
  /** Bible passages the model looked up while drafting (for review-screen observability). */
  bibleLookups: BibleToolCall[];
  /** Key under which the agent conversation was stored (itemId, or a content hash). */
  conversationId: string;
}

export type SlideConversationStatus = 'running' | 'idle' | 'error';

/** The server-side agent conversation for one item (raw Gemini history + snapshot). */
export interface SlideConversation {
  itemId: string;
  itemTitle: string;
  slides: string[];
  slidesHash: string;
  languages: string[];
  messages: Content[];
  status: SlideConversationStatus;
  updatedAt: number;
}

/** A translation the agent revised during a follow-up, for the browser to write to Yjs. */
export interface ConversationTranslationUpdate {
  language: string;
  sourceText: string;
  text: string;
}

export interface ConversationMessageResult {
  conversation: SlideConversation;
  updatedTranslations: ConversationTranslationUpdate[];
  bibleLookups: BibleToolCall[];
}

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
  itemTitle?: string,
  itemId?: string,
): Promise<TranslateItemResult> {
  const data = await postJson<{
    translations: Record<string, PerSlideTranslation[]>;
    bibleLookups?: BibleToolCall[];
    conversationId: string;
  }>('/api/translateItem', { slides, languages, itemTitle, itemId });
  return {
    translations: data.translations,
    bibleLookups: data.bibleLookups ?? [],
    conversationId: data.conversationId,
  };
}

/** Fetch the stored agent conversation for an item, or null if there isn't one. */
export async function fetchConversation(itemId: string): Promise<SlideConversation | null> {
  const response = await fetch(`/api/slideConversation?itemId=${encodeURIComponent(itemId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`/api/slideConversation failed: ${response.status}`);
  const data = (await response.json()) as { conversation: SlideConversation };
  return data.conversation;
}

/** Send a follow-up message; resumes the agent and returns any revised translations. */
export async function sendConversationMessage(
  itemId: string,
  text: string,
): Promise<ConversationMessageResult> {
  const data = await postJson<{
    conversation: SlideConversation;
    updatedTranslations?: ConversationTranslationUpdate[];
    bibleLookups?: BibleToolCall[];
  }>('/api/slideConversation/message', { itemId, text });
  return {
    conversation: data.conversation,
    updatedTranslations: data.updatedTranslations ?? [],
    bibleLookups: data.bibleLookups ?? [],
  };
}

/** Append a reviewer note (e.g. a manual edit) to the conversation; no agent run. */
export async function postConversationNote(itemId: string, text: string): Promise<void> {
  await postJson('/api/slideConversation/note', { itemId, text });
}
