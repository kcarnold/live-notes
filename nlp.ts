import { FunctionCallingConfigMode, Type, type Content, type FunctionDeclaration, type Part } from '@google/genai'; // for types
import { Gemini as GoogleGenAI } from '@posthog/ai/gemini';
import { PostHog } from 'posthog-node';
import { BIBLE_TRANSLATIONS, lookupBiblePassage, type BibleLookupArgs, type BibleToolCall } from './bible.ts';
import { unescapeLiteralEscapes } from './src/slideTranslation.ts';

export class GeminiProvider {
  apiClient: GoogleGenAI;
  defaultModel: string;
  maxTokens: number;
  

  constructor({ apiKey, defaultModel, maxTokens, posthog }: { apiKey: string, defaultModel: string, maxTokens: number, posthog: PostHog }) {
    this.apiClient = new GoogleGenAI({
      apiKey: apiKey,
      posthog: posthog
    });
    this.defaultModel = defaultModel;
    this.maxTokens = maxTokens;
  }
}

export type TranslationTodo = {
    chunks: string[];
    offset: number;
    isTranslationNeeded: boolean[];
    translatedContext: string;
}

export type TranslationBlockResult = {
    sourceText: string;
    translatedText: string;
}

/**
 * PostHog LLM-observability tags for a run. Passed straight through the `@posthog/ai`
 * GoogleGenAI wrapper, which turns each `generateContent` call into an `$ai_generation`
 * event. `traceId` is the important one: it groups every generation from one conversation
 * (initial draft + every follow-up round) into a single PostHog trace. Without it the
 * wrapper emits ungrouped events under a random distinct id — which is exactly why agent
 * messages from the same conversation weren't grouping.
 */
export interface AgentObservability {
    /** Stable id for whoever/whatever is driving the conversation (we use the day's docId). */
    distinctId?: string;
    /** Groups all generations from one conversation into a single trace (the conversation id). */
    traceId?: string;
    /** Extra properties attached to every generation event in this run. */
    properties?: Record<string, unknown>;
}

/** The subset of `usageMetadata` fields we sum; missing on faked/tool-only responses. */
type ResponseUsage = {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
};

/**
 * Token usage summed across the model calls in an agent run (and across runs, when a
 * conversation is resumed). Surfaced so cost is visible and — via `cachedContentTokenCount`
 * — so we can tell whether Gemini's context cache is actually serving the re-sent prefix.
 * A run of several rounds with `cachedContentTokenCount` stuck at 0 means we're paying full
 * price for the whole prompt every round.
 */
export interface TokenUsage {
    promptTokenCount: number;
    /** Portion of `promptTokenCount` served from the context cache (implicit or explicit). */
    cachedContentTokenCount: number;
    candidatesTokenCount: number;
    thoughtsTokenCount: number;
    totalTokenCount: number;
    /** How many model calls contributed to these totals. */
    callCount: number;
}

export const emptyUsage = (): TokenUsage => ({
    promptTokenCount: 0,
    cachedContentTokenCount: 0,
    candidatesTokenCount: 0,
    thoughtsTokenCount: 0,
    totalTokenCount: 0,
    callCount: 0,
});

/** Fold one response's `usageMetadata` into a running total (tolerant of missing fields). */
export const addUsage = (total: TokenUsage, meta: ResponseUsage | undefined): TokenUsage => ({
    promptTokenCount: total.promptTokenCount + (meta?.promptTokenCount ?? 0),
    cachedContentTokenCount: total.cachedContentTokenCount + (meta?.cachedContentTokenCount ?? 0),
    candidatesTokenCount: total.candidatesTokenCount + (meta?.candidatesTokenCount ?? 0),
    thoughtsTokenCount: total.thoughtsTokenCount + (meta?.thoughtsTokenCount ?? 0),
    totalTokenCount: total.totalTokenCount + (meta?.totalTokenCount ?? 0),
    callCount: total.callCount + 1,
});

/** Merge two usage totals (e.g. a stored conversation total plus a fresh follow-up run). */
export const mergeUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
    promptTokenCount: a.promptTokenCount + b.promptTokenCount,
    cachedContentTokenCount: a.cachedContentTokenCount + b.cachedContentTokenCount,
    candidatesTokenCount: a.candidatesTokenCount + b.candidatesTokenCount,
    thoughtsTokenCount: a.thoughtsTokenCount + b.thoughtsTokenCount,
    totalTokenCount: a.totalTokenCount + b.totalTokenCount,
    callCount: a.callCount + b.callCount,
});

/** Build the `@posthog/ai` per-call tags from an observability object (empty when unset). */
const posthogTags = (obs?: AgentObservability) =>
    obs ? { posthogDistinctId: obs.distinctId, posthogTraceId: obs.traceId, posthogProperties: obs.properties } : {};

/**
 * Render slides as tagged plain-text blocks — `<slide id="0">…</slide>` — rather than a JSON
 * array.
 *
 * Line breaks inside a slide are meaningful content (song lines, responsive readings), and
 * JSON encoding turns them into `\n` escape sequences that the model then copies into its own
 * output. Tagged blocks keep every newline a real newline in both directions.
 */
const renderSlideBlocks = (slides: string[], tag = 'slide'): string =>
    slides.map((text, index) => `<${tag} id="${index}">\n${text.trim()}\n</${tag}>`).join('\n');

/** Render the per-language targets (which ids to translate + style context) as text blocks. */
const renderTargetBlocks = (targets: DraftItemTarget[], slideCount: number): string =>
    targets
        .map((target) => {
            const ids = Array.from({ length: slideCount }, (_, index) => index).filter(
                (index) => target.isTranslationNeeded[index],
            );
            const context = target.context.trim();
            const contextBlock = context ? `\n<context>\n${context}\n</context>` : '';
            return `<target language="${target.language}">\ntranslate slide ids: ${
                ids.length > 0 ? ids.join(', ') : '(none)'
            }${contextBlock}\n</target>`;
        })
        .join('\n');

export const translateBlock = async (provider: GeminiProvider, todo: TranslationTodo, language: string): Promise<TranslationBlockResult[]> => {
    const config = {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        required: ["segments"],
        properties: {
          segments: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: ["segmentId", "translation"],
              properties: {
                segmentId: {
                  type: Type.INTEGER,
                },
                translation: {
                  type: Type.STRING,
                },
              },
            },
          },
        },
      },
    };

    type OutputSegment = {
        segmentId: number;
        translation: string;
    };

    const inputDocument = JSON.stringify(
        todo.chunks.map((chunk, index) => ({
            segmentId: index,
            status: todo.isTranslationNeeded[index] ? 'T' : 'C',
            text: chunk.trim()
        }))
    );
    console.log('Input document:', inputDocument);
        
    const contents = [
      {
        role: 'user',
        parts: [
          {
            text: `
We are translating text into ${language}.

Here is some text that has already been translated, provided for reference for style and terminology. The instructions and text to be translated will follow after this context.

<already_translated>
${todo.translatedContext}
</already_translated>

The input document is a JSON array of segments:
- "segmentId": the segment id
- "status": "C" (context, no translation needed) or "T" (needs translation)
- "text": the content to translate

Respond with only JSON:
{"segments": [{
  "segmentId": the segment id
  "translation": the text, in ${language}
}]}

Construct this response as follows:
- For each segment with status "T", append a segment with the given segmentId and translate the text into the target language.
- Skip any segments with status "C" (these are provided for context only). Do not include any segments with status "C" in your response.

Segment ids must match those in the input document.

<input_document>
${inputDocument}
</input_document>
  `,
          },
        ],
      },
    ];
  
    const response = await provider.apiClient.models.generateContent({
      model: provider.defaultModel,
      config,
      contents,
    });
    console.dir(response, { depth: null });
    console.log(response.usageMetadata);
    const jsonResponse = JSON.parse(response.text || '');
    const segments = jsonResponse.segments as Array<{ segmentId: number; translation: string }>;
    const translatedBlocks: TranslationBlockResult[] = segments.map((segment: OutputSegment) => {
        const segmentNumber = segment.segmentId;
        const translatedText = segment.translation;
        const sourceText = todo.chunks[segmentNumber];
        return { sourceText, translatedText, language };
    });
    return translatedBlocks;
}

export type DraftItemTarget = {
    language: string;
    /** Per source slide: does this slide still need translating into this language? */
    isTranslationNeeded: boolean[];
    /** Already-reviewed translations in this language, joined for style/terminology context. */
    context: string;
};

/** Function declaration the model uses to fetch canonical Scripture wording. */
const BIBLE_LOOKUP_TOOL: FunctionDeclaration = {
    name: 'lookup_bible_passage',
    description:
        'Look up the canonical wording of a Bible passage in the target languages. Call this ' +
        'whenever a slide is or quotes Scripture — an explicit Bible reading, a quoted verse, ' +
        'or an adaptation such as "based on Psalm 23" — so you can base the translation on the ' +
        'published text rather than translating from scratch. Returns the passage in each ' +
        'available target language.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            book: {
                type: Type.STRING,
                description:
                    'USFM book code (uppercase 3 chars), e.g. GEN, PSA, ISA, MAT, JHN, ROM, 1CO, REV.',
            },
            chapter: { type: Type.INTEGER, description: 'Chapter number.' },
            startVerse: {
                type: Type.INTEGER,
                description: 'First verse of the range. Omit to fetch the whole chapter.',
            },
            endVerse: {
                type: Type.INTEGER,
                description: 'Last verse of the range. Omit for a single verse (defaults to startVerse).',
            },
        },
        required: ['book', 'chapter'],
    },
};

/**
 * The line-break policy, stated once and shared by every prompt that needs it (drafting and
 * the seeded review conversation). Tool parameters deliberately do NOT restate it — see
 * `LINE_BREAK_FIELD_NOTE` — so there is one place to edit when the policy changes.
 */
const LINE_BREAK_POLICY = `
Line breaks within a slide:

Write real line breaks in your translations. Never write the two characters backslash-n —
that is not a line break, and it shows up on the projected slide exactly as typed.

Whether to reproduce the source's line breaks is a judgement call that depends on what the
slide is. Decide per slide from its content:
- Songs, hymns, poetry, and responsive readings: the line structure is part of the content
  — it carries the meter, the call-and-response turns, the poetic parallelism. Keep one
  output line per source line, so the translation lines up with the original line for line.
- Prose — congregational readings, prayers, announcements, narrative Scripture set as
  paragraphs: the breaks are there only to make the English sit nicely on the English
  slide. Ignore them. Write the translation as unbroken prose and let it wrap on its own;
  the viewer reflows text to its own screen size, so any break you write is a hard break
  that survives where it probably does not belong.

When a slide could be either, keep the source's line structure.
`;

/**
 * The line-break note attached to tool parameters that carry slide text. Covers only the
 * encoding of the field itself; the editorial policy above is not repeated here, because a
 * policy in two places is a policy that gets edited in one.
 */
const LINE_BREAK_FIELD_NOTE =
    'Use real line breaks — never the two characters backslash-n, which reach the slide ' +
    'exactly as typed. Whether to keep the source slide\'s breaks at all is covered by the ' +
    'line-break guidance in the conversation.';

/** Function declaration the model uses to record the finished translations. */
const SET_TRANSLATIONS_TOOL: FunctionDeclaration = {
    name: 'set_translations',
    description:
        'Record the finished translations. Call this once the translations are ready, with ' +
        'one entry per target language and exactly one segment per requested slide id. You ' +
        'may call it again to revise (e.g. after reviewer feedback) — when revising, include ' +
        'only the languages and segments that actually change; anything you leave out keeps ' +
        'its current text. For a small fix inside one slide, prefer revise_translation.',
    parameters: {
        type: Type.OBJECT,
        required: ['languages'],
        properties: {
            languages: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    required: ['language', 'segments'],
                    properties: {
                        language: { type: Type.STRING },
                        segments: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                required: ['segmentId', 'translation'],
                                properties: {
                                    segmentId: {
                                        type: Type.INTEGER,
                                        description: 'The id of the source slide this translates.',
                                    },
                                    translation: {
                                        type: Type.STRING,
                                        description: `The full translated text of this slide. ${LINE_BREAK_FIELD_NOTE}`,
                                    },
                                    note: {
                                        type: Type.STRING,
                                        description:
                                            'Optional caveat for the reviewer. Omit unless there is ' +
                                            'a genuine ambiguity or judgement call worth flagging.',
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
};

/**
 * Function declaration for targeted, `str_replace`-style edits to one recorded translation.
 *
 * Without this the only way to fix a single word is to re-send that slide's entire text
 * through `set_translations`, which costs output tokens and risks the model quietly
 * rewriting the parts the reviewer already approved.
 */
const REVISE_TRANSLATION_TOOL: FunctionDeclaration = {
    name: 'revise_translation',
    description:
        'Make a targeted edit to one slide\'s translation in one language: replace an exact ' +
        'substring of its current text. Prefer this over set_translations whenever the change ' +
        'is small (a word, a line, punctuation) — everything else in the slide, and every other ' +
        'slide, is left untouched. "find" must occur EXACTLY ONCE in the current text; if it is ' +
        'missing or appears more than once the call fails and changes nothing, so include ' +
        'enough surrounding text to be unique. Returns the slide\'s new full text.',
    parameters: {
        type: Type.OBJECT,
        required: ['language', 'segmentId', 'find', 'replace'],
        properties: {
            language: {
                type: Type.STRING,
                description: 'Target language of the translation to edit, exactly as named in the targets.',
            },
            segmentId: {
                type: Type.INTEGER,
                description: 'The id of the source slide whose translation is being edited.',
            },
            find: {
                type: Type.STRING,
                description:
                    'The exact substring of the current translation to replace, copied verbatim ' +
                    'including any line breaks it spans. Must occur exactly once.',
            },
            replace: {
                type: Type.STRING,
                description: `The replacement text; may be empty to delete. ${LINE_BREAK_FIELD_NOTE}`,
            },
        },
    },
};

/**
 * Safety cap on agent turns (Bible lookups + set_translations + targeted revisions + a
 * closing note). Each `revise_translation` costs a round, so this allows a handful of
 * targeted fixes on top of the lookups and the initial draft.
 */
const MAX_AGENT_ROUNDS = 12;

/**
 * The agent's working copy of the translations: language → slide id → current text.
 *
 * `set_translations` writes whole slides into it and `revise_translation` edits them in
 * place, so a run can mix a full draft with follow-up touch-ups and still report one
 * coherent result. Seeded from `currentTranslations` on a resumed conversation so a targeted
 * edit works without the model re-sending everything first.
 */
type WorkingTranslations = Map<string, Map<number, string>>;

const workingFor = (working: WorkingTranslations, language: string): Map<number, string> => {
    let perSlide = working.get(language);
    if (!perSlide) {
        perSlide = new Map<number, string>();
        working.set(language, perSlide);
    }
    return perSlide;
};

/** Apply a `set_translations` call to the working copy; returns the ids it touched. */
const applySetTranslations = (
    args: Record<string, unknown> | undefined,
    sourceSlides: string[],
    working: WorkingTranslations,
    changed: Map<string, Set<number>>,
): void => {
    const languageResults = ((args?.languages as unknown[]) ?? []) as Array<{
        language: string;
        segments: Array<{ segmentId: number; translation: string; note?: string }>;
    }>;
    for (const result of languageResults) {
        const language = result.language;
        if (!language) continue;
        for (const segment of result.segments ?? []) {
            const segmentId = segment.segmentId;
            if (!(segmentId >= 0 && segmentId < sourceSlides.length)) continue;
            workingFor(working, language).set(segmentId, unescapeLiteralEscapes(segment.translation ?? ''));
            if (!changed.has(language)) changed.set(language, new Set());
            changed.get(language)?.add(segmentId);
        }
    }
};

/**
 * Apply a `revise_translation` call to the working copy.
 *
 * Deliberately strict, in the same spirit as a file-editing `str_replace`: a `find` that is
 * absent or ambiguous changes nothing and reports why, so the model retries with more
 * context instead of silently editing the wrong line.
 */
const applyReviseTranslation = (
    args: Record<string, unknown> | undefined,
    sourceSlides: string[],
    working: WorkingTranslations,
    changed: Map<string, Set<number>>,
): Record<string, unknown> => {
    const language = typeof args?.language === 'string' ? args.language : '';
    const segmentId = typeof args?.segmentId === 'number' ? args.segmentId : NaN;
    const find = typeof args?.find === 'string' ? unescapeLiteralEscapes(args.find) : '';
    const replace = typeof args?.replace === 'string' ? unescapeLiteralEscapes(args.replace) : '';

    if (!language) return { error: 'language is required' };
    if (!Number.isInteger(segmentId) || segmentId < 0 || segmentId >= sourceSlides.length) {
        return { error: `segmentId must be an integer between 0 and ${sourceSlides.length - 1}` };
    }
    if (find === '') return { error: 'find must be a non-empty substring of the current translation' };

    const perSlide = working.get(language);
    const current = perSlide?.get(segmentId);
    if (current === undefined) {
        return {
            error:
                `No translation recorded yet for slide ${segmentId} in ${language}. ` +
                'Use set_translations to write it first.',
        };
    }

    const first = current.indexOf(find);
    if (first === -1) {
        return { error: `"find" does not appear in the current ${language} text for slide ${segmentId}.`, currentText: current };
    }
    if (current.indexOf(find, first + 1) !== -1) {
        return {
            error:
                `"find" appears more than once in the current ${language} text for slide ` +
                `${segmentId}. Include more surrounding text so it matches exactly once.`,
            currentText: current,
        };
    }

    const updated = current.slice(0, first) + replace + current.slice(first + find.length);
    workingFor(working, language).set(segmentId, updated);
    if (!changed.has(language)) changed.set(language, new Set());
    changed.get(language)?.add(segmentId);
    return { ok: true, language, segmentId, text: updated };
};

/** Collect the slides the run changed, per language, from the working copy. */
const collectChanged = (
    working: WorkingTranslations,
    changed: Map<string, Set<number>>,
    sourceSlides: string[],
): Record<string, TranslationBlockResult[]> => {
    const out: Record<string, TranslationBlockResult[]> = {};
    for (const [language, ids] of changed) {
        const perSlide = working.get(language);
        out[language] = [...ids]
            .sort((a, b) => a - b)
            .map((segmentId) => ({
                sourceText: sourceSlides[segmentId],
                translatedText: perSlide?.get(segmentId) ?? '',
                language,
            }));
    }
    return out;
};

export type SlideAgentRunResult = {
    /**
     * Every slide the run changed, per language — the accumulated effect of all
     * `set_translations` and `revise_translation` calls, not just the last one. Slides the
     * run never touched are absent, so a targeted edit reports only what it edited.
     */
    translations: Record<string, TranslationBlockResult[]>;
    /** The full updated conversation (raw Gemini Content, replay-safe — keep verbatim). */
    messages: Content[];
    /** Whether the model called `set_translations` during this run. */
    setTranslationsCalled: boolean;
    /** Token usage summed across this run's model calls (incl. cache hits). */
    usage: TokenUsage;
};

/**
 * Drive the slide-translation agent loop over a conversation until the model ends its turn.
 *
 * The model has three tools: `lookup_bible_passage` (grounds Scripture slides in the
 * published text), `set_translations` (records whole slides) and `revise_translation` (a
 * `str_replace`-style targeted edit to one recorded slide). All run in one loop — and,
 * unlike the old two-call design, `set_translations` is NOT a hard stop: it is executed like
 * any tool and the model is allowed to end its turn naturally (a turn with no function
 * calls), so it can add a closing note or ask a clarifying question instead of translating.
 *
 * Translations accumulate in a working copy across the run, so a draft followed by a
 * targeted fix reports the final text once. `messages` is mutated in place and returned;
 * pass a continuing history plus `currentTranslations` to resume from reviewer feedback.
 * `onToolCall` reports each Bible lookup for observability.
 */
export const runSlideTranslationAgent = async (
    provider: GeminiProvider,
    params: {
        sourceSlides: string[];
        messages: Content[];
        model?: string;
        bibleLanguages: string[];
        /**
         * Translations that already exist for these slides (language → per-slide text,
         * index-aligned with `sourceSlides`). Seeds the working copy so `revise_translation`
         * can edit them without the model re-sending them first. Entries that are empty or
         * missing are treated as "not yet translated".
         */
        currentTranslations?: Record<string, (string | null | undefined)[]>;
        onToolCall?: (call: BibleToolCall) => void;
        /** PostHog trace/distinct-id tags so every round groups under one conversation. */
        observability?: AgentObservability;
    },
): Promise<SlideAgentRunResult> => {
    const { sourceSlides, messages, bibleLanguages, currentTranslations, onToolCall, observability } = params;
    const model = params.model ?? provider.defaultModel;

    const functionDeclarations: FunctionDeclaration[] = [SET_TRANSLATIONS_TOOL, REVISE_TRANSLATION_TOOL];
    if (bibleLanguages.length > 0) functionDeclarations.unshift(BIBLE_LOOKUP_TOOL);
    const tools = [{ functionDeclarations }];

    // Seeded with what already exists, so an edit-only run has something to edit. `changed`
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
    let usage = emptyUsage();

    for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
        const response = await provider.apiClient.models.generateContent({
            model,
            config: {
                tools,
                toolConfig: {
                    functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
                },
            },
            contents: messages,
            ...posthogTags(observability),
        });
        usage = addUsage(usage, response.usageMetadata);
        const calls = response.functionCalls ?? [];
        const modelContent = response.candidates?.[0]?.content;
        // Keep the model turn verbatim (incl. any thought signatures) so a later resume
        // replays the agent's reasoning faithfully.
        if (modelContent) messages.push(modelContent);
        if (calls.length === 0) break; // model ended its turn

        const responseParts: Part[] = [];
        for (const call of calls) {
            if (call.name === SET_TRANSLATIONS_TOOL.name) {
                applySetTranslations(
                    call.args as Record<string, unknown> | undefined,
                    sourceSlides,
                    working,
                    changed,
                );
                setTranslationsCalled = true;
                responseParts.push({
                    functionResponse: { name: call.name, response: { ok: true } },
                });
            } else if (call.name === REVISE_TRANSLATION_TOOL.name) {
                responseParts.push({
                    functionResponse: {
                        name: call.name,
                        response: applyReviseTranslation(
                            call.args as Record<string, unknown> | undefined,
                            sourceSlides,
                            working,
                            changed,
                        ),
                    },
                });
            } else if (call.name === BIBLE_LOOKUP_TOOL.name) {
                const args = (call.args ?? {}) as Partial<BibleLookupArgs>;
                let responsePayload: Record<string, unknown>;
                if (!args.book || typeof args.chapter !== 'number') {
                    responsePayload = { error: 'book and chapter are required' };
                } else {
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
                    responsePayload = result.call.ok
                        ? { reference: result.reference, passages: result.passages }
                        : { reference: result.reference, error: `No canonical text found for ${result.reference}` };
                }
                responseParts.push({
                    functionResponse: { name: call.name, response: responsePayload },
                });
            } else {
                responseParts.push({
                    functionResponse: { name: call.name ?? 'unknown', response: { error: 'unknown tool' } },
                });
            }
        }
        messages.push({ role: 'user', parts: responseParts });
    }

    return {
        translations: collectChanged(working, changed, sourceSlides),
        messages,
        setTranslationsCalled,
        usage,
    };
};

/**
 * Build the opening user prompt for the slide-translation agent: the numbered source slides,
 * the target languages (each with which slides still need translating and any reviewed
 * translations as style/terminology context), an optional multilingual `referenceText` dump,
 * Bible-grounding instructions when any target language has a canonical translation, and the
 * instruction to record results via the `set_translations` tool.
 */
const buildSlideTranslationPrompt = (params: {
    sourceSlides: string[];
    targets: DraftItemTarget[];
    referenceText?: string;
    existingTranslation?: string;
    generalContext?: string;
    itemTitle?: string;
    bibleLanguages: string[];
}): string => {
    const { sourceSlides, targets, referenceText, existingTranslation, generalContext, itemTitle, bibleLanguages } = params;

    const contextSection = generalContext
        ? `
Context for these translations:
${generalContext}
`
        : '';

    const sourceDocument = renderSlideBlocks(sourceSlides);
    const targetsDocument = renderTargetBlocks(targets, sourceSlides.length);

    const referenceSection = referenceText
        ? `
The reference material below may contain prior translations of this same content. It can
mix several of the target languages and may be segmented differently from the source
slides, or not at all. For each target language, when the reference contains text in that
language, prefer and adapt its wording for the matching slides; otherwise ignore it.

<reference_material>
${referenceText}
</reference_material>
`
        : '';

    const existingTranslationSection = existingTranslation
        ? `
An existing translation for these slides is shown below (pulled from the presentation
software). It may itself be machine-generated and imperfect: keep its wording where it is
accurate and natural, but correct it where it is wrong, awkward, or mistranslated — do not
treat it as authoritative. It may be segmented differently from the source slides.

<existing_translation>
${existingTranslation}
</existing_translation>
`
        : '';

    const bibleSection = bibleLanguages.length > 0
        ? `
Canonical Scripture is available through lookup_bible_passage for: ${bibleLanguages.join(', ')}.
Look up every reference you recognize — the passage named in the item title above, and any
inline references — before recording the final translations, and base those slides on the
published wording, adapting only where the slide itself does (responsive readings, pronoun
changes, partial quotes).

Be reticent in adaptations: prefer direct quotes of the published text, and only adapt
when it is very clear that the slide itself has deliberately made an adaptation.
If in doubt, insert it literally first, then ask the reviewer if they want it adapted.

There will likely be interpretative decisions to make when translating. Make a
conservative first pass and ask follow-up questions.
`
        : '';

    const itemTitleSection = itemTitle
        ? `
This presentation item is titled "${itemTitle}". For a Bible reading the title is the
citation itself and is usually NOT repeated in the slide text, so treat it as the reference
for the passage on these slides.
`
        : '';

    const toolInstruction = `
Record this first pass with set_translations, covering every id listed for each language.
Do not reply with the translations as plain text — they reach the reviewer only through the
tool. Later rounds are different: change only what the reviewer raises. If something
genuinely needs their attention, write a short message or attach a per-segment "note" — but
keep quiet when there is nothing useful to say.
`;

    return `
You are translating presentation slides into several languages at once. A human reviewer
checks your work before the service and can send you follow-up requests.
${contextSection}${itemTitleSection}
Each source slide is given as its own block, with its id in the tag. The text inside a block
is verbatim, including its line breaks:
<source_slides>
${sourceDocument}
</source_slides>

Translate into the following target languages. For each language, "translate slide ids"
lists exactly which source slide ids to translate. Any <context> block holds already-approved
translations in that language, given only as a guide for style and terminology — it is
not something to translate.
<targets>
${targetsDocument}
</targets>
${LINE_BREAK_POLICY}${referenceSection}${existingTranslationSection}${bibleSection}${toolInstruction}`;
};

/**
 * Build the seed prompt stored for an item when every slide was already cached (so no agent
 * ran). It carries the general context, the slides, and the current per-language
 * translations so a later follow-up resumes with real context instead of replying blind —
 * without spending a model call up front.
 */
export const buildSeedConversationPrompt = (params: {
    slides: string[];
    translations: Record<string, { text: string }[]>;
    generalContext?: string;
}): string => {
    const { slides, translations, generalContext } = params;
    const contextSection = generalContext ? `\nContext for these translations:\n${generalContext}\n` : '';
    const slidesDocument = renderSlideBlocks(slides);
    const current = Object.entries(translations)
        .map(
            ([language, perSlide]) =>
                `<translations language="${language}">\n${renderSlideBlocks(
                    slides.map((_, index) => perSlide[index]?.text ?? ''),
                )}\n</translations>`,
        )
        .join('\n');
    return `
You are reviewing presentation slide translations into several languages.
${contextSection}
Each source slide is given as its own block, with its id in the tag. The text inside a block
is verbatim, including its line breaks:
<source_slides>
${slidesDocument}
</source_slides>

These slides are already translated as follows, with matching slide ids:
<current_translations>
${current}
</current_translations>

${LINE_BREAK_POLICY}
Await the reviewer's feedback, then apply it — revise_translation for a small fix,
set_translations when a whole slide needs rewriting. Only speak up when there is something
useful to say.`;
};

/**
 * Translate a whole item into several languages in one agent loop.
 *
 * The model receives the numbered source slides, the target languages (each with which
 * slides still need translating and any already-reviewed translations as context), and an
 * optional free-text `referenceText` dump that may hold prior translations in one or more of
 * the target languages. It may call `lookup_bible_passage` to ground Scripture, then records
 * results via `set_translations`. `onToolCall` reports each Bible lookup; `onConversation`
 * receives the full raw agent history (for server-side persistence + the review screen).
 *
 * Returns, per language, a `TranslationBlockResult` for each translated slide.
 */
export const draftItemTranslations = async (
    provider: GeminiProvider,
    params: {
        sourceSlides: string[];
        targets: DraftItemTarget[];
        referenceText?: string;
        /**
         * An existing translation pulled from the presentation software. Possibly itself
         * machine-generated, so framed cautiously — kept where good, corrected where not.
         */
        existingTranslation?: string;
        /** General context describing the setting and intent of the translations. */
        generalContext?: string;
        model?: string;
        /**
         * The presentation item's title. For Bible readings this is the citation itself
         * (e.g. "Psalm 23") and is often NOT repeated in the slide text — so it is the
         * model's only cue to look the passage up. Surfaced to the model as a hint.
         */
        itemTitle?: string;
        /** Called once per executed Bible lookup, for observability. */
        onToolCall?: (call: BibleToolCall) => void;
        /** Receives the full agent conversation (raw Gemini Content) once drafting completes. */
        onConversation?: (messages: Content[]) => void;
        /** Receives the run's token usage (incl. cache hits) once drafting completes. */
        onUsage?: (usage: TokenUsage) => void;
        /** PostHog trace/distinct-id tags so the draft's generations group by conversation. */
        observability?: AgentObservability;
    },
): Promise<Record<string, TranslationBlockResult[]>> => {
    const { sourceSlides, targets, referenceText, existingTranslation, generalContext, onToolCall, onConversation, onUsage, observability } = params;
    const itemTitle = params.itemTitle?.trim();
    const model = params.model ?? provider.defaultModel;
    // Languages we can actually fetch canonical Scripture for.
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
    const messages: Content[] = [{ role: 'user', parts: [{ text: prompt }] }];

    const result = await runSlideTranslationAgent(provider, {
        sourceSlides,
        messages,
        model,
        bibleLanguages,
        onToolCall,
        observability,
    });
    onConversation?.(result.messages);
    onUsage?.(result.usage);
    return result.translations;
};

// --- Live note-outline synthesis ---------------------------------------------------------
//
// Incrementally turns a talk's live transcript into outline blocks the editor reviews. Unlike
// the slide translator, this runs as ONE continuous conversation over the whole talk: each turn
// appends the new transcript slice + the current outline, so the model keeps a running
// understanding, prefixes stay cache-friendly, and it reconciles what it proposed earlier
// against what the editor actually kept/edited (that diff IS the human feedback — no separate
// event log). A turn may legitimately propose zero blocks when there isn't enough new material.

/** A single outline block the model proposes (before it becomes a real Yjs block). */
export type NoteBlockDraft = {
    type: 'heading' | 'bullet';
    level: number;
    content: string;
};

/** An outline block as it currently stands, sent to the model as ground truth each turn. */
export type OutlineSnapshotBlock = NoteBlockDraft & {
    /** 'confirmed' = kept by the editor; 'proposed' = an earlier suggestion not yet reviewed. */
    status: 'confirmed' | 'proposed';
};

/** Structured-output schema: an object with a (possibly empty) list of proposed blocks. */
const PROPOSE_BLOCKS_SCHEMA = {
    type: Type.OBJECT,
    required: ['blocks'],
    properties: {
        blocks: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                required: ['type', 'level', 'content'],
                properties: {
                    type: { type: Type.STRING, description: '"heading" or "bullet".' },
                    level: { type: Type.INTEGER, description: 'Depth 0-5.' },
                    content: { type: Type.STRING },
                },
            },
        },
    },
};

const NOTE_SYNTH_INSTRUCTIONS = `You are an expert note-taker building a live outline of a talk in real time, as an English transcript streams in.

Each turn you receive the outline so far and the new transcript since the last turn. Propose a FEW new outline blocks that capture genuinely new material. Rules:
- Use a heading (type "heading") when the topic shifts; use bullets (type "bullet") for points and supporting detail.
- level is 0-5. For headings, level is the heading depth (0 = top level). For bullets, level is the indent depth under the current point.
- Keep each block short and self-contained — a phrase or one sentence, never a raw transcript quote.
- Do NOT repeat, restate, or lightly reword anything already in the outline.
- Match the wording and style the editor has kept or edited in CONFIRMED blocks.
- If there is not yet enough substance for a new block (filler, repetition, or just a few words), return an EMPTY blocks array and wait.
- Never revise or delete existing blocks; only propose new ones — they are appended to the end of the outline.

Outline blocks are marked CONFIRMED (kept by the editor) or PROPOSED (your earlier suggestions not yet reviewed). Build on CONFIRMED structure and do not duplicate still-PROPOSED blocks.

Respond ONLY with JSON of the form {"blocks": [{"type": "heading"|"bullet", "level": <0-5>, "content": "..."}]}. An empty blocks array is valid and expected during quiet stretches.`;

/** Render the current outline for the prompt, tagging each block's review status. */
const formatOutlineForPrompt = (outline: OutlineSnapshotBlock[]): string => {
    if (outline.length === 0) return '(the outline is empty)';
    return outline
        .map((block) => {
            const tag = block.status === 'confirmed' ? '[CONFIRMED]' : '[PROPOSED] ';
            const level = Math.min(Math.max(0, block.level), 5);
            const body =
                block.type === 'heading'
                    ? `${'#'.repeat(level + 2)} ${block.content}`
                    : `${'  '.repeat(level)}- ${block.content}`;
            return `${tag} ${body}`;
        })
        .join('\n');
};

/** The per-turn user message: current outline + the new transcript slice. */
const buildNoteSynthesisTurnBody = (newTranscript: string, outline: OutlineSnapshotBlock[]): string =>
    `Outline so far:
<outline>
${formatOutlineForPrompt(outline)}
</outline>

New transcript since last time:
<transcript>
${newTranscript.trim()}
</transcript>

Propose new blocks capturing only genuinely new material (or an empty array).`;

/**
 * Parse a `propose_blocks` structured response into validated drafts. Tolerant by design:
 * bad JSON yields no blocks (a quiet turn), unknown types fall back to 'bullet', levels are
 * clamped to 0-5, and empty-content blocks are dropped.
 */
export const parseProposedBlocks = (text: string | undefined): NoteBlockDraft[] => {
    if (!text) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return [];
    }
    const rawBlocks = (parsed as { blocks?: unknown })?.blocks;
    if (!Array.isArray(rawBlocks)) return [];
    const drafts: NoteBlockDraft[] = [];
    for (const raw of rawBlocks) {
        const entry = raw as { type?: unknown; level?: unknown; content?: unknown };
        const content = typeof entry.content === 'string' ? entry.content.trim() : '';
        if (!content) continue;
        const type = entry.type === 'heading' ? 'heading' : 'bullet';
        const levelNum = typeof entry.level === 'number' ? Math.floor(entry.level) : 0;
        const level = Math.min(Math.max(0, levelNum), 5);
        drafts.push({ type, level, content });
    }
    return drafts;
};

export type NoteSynthTurnResult = {
    /** New blocks the model proposes this turn (empty when there isn't enough new material). */
    blocks: NoteBlockDraft[];
    /** The updated conversation (raw Gemini Content, mutated in place and returned). */
    messages: Content[];
};

/**
 * Run one turn of live note synthesis over a continuing conversation.
 *
 * `messages` is mutated in place and returned; pass the same array back next turn to keep the
 * conversation (and its cache-friendly prefix) going. On the first turn (empty `messages`) the
 * standing instructions are prepended. The model's prior proposals live in `messages`, so
 * sending the current `outline` each turn lets it see which were kept, edited, or dropped.
 */
export const synthesizeNotesTurn = async (
    provider: GeminiProvider,
    params: {
        messages: Content[];
        newTranscript: string;
        outline: OutlineSnapshotBlock[];
        model?: string;
    },
): Promise<NoteSynthTurnResult> => {
    const { messages, newTranscript, outline } = params;
    const model = params.model ?? provider.defaultModel;

    const turnBody = buildNoteSynthesisTurnBody(newTranscript, outline);
    const userText = messages.length === 0
        ? `${NOTE_SYNTH_INSTRUCTIONS}\n\n${turnBody}`
        : turnBody;
    messages.push({ role: 'user', parts: [{ text: userText }] });

    const response = await provider.apiClient.models.generateContent({
        model,
        config: {
            responseMimeType: 'application/json',
            responseSchema: PROPOSE_BLOCKS_SCHEMA,
        },
        contents: messages,
    });
    const modelContent = response.candidates?.[0]?.content;
    // Keep the model turn verbatim so the next turn resumes with its prior proposals in history.
    if (modelContent) messages.push(modelContent);

    const blocks = parseProposedBlocks(response.text);
    return { blocks, messages };
};
