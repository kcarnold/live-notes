/**
 * The bench tasks: our real workloads, wired to run against any model.
 *
 * Each task runs the *production* code path — `translateItem` orchestration, the exported
 * prompt builders, the real tool declarations — with only the model swapped. Anything else
 * would measure the bench rather than the models.
 */
import type { LanguageModel } from 'ai';
import type { Content } from '@google/genai';
import { buildSeedConversationPrompt, type DraftItemTarget, type TranslationBlockResult } from '../nlp.ts';
import { BIBLE_TRANSLATIONS } from '../bible.ts';
import { translateItem } from '../src/slideItemTranslation.ts';
import type { SlideTranslationLookup } from '../src/slideTranslation.ts';
import { draftItemTranslations, runSlideTranslationAgent } from '../llm/slideAgent.ts';
import { translateBlock } from '../llm/notesBlock.ts';
import type { TraceAttributes } from '../llm/telemetry.ts';
import {
  BENCH_ITEMS,
  FOLLOW_UP,
  NOTES_LANGUAGE,
  NOTES_TODO,
  slideTexts,
  type BenchItem,
} from './fixtures.ts';
import { scoreDraft, scoreFollowUp, scoreNotes, type DraftScore, type FollowUpScore, type NotesScore } from './scoring.ts';

/**
 * The same general context the server injects into every slide-translation prompt
 * (`SLIDE_TRANSLATION_CONTEXT` in server.ts). Restated here rather than imported because
 * importing server.ts would start an Express app and demand every production env var.
 */
export const BENCH_GENERAL_CONTEXT =
  'These slides are shown at a Presbyterian Church in America (PCA) worship service. The ' +
  'translations are provided alongside the service so non-English speakers can follow along — ' +
  'they are for understanding and reference, not for congregational singing or as an official ' +
  'literal/liturgical rendering. Aim for clear, natural, reverent wording in each target language.';

/** What a single task run produced, before and after scoring. */
export interface TaskRun {
  taskId: string;
  /** Model spec string, e.g. `openrouter:google/gemini-3-pro`. */
  model: string;
  ok: boolean;
  /** Present when the run threw — a refused schema, a rate limit, a model that can't tool-call. */
  error?: string;
  /** Wall-clock milliseconds, including tool execution (Bible lookups hit the network). */
  durationMs: number;
  /** Model round-trips the run took. */
  steps: number;
  usage?: {
    promptTokenCount: number;
    cachedContentTokenCount: number;
    candidatesTokenCount: number;
    thoughtsTokenCount: number;
    totalTokenCount: number;
    callCount: number;
  };
  /** USD, when the provider reports it (OpenRouter does with usage accounting on). */
  costUsd?: number;
  /** The translations produced, for human side-by-side reading. */
  translations?: Record<string, TranslationBlockResult[]>;
  /** Any text the model wrote back to the reviewer. */
  reply?: string;
  score?: DraftScore | FollowUpScore | NotesScore;
}

export interface TaskContext {
  model: LanguageModel;
  modelSpec: string;
  /** Cap on agent rounds, so one confused model can't spend the whole budget. */
  maxSteps: number;
  /**
   * Trace/person ids for this run. Only leave the process when telemetry is registered
   * (`--telemetry`), which is what makes the bench double as the smoke test for whether
   * PostHog actually honours them — see docs/llm-providers.md.
   */
  trace?: TraceAttributes;
}

export interface BenchTask {
  id: string;
  title: string;
  /** What this task is actually probing, printed in the report. */
  probe: string;
  run: (context: TaskContext) => Promise<TaskRun>;
}

/**
 * Total USD cost across a run's steps, from OpenRouter's usage accounting.
 *
 * Only OpenRouter reports this. Direct providers return undefined, and the report says so
 * rather than inventing a number from a price table that would go stale within the month.
 */
function costFromMetadata(metadata: Array<Record<string, unknown>>): number | undefined {
  let total = 0;
  let found = false;
  for (const entry of metadata) {
    const openrouter = entry.openrouter as { usage?: { cost?: number } } | undefined;
    const cost = openrouter?.usage?.cost;
    if (typeof cost === 'number') {
      total += cost;
      found = true;
    }
  }
  return found ? total : undefined;
}

/** The trailing text the model addressed to the reviewer, if any. */
function finalReply(messages: Content[]): string {
  const last = messages.at(-1);
  if (last?.role !== 'model') return '';
  return (last.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
    .trim();
}

/** A library lookup backed by an item's `reviewedContext` (empty for most items). */
function lookupFor(item: BenchItem): SlideTranslationLookup {
  const slides = slideTexts(item);
  return (language, slideText) => {
    const index = slides.indexOf(slideText);
    const text = index === -1 ? undefined : item.reviewedContext?.[language]?.[index];
    return text ? { text, status: 'reviewed', provenance: 'human' } : undefined;
  };
}

/**
 * Draft a whole item, exactly as `/api/translateItem` does.
 *
 * `translateItem` decides which slides each language actually needs — reviewed ones become
 * context, duplicates are asked for once — and we capture the targets it built so the scorer
 * grades against what was really requested rather than against the full slide list.
 */
function draftTask(item: BenchItem): BenchTask {
  return {
    id: `draft:${item.id}`,
    title: `Draft "${item.title}" into ${item.languages.join(', ')}`,
    probe:
      item.expectedLookups.length > 0
        ? 'Tool protocol, coverage, and whether the model grounds Scripture via lookup_bible_passage instead of translating it from scratch.'
        : 'Tool protocol, coverage, and line-break discipline (verse keeps its lines, prose loses the English hard wraps).',
    run: async ({ model, modelSpec, maxSteps, trace }) => {
      const slides = slideTexts(item);
      const started = Date.now();
      let capturedTargets: DraftItemTarget[] = [];
      let messages: Content[] = [];
      let setTranslationsCalled = false;
      let steps = 0;
      let usage: TaskRun['usage'];
      let costUsd: number | undefined;
      const translationsByLanguage: Record<string, TranslationBlockResult[]> = {};

      try {
        await translateItem({
          slides,
          languages: item.languages,
          lookup: lookupFor(item),
          translate: async ({ slides: sourceSlides, targets }) => {
            capturedTargets = targets;
            const result = await draftItemTranslations({
              model,
              sourceSlides,
              targets,
              generalContext: BENCH_GENERAL_CONTEXT,
              itemTitle: item.title,
              maxSteps,
              trace,
            });
            messages = result.messages;
            setTranslationsCalled = result.setTranslationsCalled;
            steps = result.steps;
            usage = result.usage;
            costUsd = costFromMetadata(result.providerMetadata);
            Object.assign(translationsByLanguage, result.translations);
            return result.translations;
          },
        });
      } catch (error) {
        return {
          taskId: `draft:${item.id}`,
          model: modelSpec,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - started,
          steps,
        };
      }

      const requestedIds: Record<string, number[]> = {};
      for (const target of capturedTargets) {
        requestedIds[target.language] = target.isTranslationNeeded
          .map((needed, index) => (needed ? index : -1))
          .filter((index) => index >= 0);
      }

      return {
        taskId: `draft:${item.id}`,
        model: modelSpec,
        ok: true,
        durationMs: Date.now() - started,
        steps,
        usage,
        costUsd,
        translations: translationsByLanguage,
        reply: finalReply(messages),
        score: scoreDraft({
          item,
          slides,
          requestedIds,
          translations: translationsByLanguage,
          messages,
          setTranslationsCalled,
        }),
      };
    },
  };
}

/**
 * Resume a fixed already-drafted conversation with a reviewer's one-word correction.
 *
 * The seed conversation is built with `buildSeedConversationPrompt` — the same function the
 * server uses when every slide came from the library and no agent ever ran — so the history
 * the model sees is a shape production really produces.
 */
const followUpTask: BenchTask = {
  id: 'follow-up',
  title: 'Apply a reviewer\'s one-word correction',
  probe:
    'Blast radius. Asked to change one word on one slide, does the model make a targeted ' +
    'revise_translation edit, or re-send whole slides (silently reworking already-approved text)?',
  run: async ({ model, modelSpec, maxSteps, trace }) => {
    const item = FOLLOW_UP.item;
    const slides = slideTexts(item);
    const seedPrompt = buildSeedConversationPrompt({
      slides,
      translations: {
        [FOLLOW_UP.language]: FOLLOW_UP.seedTranslations.map((text) => ({ text })),
      },
      generalContext: BENCH_GENERAL_CONTEXT,
    });
    const messages: Content[] = [
      { role: 'user', parts: [{ text: seedPrompt }] },
      { role: 'user', parts: [{ text: FOLLOW_UP.message }] },
    ];
    const bibleLanguages = [FOLLOW_UP.language].filter((language) => BIBLE_TRANSLATIONS[language]);

    const started = Date.now();
    try {
      const result = await runSlideTranslationAgent({
        model,
        sourceSlides: slides,
        messages,
        bibleLanguages,
        currentTranslations: { [FOLLOW_UP.language]: FOLLOW_UP.seedTranslations },
        maxSteps,
        trace,
      });

      return {
        taskId: 'follow-up',
        model: modelSpec,
        ok: true,
        durationMs: Date.now() - started,
        steps: result.steps,
        usage: result.usage,
        costUsd: costFromMetadata(result.providerMetadata),
        translations: result.translations,
        reply: finalReply(result.messages),
        score: scoreFollowUp({
          translations: result.translations,
          messages: result.messages,
          setTranslationsCalled: result.setTranslationsCalled,
          target: {
            language: FOLLOW_UP.language,
            slideIndex: FOLLOW_UP.slideIndex,
            slideText: slides[FOLLOW_UP.slideIndex],
          },
          expectedSubstring: FOLLOW_UP.expectedSubstring,
          objectionableSubstring: FOLLOW_UP.objectionableSubstring,
        }),
      };
    } catch (error) {
      return {
        taskId: 'follow-up',
        model: modelSpec,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
        steps: 0,
      };
    }
  },
};

/**
 * The incremental notes path: one structured-output call, no tools, latency matters.
 *
 * Scored on the protocol (return exactly the `T` ids, skip the `C` ids) because that failure
 * shows up live as missing or duplicated lines in front of the congregation.
 */
const notesTask: BenchTask = {
  id: 'notes-block',
  title: `Translate a block of live notes into ${NOTES_LANGUAGE}`,
  probe:
    'Structured-output reliability and latency on the hot path: return exactly the segments ' +
    'marked "T", skip the "C" context segments, keep the ids.',
  run: async ({ model, modelSpec, trace }) => {
    const started = Date.now();
    try {
      const result = await translateBlock(model, NOTES_TODO, NOTES_LANGUAGE, trace);
      return {
        taskId: 'notes-block',
        model: modelSpec,
        ok: true,
        durationMs: Date.now() - started,
        steps: result.usage.callCount,
        usage: result.usage,
        costUsd: costFromMetadata([result.providerMetadata]),
        translations: { [NOTES_LANGUAGE]: result.blocks },
        score: scoreNotes({
          chunks: NOTES_TODO.chunks,
          isTranslationNeeded: NOTES_TODO.isTranslationNeeded,
          returnedIds: result.returnedIds,
          blocks: result.blocks,
        }),
      };
    } catch (error) {
      return {
        taskId: 'notes-block',
        model: modelSpec,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
        steps: 0,
      };
    }
  },
};

/** Every task the bench can run, in report order. */
export const TASKS: BenchTask[] = [...BENCH_ITEMS.map(draftTask), followUpTask, notesTask];

/** Look up tasks by id or by prefix (`draft` selects every draft task). */
export function selectTasks(selectors: string[]): BenchTask[] {
  if (selectors.length === 0) return TASKS;
  return TASKS.filter((task) =>
    selectors.some((selector) => task.id === selector || task.id.startsWith(`${selector}:`)),
  );
}
