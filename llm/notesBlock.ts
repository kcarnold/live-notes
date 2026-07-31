/**
 * The incremental notes translation path, on the AI SDK.
 *
 * Port of `translateBlock` from [nlp.ts](../nlp.ts) — the hot path that translates the
 * speaker's notes chunk by chunk as they are typed. Its demands are different from the slide
 * agent's: no tools, one round trip, strict JSON out, and latency matters because a viewer is
 * waiting on it. So it is worth measuring separately from the agent, and worth being able to
 * point at a different (cheaper, faster) model than the one drafting slides.
 *
 * The prompt and the response schema are imported, not restated — see the note on
 * `NOTES_BLOCK_RESPONSE_SCHEMA` in nlp.ts.
 */
import { Output, generateText, jsonSchema, type LanguageModel } from 'ai';
import {
  NOTES_BLOCK_RESPONSE_SCHEMA,
  buildNotesBlockPrompt,
  type TranslationBlockResult,
  type TranslationTodo,
} from '../nlp.ts';
import { geminiSchemaToJsonSchema } from './schema.ts';
import { toTokenUsage } from './slideAgent.ts';
import type { TokenUsage } from '../nlp.ts';

/** Shape the model is asked for; validated by the AI SDK against the schema below. */
interface NotesBlockOutput {
  segments: Array<{ segmentId: number; translation: string }>;
}

export interface NotesBlockResult {
  /** One entry per segment the model translated, in the order it returned them. */
  blocks: TranslationBlockResult[];
  /** Segment ids the model returned, before any filtering — used to score id fidelity. */
  returnedIds: number[];
  usage: TokenUsage;
  providerMetadata: Record<string, unknown>;
}

/**
 * Translate one block of notes chunks into `language`.
 *
 * Out-of-range segment ids are dropped rather than throwing: a model that invents an id has
 * failed the protocol, but on the live path the right response is to keep the segments that
 * did come back and let the cache miss on the rest. `returnedIds` preserves what was actually
 * returned so the bench can still score the failure.
 */
export async function translateBlock(
  model: LanguageModel,
  todo: TranslationTodo,
  language: string,
): Promise<NotesBlockResult> {
  const result = await generateText({
    model,
    prompt: buildNotesBlockPrompt(todo, language),
    output: Output.object({
      schema: jsonSchema<NotesBlockOutput>(geminiSchemaToJsonSchema(NOTES_BLOCK_RESPONSE_SCHEMA)),
    }),
  });

  const segments = result.output?.segments ?? [];
  const returnedIds = segments.map((segment) => segment.segmentId);
  const blocks = segments
    .filter((segment) => segment.segmentId >= 0 && segment.segmentId < todo.chunks.length)
    .map((segment) => ({
      sourceText: todo.chunks[segment.segmentId],
      translatedText: segment.translation,
      language,
    }));

  return {
    blocks,
    returnedIds,
    usage: { ...toTokenUsage(result.usage), callCount: result.steps.length },
    providerMetadata: (result.providerMetadata ?? {}) as Record<string, unknown>,
  };
}
