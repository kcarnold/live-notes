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
    },
): Promise<SlideAgentRunResult> => {
    const { sourceSlides, messages, bibleLanguages, onToolCall } = params;
    const model = params.model ?? provider.defaultModel;

    const functionDeclarations: FunctionDeclaration[] = [SET_TRANSLATIONS_TOOL];
    if (bibleLanguages.length > 0) functionDeclarations.unshift(BIBLE_LOOKUP_TOOL);
    const tools = [{ functionDeclarations }];

    let translations: Record<string, TranslationBlockResult[]> = {};
    let setTranslationsCalled = false;

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
        });
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

    return { translations, messages, setTranslationsCalled };
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
    itemTitle?: string;
    bibleLanguages: string[];
}): string => {
    const { sourceSlides, targets, referenceText, itemTitle, bibleLanguages } = params;

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

    const bibleSection = bibleLanguages.length > 0
        ? `
Some slides are or quote Scripture (an explicit Bible reading, a quoted verse, or an
adaptation such as "based on Psalm 23"). When a slide draws on a Bible passage, call the
lookup_bible_passage tool to fetch the canonical published wording in the target languages
(${bibleLanguages.join(', ')}), then base your translation on that text — adapting only
where the slide itself does (responsive readings, pronoun changes, partial quotes). Look up
every reference you recognize — the passage named in the item title above, and any inline
references — before recording the final translations.
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
${itemTitleSection}
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
${referenceSection}${bibleSection}${toolInstruction}`;
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
    },
): Promise<Record<string, TranslationBlockResult[]>> => {
    const { sourceSlides, targets, referenceText, onToolCall, onConversation } = params;
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
    });
    onConversation?.(result.messages);
    return result.translations;
};
