/**
 * Session export: turn a session's Y-Sweet doc into a single, self-contained,
 * human-readable HTML page for download/review.
 *
 * Everything here is pure (a `Y.Doc` in, strings out) so it can be unit-tested
 * with a local `Y.Doc` and reused by the Express `/api/session/export` endpoint.
 * The shape of the doc mirrors what the live components read (see App.tsx and the
 * various *Container components):
 *   - `sourceBlocks`         Y.Array of block Y.Maps (the notes being taken)
 *   - `notesTranslationCache` Y.Map `${lang}:${content}` -> translated string
 *   - `proclaimPresentations` Y.Map itemId -> { title, slides: string[] }
 *   - `proclaimServiceOrder`  Y.Map `order` -> itemId[]
 *   - `slideTranslations`     Y.Map slideTranslationKey(lang, text) -> entry
 *   - `transcriptDoc`         Y.XmlFragment (live speech transcript)
 */
import * as Y from 'yjs';
import {
  resolveSlideTranslation,
  slideTranslationKey,
  type SlideTranslationEntry,
  type ResolvedSlideTranslation,
} from './src/slideTranslation.ts';

/**
 * Languages included in an export. Kept in sync with `configAtoms.languages`
 * (the frontend can't be imported here without pulling in React).
 */
export const EXPORT_LANGUAGES = ['French', 'Haitian Creole', 'Spanish'] as const;

// --- Structured, render-agnostic representation -------------------------------

export interface ExportedNoteLine {
  type: 'heading' | 'bullet';
  level: number;
  content: string;
  /** Translation per language (absent when not translated yet). */
  translations: Record<string, string>;
}

export interface ExportedSlide {
  index: number;
  text: string;
  /** Resolved translation per language (absent when not translated yet). */
  translations: Record<string, ResolvedSlideTranslation>;
}

export interface ExportedPresentation {
  itemId: string;
  title: string;
  slides: ExportedSlide[];
}

export interface ExportedLiveTranscript {
  /** BCP-47 code the transcript was published under (`en` is the source). */
  code: string;
  /** Localized display name for the code, e.g. "French" (falls back to the code). */
  label: string;
  /** True for the English source transcript produced by the primary bridge. */
  isSource: boolean;
  text: string;
}

export interface SessionExport {
  docId: string;
  /** Human date parsed from a `doc-YYYY-MM-DD` id, else undefined. */
  date?: string;
  generatedAt: string;
  languages: string[];
  notes: ExportedNoteLine[];
  presentations: ExportedPresentation[];
  /**
   * Live speech-translation transcripts (English source + each target language),
   * written by the live-audio pipeline into `liveTranscript-{code}` Y.Text keys.
   */
  liveTranscripts: ExportedLiveTranscript[];
  /** Legacy Web Speech API transcript (`transcriptDoc`); empty in current sessions. */
  transcript: string;
}

/** Prefix the live-audio pipeline uses for per-language transcript Y.Text keys. */
const LIVE_TRANSCRIPT_PREFIX = 'liveTranscript-';
/** Code of the English source transcript (matches TranslationBridge.SOURCE_CODE). */
const LIVE_TRANSCRIPT_SOURCE_CODE = 'en';

// --- Y.Doc extraction ---------------------------------------------------------

interface RawBlock {
  type: 'heading' | 'bullet';
  level: number;
  content: string;
  position: string;
  id: string;
}

/** Read + sort the note blocks the way the block editor does (by fractional position). */
function extractNotes(ydoc: Y.Doc, languages: readonly string[]): ExportedNoteLine[] {
  const yBlocks = ydoc.getArray<Y.Map<unknown>>('sourceBlocks');
  const cache = ydoc.getMap<string>('notesTranslationCache');

  const blocks: RawBlock[] = yBlocks.toArray().map((yMap) => {
    const content = yMap.get('content');
    const text = content instanceof Y.Text ? content.toString() : '';
    return {
      type: (yMap.get('type') as RawBlock['type']) ?? 'bullet',
      level: (yMap.get('level') as number) ?? 0,
      content: text,
      position: (yMap.get('position') as string) ?? '',
      id: (yMap.get('id') as string) ?? '',
    };
  });

  // Fractional-index ordering: native string comparison (see compareBlockPositions).
  blocks.sort((a, b) =>
    a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  return blocks
    .filter((b) => b.content.trim() !== '')
    .map((b) => {
      const trimmed = b.content.trim();
      const translations: Record<string, string> = {};
      for (const lang of languages) {
        const t = cache.get(`${lang}:${trimmed}`);
        if (typeof t === 'string' && t.trim() !== '') translations[lang] = t;
      }
      return { type: b.type, level: b.level, content: b.content.trim(), translations };
    });
}

/** Read each presentation (in service order when available) with resolved slide translations. */
function extractPresentations(ydoc: Y.Doc, languages: readonly string[]): ExportedPresentation[] {
  const presentationsMap = ydoc.getMap<{ title?: string; slides?: unknown[] }>('proclaimPresentations');
  const serviceOrderMap = ydoc.getMap<string[]>('proclaimServiceOrder');
  const translationsMap = ydoc.getMap<SlideTranslationEntry>('slideTranslations');

  const lookup = (lang: string, slideText: string) =>
    translationsMap.get(slideTranslationKey(lang, slideText));

  const ordered = serviceOrderMap.get('order');
  const itemIds =
    Array.isArray(ordered) && ordered.length > 0
      ? ordered.filter((id) => presentationsMap.has(id))
      : Array.from(presentationsMap.keys());

  const presentations: ExportedPresentation[] = [];
  for (const itemId of itemIds) {
    const presentation = presentationsMap.get(itemId);
    if (!presentation) continue;
    const slides = (presentation.slides ?? []).filter((s): s is string => typeof s === 'string');
    if (slides.length === 0) continue;

    const exportedSlides: ExportedSlide[] = slides.map((text, index) => {
      const translations: Record<string, ResolvedSlideTranslation> = {};
      if (text.trim() !== '') {
        for (const lang of languages) {
          const resolved = resolveSlideTranslation(lang, text, lookup);
          if (resolved) translations[lang] = resolved;
        }
      }
      return { index, text, translations };
    });

    presentations.push({
      itemId,
      title: presentation.title?.trim() || 'Untitled',
      slides: exportedSlides,
    });
  }
  return presentations;
}

/** Flatten a transcript Y.XmlFragment to plain text, one line per block element. */
function extractTranscript(ydoc: Y.Doc): string {
  const fragment = ydoc.getXmlFragment('transcriptDoc');
  const walk = (node: Y.XmlFragment | Y.XmlElement): string => {
    let text = '';
    node.forEach((item) => {
      if (item instanceof Y.XmlElement) {
        text += walk(item);
        if (['p', 'paragraph', 'heading', 'li', 'div'].includes(item.nodeName)) text += '\n';
      } else if (item instanceof Y.XmlText) {
        text += item.toString();
      }
    });
    return text;
  };
  return walk(fragment).trim();
}

/**
 * Collect the live speech-translation transcripts. The pipeline creates a
 * `liveTranscript-{code}` Y.Text per language on demand, so which codes exist
 * varies by session — enumerate the doc's root types rather than guessing. The
 * English source is listed first; the rest are sorted by localized label.
 */
function extractLiveTranscripts(ydoc: Y.Doc): ExportedLiveTranscript[] {
  const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
  const transcripts: ExportedLiveTranscript[] = [];

  for (const key of ydoc.share.keys()) {
    if (!key.startsWith(LIVE_TRANSCRIPT_PREFIX)) continue;
    const text = ydoc.getText(key).toString().trim();
    if (text === '') continue;
    const code = key.slice(LIVE_TRANSCRIPT_PREFIX.length);
    const isSource = code === LIVE_TRANSCRIPT_SOURCE_CODE;
    let label: string;
    try {
      label = displayNames.of(code) ?? code;
    } catch {
      label = code;
    }
    transcripts.push({ code, label, isSource, text });
  }

  return transcripts.sort((a, b) => {
    if (a.isSource !== b.isSource) return a.isSource ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

/** Parse `doc-YYYY-MM-DD` into a friendly date; undefined for other id shapes. */
function docIdToDate(docId: string): string | undefined {
  const m = /^doc-(\d{4})-(\d{2})-(\d{2})$/.exec(docId);
  if (!m) return undefined;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** Build the structured export from a fully-synced Y.Doc. */
export function buildSessionExport(
  ydoc: Y.Doc,
  docId: string,
  languages: readonly string[] = EXPORT_LANGUAGES,
): SessionExport {
  return {
    docId,
    date: docIdToDate(docId),
    generatedAt: new Date().toISOString(),
    languages: [...languages],
    notes: extractNotes(ydoc, languages),
    presentations: extractPresentations(ydoc, languages),
    liveTranscripts: extractLiveTranscripts(ydoc),
    transcript: extractTranscript(ydoc),
  };
}

// --- HTML rendering -----------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escape + turn newlines into <br> for multi-line slide/translation text. */
function multiline(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function renderNotes(notes: ExportedNoteLine[], languages: string[]): string {
  if (notes.length === 0) return '';
  const items = notes
    .map((line) => {
      const indent = line.type === 'bullet' ? line.level * 1.5 : 0;
      const original =
        line.type === 'heading'
          ? `<div class="note-heading">${escapeHtml(line.content)}</div>`
          : `<div class="note-original">${escapeHtml(line.content)}</div>`;
      const translations = languages
        .filter((lang) => line.translations[lang])
        .map(
          (lang) =>
            `<div class="note-translation"><span class="lang-tag">${escapeHtml(lang)}</span>${escapeHtml(
              line.translations[lang],
            )}</div>`,
        )
        .join('');
      return `<div class="note-line" style="margin-left:${indent}rem">${original}${translations}</div>`;
    })
    .join('\n');
  return `<section><h2>Notes</h2>${items}</section>`;
}

function renderPresentations(presentations: ExportedPresentation[], languages: string[]): string {
  if (presentations.length === 0) return '';
  const blocks = presentations
    .map((pres) => {
      const rows = pres.slides
        .filter((slide) => slide.text.trim() !== '')
        .map((slide) => {
          const cols = [`<td class="slide-original">${multiline(slide.text)}</td>`];
          for (const lang of languages) {
            const resolved = slide.translations[lang];
            if (!resolved) {
              cols.push(`<td class="slide-untranslated">&mdash;</td>`);
              continue;
            }
            const badges: string[] = [];
            if (resolved.isFallbackLanguage)
              badges.push(`<span class="badge">${escapeHtml(resolved.displayLanguage)}</span>`);
            if (resolved.entry.status === 'auto')
              badges.push(`<span class="badge badge-auto">unreviewed</span>`);
            cols.push(
              `<td>${badges.join(' ')}${badges.length ? '<br>' : ''}${multiline(resolved.entry.text)}</td>`,
            );
          }
          return `<tr><td class="slide-num">${slide.index + 1}</td>${cols.join('')}</tr>`;
        })
        .join('\n');
      if (rows === '') return '';
      const headerCols = languages.map((lang) => `<th>${escapeHtml(lang)}</th>`).join('');
      return `<div class="presentation"><h3>${escapeHtml(pres.title)}</h3>
      <table><thead><tr><th class="slide-num">#</th><th>Original</th>${headerCols}</tr></thead>
      <tbody>${rows}</tbody></table></div>`;
    })
    .filter((b) => b !== '')
    .join('\n');
  if (blocks === '') return '';
  return `<section><h2>Slides</h2>${blocks}</section>`;
}

/** Split accumulated transcript text into escaped <p> paragraphs. */
function renderTranscriptParagraphs(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('\n');
}

function renderLiveTranscripts(transcripts: ExportedLiveTranscript[]): string {
  if (transcripts.length === 0) return '';
  const blocks = transcripts
    .map((t) => {
      const heading = t.isSource ? `${escapeHtml(t.label)} (source)` : escapeHtml(t.label);
      return `<div class="presentation"><h3>${heading}</h3><div class="transcript">${renderTranscriptParagraphs(
        t.text,
      )}</div></div>`;
    })
    .join('\n');
  return `<section><h2>Live speech translation</h2>${blocks}</section>`;
}

function renderTranscript(transcript: string): string {
  if (transcript.trim() === '') return '';
  return `<section><h2>Transcript</h2><div class="transcript">${renderTranscriptParagraphs(
    transcript,
  )}</div></section>`;
}

/** Render the structured export to a single self-contained HTML document. */
export function renderSessionHtml(data: SessionExport): string {
  const title = data.date ? `Live Notes — ${data.date}` : `Live Notes — ${data.docId}`;
  const generated = new Date(data.generatedAt).toLocaleString('en-US');

  const notesHtml = renderNotes(data.notes, data.languages);
  const presentationsHtml = renderPresentations(data.presentations, data.languages);
  const liveTranscriptsHtml = renderLiveTranscripts(data.liveTranscripts);
  const transcriptHtml = renderTranscript(data.transcript);
  const body =
    [notesHtml, presentationsHtml, liveTranscriptsHtml, transcriptHtml]
      .filter((s) => s !== '')
      .join('\n') ||
    `<p class="empty">This session has no notes, slides, or transcript yet.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; line-height: 1.5; color: #1a1a1a; }
  header { border-bottom: 2px solid #e5e7eb; padding-bottom: 1rem; margin-bottom: 2rem; }
  h1 { font-size: 1.75rem; margin: 0 0 0.25rem; }
  .meta { color: #6b7280; font-size: 0.85rem; }
  h2 { font-size: 1.35rem; margin: 2.5rem 0 1rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.3rem; }
  h3 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
  .note-line { margin: 0.6rem 0; }
  .note-heading { font-weight: 700; font-size: 1.05rem; margin-top: 0.5rem; }
  .note-original { font-weight: 500; }
  .note-original::before { content: "• "; color: #9ca3af; }
  .note-translation { margin: 0.15rem 0 0.15rem 1.25rem; color: #374151; }
  .lang-tag { display: inline-block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.03em;
    color: #6b7280; background: #f3f4f6; border-radius: 0.25rem; padding: 0 0.35rem; margin-right: 0.4rem; }
  table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1.5rem; font-size: 0.95rem; }
  th, td { border: 1px solid #e5e7eb; padding: 0.5rem 0.65rem; text-align: left; vertical-align: top; }
  th { background: #f9fafb; font-size: 0.85rem; }
  .slide-num { width: 2rem; text-align: center; color: #9ca3af; }
  .slide-original { font-weight: 500; }
  .slide-untranslated { color: #9ca3af; text-align: center; }
  .badge { display: inline-block; font-size: 0.65rem; background: #e5e7eb; color: #374151;
    border-radius: 0.25rem; padding: 0 0.35rem; }
  .badge-auto { background: #fef3c7; color: #92400e; }
  .transcript p { margin: 0.4rem 0; }
  .empty { color: #6b7280; font-style: italic; }
  @media (prefers-color-scheme: dark) {
    body { color: #e5e7eb; background: #0b0f19; }
    header, h2 { border-color: #1f2937; }
    .meta, .note-translation, .slide-untranslated { color: #9ca3af; }
    .lang-tag, th { background: #1f2937; color: #9ca3af; }
    th, td { border-color: #1f2937; }
    .badge { background: #374151; color: #d1d5db; }
    .badge-auto { background: #78350f; color: #fde68a; }
  }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">Session <code>${escapeHtml(data.docId)}</code> &middot; exported ${escapeHtml(
    generated,
  )}</div>
</header>
<main>
${body}
</main>
</body>
</html>`;
}

/** Suggested download filename for a session export. */
export function sessionExportFilename(docId: string): string {
  const safe = docId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `live-notes-${safe}.html`;
}
