/**
 * Mechanical scoring of a bench run.
 *
 * Everything in here is a fact about the output, not a judgement of it. Translation quality
 * is a human call and the report prints the full text side by side for exactly that reason —
 * but a lot of what makes a model unusable for this app is *not* a taste question:
 *
 * - it can ignore the tool protocol and answer in prose (nothing reaches the reviewer);
 * - it can skip requested slides or invent ids (holes and mis-alignment in the viewer);
 * - it can write the two characters `\n` instead of a newline (visible on the projector);
 * - it can copy the English slide's hard wraps into a language that wraps differently;
 * - it can rewrite four slides when asked to fix one word (blowing away reviewed text);
 * - it can quietly not translate at all and echo the English back.
 *
 * Those are the checks below. A model that fails them is out regardless of how good its
 * French reads.
 */
import type { Content } from '@google/genai';
import type { TranslationBlockResult } from '../nlp.ts';
import type { BenchItem, LineDiscipline } from './fixtures.ts';

/** A tool call as recorded in the stored conversation, with its raw (pre-cleanup) arguments. */
export interface RecordedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Pull every tool call out of a stored conversation, in order.
 *
 * Reading the *conversation* rather than the run result is deliberate: the working copy has
 * already had literal `\n` sequences repaired by `unescapeLiteralEscapes`, so the recorded
 * translations can never show that failure. The raw arguments still can.
 */
export function extractToolCalls(messages: Content[]): RecordedToolCall[] {
  const calls: RecordedToolCall[] = [];
  for (const content of messages) {
    for (const part of content.parts ?? []) {
      if (part.functionCall?.name) {
        calls.push({ name: part.functionCall.name, args: (part.functionCall.args ?? {}) as Record<string, unknown> });
      }
    }
  }
  return calls;
}

/** Every string anywhere inside a value — used to look for literal escapes in tool arguments. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const entry of value) collectStrings(entry, out);
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) collectStrings(entry, out);
  return out;
}

/**
 * Count tool-argument strings containing a literal backslash-n (or -t) rather than a newline.
 *
 * This is the specific failure the `LINE_BREAK_POLICY` block in the prompt exists to prevent,
 * and the reason `unescapeLiteralEscapes` exists to clean up after. A model that needs the
 * cleanup is a model that will need it somewhere we forgot to apply it.
 */
export function countLiteralEscapes(calls: RecordedToolCall[]): number {
  return calls
    .flatMap((call) => collectStrings(call.args))
    .filter((text) => /\\[nt]/.test(text)).length;
}

/** Bible references the run actually looked up, in call order. */
export function lookupReferences(calls: RecordedToolCall[]): string[] {
  return calls
    .filter((call) => call.name === 'lookup_bible_passage')
    .map((call) => {
      const book = String(call.args.book ?? '').toUpperCase();
      const chapter = call.args.chapter;
      const start = call.args.startVerse;
      const end = call.args.endVerse;
      if (start == null) return `${book} ${chapter}`;
      const range = end != null && end !== start ? `-${end}` : '';
      return `${book} ${chapter}:${start}${range}`;
    });
}

/** Did the run look up (at least) the chapter each expected reference names? */
export function coversExpectedLookups(expected: string[], actual: string[]): boolean {
  return expected.every((reference) => {
    const chapter = reference.split(':')[0];
    return actual.some((made) => made.startsWith(chapter));
  });
}

export interface CoverageScore {
  /** Slide ids that were asked for, per language. */
  requested: number;
  /** Of those, how many came back with non-empty text. */
  covered: number;
  /** Ids returned that were never requested — wasted tokens, and a sign of a confused model. */
  extra: number;
}

/**
 * Coverage of the requested work, per language.
 *
 * `requestedIds` is what the prompt actually asked each language for — slides already in the
 * reviewed library are excluded upstream, so "all slides" would be the wrong denominator.
 */
export function scoreCoverage(
  translations: Record<string, TranslationBlockResult[]>,
  requestedIds: Record<string, number[]>,
  slides: string[],
): Record<string, CoverageScore> {
  const out: Record<string, CoverageScore> = {};
  for (const [language, ids] of Object.entries(requestedIds)) {
    const blocks = translations[language] ?? [];
    const bySource = new Map(blocks.map((block) => [block.sourceText, block.translatedText]));
    const covered = ids.filter((id) => (bySource.get(slides[id]) ?? '').trim() !== '').length;
    const requestedTexts = new Set(ids.map((id) => slides[id]));
    const extra = blocks.filter((block) => !requestedTexts.has(block.sourceText)).length;
    out[language] = { requested: ids.length, covered, extra };
  }
  return out;
}

export interface LineStructureScore {
  /** Verse slides whose translation has the same number of lines as the source. */
  verseMatched: number;
  verseTotal: number;
  /** Prose slides whose translation dropped the source's hard wraps (came back as one line). */
  proseReflowed: number;
  proseTotal: number;
}

const lineCount = (text: string): number =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '').length;

/**
 * Score line-break handling against each slide's declared discipline.
 *
 * Verse must keep its structure line for line; prose must lose the source's wraps entirely.
 * Slides marked `either` are skipped — scoring an ambiguous case would just add noise.
 */
export function scoreLineStructure(
  translations: Record<string, TranslationBlockResult[]>,
  slides: string[],
  disciplines: LineDiscipline[],
): LineStructureScore {
  const score: LineStructureScore = { verseMatched: 0, verseTotal: 0, proseReflowed: 0, proseTotal: 0 };
  const bySource = new Map<string, string[]>();
  for (const blocks of Object.values(translations)) {
    for (const block of blocks) {
      bySource.set(block.sourceText, [...(bySource.get(block.sourceText) ?? []), block.translatedText]);
    }
  }

  slides.forEach((slide, index) => {
    const discipline = disciplines[index];
    const outputs = bySource.get(slide) ?? [];
    if (outputs.length === 0) return;
    const sourceLines = lineCount(slide);
    for (const output of outputs) {
      if (discipline === 'verse') {
        score.verseTotal += 1;
        if (lineCount(output) === sourceLines) score.verseMatched += 1;
      } else if (discipline === 'prose' && sourceLines > 1) {
        score.proseTotal += 1;
        if (lineCount(output) === 1) score.proseReflowed += 1;
      }
    }
  });

  return score;
}

/**
 * Fraction of the source's distinctive words that survive verbatim into the translation.
 *
 * A blunt "did it actually translate anything" probe. Short words are excluded because they
 * collide across languages by accident; proper nouns will legitimately survive, so a small
 * ratio is normal and only a large one is a signal. Reported, never thresholded.
 */
export function echoRatio(source: string, translation: string): number {
  const words = (text: string) =>
    text
      .toLowerCase()
      .split(/[^\p{L}]+/u)
      .filter((word) => word.length >= 5);
  const sourceWords = new Set(words(source));
  if (sourceWords.size === 0) return 0;
  const translationWords = new Set(words(translation));
  let shared = 0;
  for (const word of sourceWords) if (translationWords.has(word)) shared += 1;
  return shared / sourceWords.size;
}

/** Highest echo ratio across every translated slide — the worst case, not the average. */
export function maxEchoRatio(translations: Record<string, TranslationBlockResult[]>): number {
  let worst = 0;
  for (const blocks of Object.values(translations)) {
    for (const block of blocks) {
      worst = Math.max(worst, echoRatio(block.sourceText, block.translatedText));
    }
  }
  return worst;
}

export interface DraftScore {
  setTranslationsCalled: boolean;
  coverage: Record<string, CoverageScore>;
  /** Total requested slide×language pairs, and how many came back. */
  coveredTotal: number;
  requestedTotal: number;
  extraTotal: number;
  lineStructure: LineStructureScore;
  literalEscapes: number;
  lookups: string[];
  expectedLookupsCovered: boolean;
  maxEchoRatio: number;
  toolCallCounts: Record<string, number>;
}

/** Score a whole-item draft run. */
export function scoreDraft(params: {
  item: BenchItem;
  slides: string[];
  requestedIds: Record<string, number[]>;
  translations: Record<string, TranslationBlockResult[]>;
  messages: Content[];
  setTranslationsCalled: boolean;
}): DraftScore {
  const { item, slides, requestedIds, translations, messages, setTranslationsCalled } = params;
  const calls = extractToolCalls(messages);
  const coverage = scoreCoverage(translations, requestedIds, slides);
  const lookups = lookupReferences(calls);

  const toolCallCounts: Record<string, number> = {};
  for (const call of calls) toolCallCounts[call.name] = (toolCallCounts[call.name] ?? 0) + 1;

  return {
    setTranslationsCalled,
    coverage,
    coveredTotal: Object.values(coverage).reduce((sum, entry) => sum + entry.covered, 0),
    requestedTotal: Object.values(coverage).reduce((sum, entry) => sum + entry.requested, 0),
    extraTotal: Object.values(coverage).reduce((sum, entry) => sum + entry.extra, 0),
    lineStructure: scoreLineStructure(translations, slides, item.slides.map((slide) => slide.discipline)),
    literalEscapes: countLiteralEscapes(calls),
    lookups,
    expectedLookupsCovered: coversExpectedLookups(item.expectedLookups, lookups),
    maxEchoRatio: maxEchoRatio(translations),
    toolCallCounts,
  };
}

export interface FollowUpScore {
  /** Did it make a targeted edit rather than re-sending whole slides? */
  usedRevise: boolean;
  usedSetTranslations: boolean;
  /** How many slide×language pairs the run touched. Asked to fix one word, this should be 1. */
  blastRadius: number;
  /** Does the edited text contain what the reviewer asked for? */
  appliedRequestedChange: boolean;
  /** Does the edited text still contain the wording the reviewer objected to? */
  leftObjectionableWording: boolean;
  toolCallCounts: Record<string, number>;
}

/**
 * Score a follow-up round: the reviewer asks for one word to change in one slide.
 *
 * `blastRadius` is the number that matters. The whole point of `revise_translation` is that a
 * reviewer's small correction does not put every other slide back through the model, where it
 * may be silently rewritten after they already approved it.
 */
export function scoreFollowUp(params: {
  translations: Record<string, TranslationBlockResult[]>;
  messages: Content[];
  setTranslationsCalled: boolean;
  /** Language and slide index the reviewer's request was about. */
  target: { language: string; slideIndex: number; slideText: string };
  /** Wording the reviewer asked for, and the wording they objected to. */
  expectedSubstring: string;
  objectionableSubstring: string;
}): FollowUpScore {
  const { translations, messages, setTranslationsCalled, target, expectedSubstring, objectionableSubstring } = params;
  const calls = extractToolCalls(messages);
  const toolCallCounts: Record<string, number> = {};
  for (const call of calls) toolCallCounts[call.name] = (toolCallCounts[call.name] ?? 0) + 1;

  const edited =
    (translations[target.language] ?? []).find((block) => block.sourceText === target.slideText)?.translatedText ?? '';
  const lower = edited.toLowerCase();

  return {
    usedRevise: (toolCallCounts.revise_translation ?? 0) > 0,
    usedSetTranslations: setTranslationsCalled,
    blastRadius: Object.values(translations).reduce((sum, blocks) => sum + blocks.length, 0),
    appliedRequestedChange: lower.includes(expectedSubstring.toLowerCase()),
    leftObjectionableWording: lower.includes(objectionableSubstring.toLowerCase()),
    toolCallCounts,
  };
}

export interface NotesScore {
  /** Ids the model was asked to translate. */
  requestedIds: number[];
  /** Ids it returned. */
  returnedIds: number[];
  /** Requested ids that came back with non-empty text. */
  covered: number;
  /** Ids returned that were context-only or out of range — a protocol violation either way. */
  spurious: number;
  maxEchoRatio: number;
}

/** Score one incremental notes-block translation. */
export function scoreNotes(params: {
  chunks: string[];
  isTranslationNeeded: boolean[];
  returnedIds: number[];
  blocks: TranslationBlockResult[];
}): NotesScore {
  const { chunks, isTranslationNeeded, returnedIds, blocks } = params;
  const requestedIds = chunks.map((_, index) => index).filter((index) => isTranslationNeeded[index]);
  const requested = new Set(requestedIds);
  const bySource = new Map(blocks.map((block) => [block.sourceText, block.translatedText]));

  let worstEcho = 0;
  for (const block of blocks) worstEcho = Math.max(worstEcho, echoRatio(block.sourceText, block.translatedText));

  return {
    requestedIds,
    returnedIds,
    covered: requestedIds.filter((id) => (bySource.get(chunks[id]) ?? '').trim() !== '').length,
    spurious: returnedIds.filter((id) => !requested.has(id)).length,
    maxEchoRatio: worstEcho,
  };
}
