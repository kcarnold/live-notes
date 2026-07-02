import { GoogleGenAI } from '@posthog/ai';
import genAI, { FunctionCallingConfigMode, type Content, type Part, type FunctionDeclaration } from '@google/genai'; // for types
import { PostHog } from 'posthog-node';
import { BIBLE_TRANSLATIONS, lookupBiblePassage, type BibleLookupArgs, type BibleToolCall } from './bible.ts';

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

export const translateBlock = async (provider: GeminiProvider, todo: TranslationTodo, language: string): Promise<TranslationBlockResult[]> => {
    const config = {
      responseMimeType: 'application/json',
      responseSchema: {
        type: genAI.Type.OBJECT,
        required: ["segments"],
        properties: {
          segments: {
            type: genAI.Type.ARRAY,
            items: {
              type: genAI.Type.OBJECT,
              required: ["segmentId", "translation"],
              properties: {
                segmentId: {
                  type: genAI.Type.INTEGER,
                },
                translation: {
                  type: genAI.Type.STRING,
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
        type: genAI.Type.OBJECT,
        properties: {
            book: {
                type: genAI.Type.STRING,
                description:
                    'USFM book code (uppercase 3 chars), e.g. GEN, PSA, ISA, MAT, JHN, ROM, 1CO, REV.',
            },
            chapter: { type: genAI.Type.INTEGER, description: 'Chapter number.' },
            startVerse: {
                type: genAI.Type.INTEGER,
                description: 'First verse of the range. Omit to fetch the whole chapter.',
            },
            endVerse: {
                type: genAI.Type.INTEGER,
                description: 'Last verse of the range. Omit for a single verse (defaults to startVerse).',
            },
        },
        required: ['book', 'chapter'],
    },
};

/** Function declaration the model uses to record the finished translations. */
const SET_TRANSLATIONS_TOOL: FunctionDeclaration = {
    name: 'set_translations',
    description:
        'Record the finished translations. Call this once the translations are ready, with ' +
        'one entry per target language and exactly one segment per requested slide id. You ' +
        'may call it again to revise (e.g. after reviewer feedback). Add a per-segment ' +
        '"note" ONLY when there is a genuine caveat, ambiguity, or choice the reviewer should ' +
        'know about — otherwise omit it.',
    parameters: {
        type: genAI.Type.OBJECT,
        required: ['languages'],
        properties: {
            languages: {
                type: genAI.Type.ARRAY,
                items: {
                    type: genAI.Type.OBJECT,
                    required: ['language', 'segments'],
                    properties: {
                        language: { type: genAI.Type.STRING },
                        segments: {
                            type: genAI.Type.ARRAY,
                            items: {
                                type: genAI.Type.OBJECT,
                                required: ['segmentId', 'translation'],
                                properties: {
                                    segmentId: { type: genAI.Type.INTEGER },
                                    translation: { type: genAI.Type.STRING },
                                    note: { type: genAI.Type.STRING },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
};

/** Safety cap on agent turns (Bible lookups + set_translations + a closing note). */
const MAX_AGENT_ROUNDS = 8;

/** Parse a `set_translations` tool call's args into per-language results. */
const parseSetTranslations = (
    args: Record<string, unknown> | undefined,
    sourceSlides: string[],
): Record<string, TranslationBlockResult[]> => {
    const out: Record<string, TranslationBlockResult[]> = {};
    const languageResults = ((args?.languages as unknown[]) ?? []) as Array<{
        language: string;
        segments: Array<{ segmentId: number; translation: string; note?: string }>;
    }>;
    for (const result of languageResults) {
        const language = result.language;
        if (!language) continue;
        out[language] = (result.segments ?? [])
            .filter((segment) => segment.segmentId >= 0 && segment.segmentId < sourceSlides.length)
            .map((segment) => ({
                sourceText: sourceSlides[segment.segmentId],
                translatedText: segment.translation ?? '',
                language,
            }));
    }
    return out;
};

export type SlideAgentRunResult = {
    /** Translations from the most recent `set_translations` call this run (empty if none). */
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
 * The model has two tools: `lookup_bible_passage` (grounds Scripture slides in the published
 * text) and `set_translations` (records the structured output). Both run in one loop — and,
 * unlike the old two-call design, `set_translations` is NOT a hard stop: it is executed like
 * any tool and the model is allowed to end its turn naturally (a turn with no function
 * calls), so it can add a closing note or ask a clarifying question instead of translating.
 *
 * `messages` is mutated in place and returned; pass a continuing history to resume from
 * reviewer feedback. `onToolCall` reports each Bible lookup for observability.
 */
export const runSlideTranslationAgent = async (
    provider: GeminiProvider,
    params: {
        sourceSlides: string[];
        messages: Content[];
        model?: string;
        bibleLanguages: string[];
        onToolCall?: (call: BibleToolCall) => void;
        /** PostHog trace/distinct-id tags so every round groups under one conversation. */
        observability?: AgentObservability;
    },
): Promise<SlideAgentRunResult> => {
    const { sourceSlides, messages, bibleLanguages, onToolCall, observability } = params;
    const model = params.model ?? provider.defaultModel;

    const functionDeclarations: FunctionDeclaration[] = [SET_TRANSLATIONS_TOOL];
    if (bibleLanguages.length > 0) functionDeclarations.unshift(BIBLE_LOOKUP_TOOL);
    const tools = [{ functionDeclarations }];

    let translations: Record<string, TranslationBlockResult[]> = {};
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
                translations = parseSetTranslations(
                    call.args as Record<string, unknown> | undefined,
                    sourceSlides,
                );
                setTranslationsCalled = true;
                responseParts.push({
                    functionResponse: { name: call.name, response: { ok: true } },
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

    return { translations, messages, setTranslationsCalled, usage };
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

    const sourceDocument = JSON.stringify(
        sourceSlides.map((text, index) => ({ segmentId: index, text: text.trim() }))
    );
    const targetsDocument = JSON.stringify(
        targets.map((target) => ({
            language: target.language,
            translateSegmentIds: sourceSlides
                .map((_, index) => index)
                .filter((index) => target.isTranslationNeeded[index]),
            context: target.context,
        }))
    );

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
Some slides are or quote Scripture (an explicit Bible reading, a quoted verse, or an
adaptation such as "based on Psalm 23"). When a slide draws on a Bible passage, call the
lookup_bible_passage tool to fetch the canonical published wording in the target languages
(${bibleLanguages.join(', ')}), then base your translation on that text — adapting only
where the slide itself does (responsive readings, pronoun changes, partial quotes). Look up
every reference you recognize — the passage named in the item title above, and any inline
references — before recording the final translations.

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
When the translations are ready, call the set_translations tool. For each target language
include exactly one segment per id in its "translateSegmentIds", with segmentIds matching
the source slides; do not include ids that were not requested. Do not reply with the
translations as plain text — record them via the tool. If something genuinely needs the
reviewer's attention, you may also write a short message or attach a per-segment "note", but
keep quiet when there is nothing useful to say.
`;

    return `
You are translating presentation slides into several languages at once.
${contextSection}${itemTitleSection}
The source slides are a JSON array of segments:
<source_slides>
${sourceDocument}
</source_slides>

Translate into the following target languages. For each language, "translateSegmentIds"
lists exactly which source slide ids to translate. "context" holds already-approved
translations in that language, given only as a guide for style and terminology — it is
not something to translate.
<targets>
${targetsDocument}
</targets>
${referenceSection}${existingTranslationSection}${bibleSection}${toolInstruction}`;
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
    const slidesDocument = JSON.stringify(
        slides.map((text, index) => ({ segmentId: index, text: text.trim() }))
    );
    const current = JSON.stringify(
        Object.entries(translations).map(([language, perSlide]) => ({
            language,
            segments: perSlide.map((entry, index) => ({ segmentId: index, translation: entry?.text ?? '' })),
        }))
    );
    return `
You are reviewing presentation slide translations into several languages.
${contextSection}
The source slides are a JSON array of segments:
<source_slides>
${slidesDocument}
</source_slides>

These slides are already translated as follows:
<current_translations>
${current}
</current_translations>

Await the reviewer's feedback. When asked to change something, call the set_translations
tool with the revised segments (one entry per affected language, segmentIds matching the
source slides). Only speak up when there is something useful to say.`;
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
    type: genAI.Type.OBJECT,
    required: ['blocks'],
    properties: {
        blocks: {
            type: genAI.Type.ARRAY,
            items: {
                type: genAI.Type.OBJECT,
                required: ['type', 'level', 'content'],
                properties: {
                    type: { type: genAI.Type.STRING, description: '"heading" or "bullet".' },
                    level: { type: genAI.Type.INTEGER, description: 'Depth 0-5.' },
                    content: { type: genAI.Type.STRING },
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
