/**
 * The slide-translation agent, on the AI SDK.
 *
 * This is a second implementation of `runSlideTranslationAgent` / `draftItemTranslations`
 * from [nlp.ts](../nlp.ts) — same tools, same prompts, same working-copy semantics, same
 * result shape — running through `generateText` so it can be pointed at any provider
 * (see [modelSpec.ts](./modelSpec.ts)).
 *
 * It is a port, not a rewrite. Everything that defines *what the agent does* is imported
 * from `nlp.ts`: the three tool declarations (whose descriptions are load-bearing prompt
 * text), the prompt builder, and the pure working-copy functions that apply
 * `set_translations` / `revise_translation`. What lives here is only *how the loop is
 * driven*. That split is what makes the side-by-side bench meaningful: a difference in the
 * results is a difference between models, not between two hand-written harnesses that drifted.
 *
 * The conversation is stored as Gemini `Content[]` on both paths — see
 * [messages.ts](./messages.ts) for why, and for what is lost in the conversion.
 */
import { generateText, jsonSchema, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import type { Content } from '@google/genai';
import {
  BIBLE_LOOKUP_TOOL,
  MAX_AGENT_ROUNDS,
  REVISE_TRANSLATION_TOOL,
  SET_TRANSLATIONS_TOOL,
  applyReviseTranslation,
  applySetTranslations,
  buildSlideTranslationPrompt,
  collectChanged,
  emptyUsage,
  workingFor,
  type DraftItemTarget,
  type TokenUsage,
  type TranslationBlockResult,
  type WorkingTranslations,
} from '../nlp.ts';
import { BIBLE_TRANSLATIONS, lookupBiblePassage, type BibleLookupArgs, type BibleToolCall } from '../bible.ts';
import { geminiToolToNeutral } from './schema.ts';
import { toGeminiContents, toModelMessages } from './messages.ts';

/** Result of one agent run, mirroring `SlideAgentRunResult` on the Gemini path. */
export interface SlideAgentRunResult {
  /** Every slide the run changed, per language (accumulated across all tool calls). */
  translations: Record<string, TranslationBlockResult[]>;
  /** The full updated conversation, in the stored Gemini format. */
  messages: Content[];
  /** Whether the model called `set_translations` during this run. */
  setTranslationsCalled: boolean;
  /** Token usage summed across this run's model calls. */
  usage: TokenUsage;
  /** Per-step provider metadata (OpenRouter puts its cost accounting here). */
  providerMetadata: Array<Record<string, unknown>>;
  /** How many model round-trips the run took. */
  steps: number;
}

export interface SlideAgentRunParams {
  model: LanguageModel;
  sourceSlides: string[];
  /** Conversation so far, in the stored Gemini format. Not mutated. */
  messages: Content[];
  bibleLanguages: string[];
  /** Existing per-language translations, index-aligned with `sourceSlides`. */
  currentTranslations?: Record<string, (string | null | undefined)[]>;
  onToolCall?: (call: BibleToolCall) => void;
  /** Cap on model round-trips. Defaults to the Gemini path's `MAX_AGENT_ROUNDS`. */
  maxSteps?: number;
}

/**
 * Fold an AI SDK `usage` object into our `TokenUsage` shape.
 *
 * `cachedContentTokenCount` maps to `inputTokenDetails.cacheReadTokens`, which is the
 * provider-neutral name for the same thing Gemini calls cached content — the number we watch
 * to tell whether a resumed conversation is re-paying for its prefix every round. Not every
 * provider reports it; absent is recorded as 0, the same as on the Gemini path.
 *
 * `callCount` is not incremented here: the AI SDK reports usage already summed across the
 * steps of one `generateText` call, so the caller adds the step count separately.
 */
export function toTokenUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
}): Omit<TokenUsage, 'callCount'> {
  return {
    promptTokenCount: usage.inputTokens ?? 0,
    cachedContentTokenCount: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    candidatesTokenCount: usage.outputTokens ?? 0,
    thoughtsTokenCount: usage.outputTokenDetails?.reasoningTokens ?? 0,
    totalTokenCount: usage.totalTokens ?? 0,
  };
}

/**
 * Build the AI SDK tool set.
 *
 * The tools close over the run's mutable working copy, which is how a `set_translations`
 * call in step 1 and a `revise_translation` in step 3 compose into one coherent result —
 * exactly as on the Gemini path, where the same functions are applied to the same map.
 *
 * `lookup_bible_passage` is only offered when there is at least one language we can actually
 * fetch canonical Scripture for; offering a tool that always fails invites the model to burn
 * rounds on it.
 */
function buildTools(params: {
  sourceSlides: string[];
  working: WorkingTranslations;
  changed: Map<string, Set<number>>;
  bibleLanguages: string[];
  onToolCall?: (call: BibleToolCall) => void;
  onSetTranslations: () => void;
}): ToolSet {
  const { sourceSlides, working, changed, bibleLanguages, onToolCall, onSetTranslations } = params;

  const declare = (declaration: typeof SET_TRANSLATIONS_TOOL) => {
    const neutral = geminiToolToNeutral(declaration);
    return { description: neutral.description, inputSchema: jsonSchema(neutral.inputSchema) };
  };

  const tools: ToolSet = {
    [SET_TRANSLATIONS_TOOL.name!]: tool({
      ...declare(SET_TRANSLATIONS_TOOL),
      execute: async (input) => {
        applySetTranslations(input as Record<string, unknown>, sourceSlides, working, changed);
        onSetTranslations();
        return { ok: true };
      },
    }),
    [REVISE_TRANSLATION_TOOL.name!]: tool({
      ...declare(REVISE_TRANSLATION_TOOL),
      execute: async (input) =>
        applyReviseTranslation(input as Record<string, unknown>, sourceSlides, working, changed),
    }),
  };

  if (bibleLanguages.length > 0) {
    tools[BIBLE_LOOKUP_TOOL.name!] = tool({
      ...declare(BIBLE_LOOKUP_TOOL),
      execute: async (input) => {
        const args = (input ?? {}) as Partial<BibleLookupArgs>;
        if (!args.book || typeof args.chapter !== 'number') {
          return { error: 'book and chapter are required' };
        }
        const result = await lookupBiblePassage(
          {
            book: args.book,
            chapter: args.chapter,
            startVerse: args.startVerse,
            endVerse: args.endVerse,
          },
          bibleLanguages,
        );
        onToolCall?.(result.call);
        return result.call.ok
          ? { reference: result.reference, passages: result.passages }
          : { reference: result.reference, error: `No canonical text found for ${result.reference}` };
      },
    });
  }

  return tools;
}

/**
 * Drive the agent loop to completion on any provider.
 *
 * Unlike the hand-rolled Gemini loop this delegates the round-tripping to the AI SDK
 * (`stopWhen` on step count, tools executed automatically), so the differences that show up
 * between providers are in tool *choice* and output quality rather than in loop mechanics.
 */
export async function runSlideTranslationAgent(params: SlideAgentRunParams): Promise<SlideAgentRunResult> {
  const { model, sourceSlides, messages, bibleLanguages, currentTranslations, onToolCall } = params;
  const maxSteps = params.maxSteps ?? MAX_AGENT_ROUNDS;

  // Seeded with what already exists so an edit-only run has something to edit; `changed`
  // stays empty until the model actually writes, so seeds are never reported as updates.
  const working: WorkingTranslations = new Map();
  const changed = new Map<string, Set<number>>();
  for (const [language, perSlide] of Object.entries(currentTranslations ?? {})) {
    perSlide.forEach((text, segmentId) => {
      if (typeof text === 'string' && text !== '' && segmentId < sourceSlides.length) {
        workingFor(working, language).set(segmentId, text);
      }
    });
  }

  let setTranslationsCalled = false;
  const tools = buildTools({
    sourceSlides,
    working,
    changed,
    bibleLanguages,
    onToolCall,
    onSetTranslations: () => {
      setTranslationsCalled = true;
    },
  });

  const inputMessages: ModelMessage[] = toModelMessages(messages);
  const result = await generateText({
    model,
    messages: inputMessages,
    tools,
    stopWhen: ({ steps }) => steps.length >= maxSteps,
  });

  let usage = emptyUsage();
  usage = { ...usage, ...toTokenUsage(result.usage), callCount: result.steps.length };

  return {
    translations: collectChanged(working, changed, sourceSlides),
    messages: [...messages, ...toGeminiContents(result.responseMessages)],
    setTranslationsCalled,
    usage,
    providerMetadata: result.steps.map((step) => (step.providerMetadata ?? {}) as Record<string, unknown>),
    steps: result.steps.length,
  };
}

export interface DraftItemParams {
  model: LanguageModel;
  sourceSlides: string[];
  targets: DraftItemTarget[];
  referenceText?: string;
  existingTranslation?: string;
  generalContext?: string;
  itemTitle?: string;
  maxSteps?: number;
  onToolCall?: (call: BibleToolCall) => void;
}

/**
 * Translate a whole item into several languages in one agent run, on any provider.
 *
 * Mirrors `draftItemTranslations` in nlp.ts, including which languages get Bible grounding,
 * but returns the run result whole rather than through callbacks — the bench wants the
 * conversation, the usage, and the provider metadata, and a caller that only wants the
 * translations can take `.translations`.
 */
export async function draftItemTranslations(params: DraftItemParams): Promise<SlideAgentRunResult> {
  const { model, sourceSlides, targets, referenceText, existingTranslation, generalContext, maxSteps, onToolCall } =
    params;
  const itemTitle = params.itemTitle?.trim();
  const bibleLanguages = targets
    .map((target) => target.language)
    .filter((language) => BIBLE_TRANSLATIONS[language]);

  const prompt = buildSlideTranslationPrompt({
    sourceSlides,
    targets,
    referenceText,
    existingTranslation,
    generalContext,
    itemTitle,
    bibleLanguages,
  });

  return runSlideTranslationAgent({
    model,
    sourceSlides,
    messages: [{ role: 'user', parts: [{ text: prompt }] }],
    bibleLanguages,
    maxSteps,
    onToolCall,
  });
}
