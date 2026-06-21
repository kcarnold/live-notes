import { GoogleGenAI } from '@posthog/ai'; 
import genAI from '@google/genai'; // for types
import { PostHog } from 'posthog-node';

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

/**
 * Translate a whole item into several languages in a single model call.
 *
 * The model receives the numbered source slides, the target languages (each with which
 * slides still need translating and any already-reviewed translations as context), and
 * an optional free-text `referenceText` dump that may hold prior translations in one or
 * more of the target languages (the operator pastes it; it can be multilingual and
 * arbitrarily segmented). For each language the model translates only the needed slides,
 * adapting the reference's wording where it covers that language and ignoring it
 * otherwise. Used for slide pre-translation/review, where full-item context and reference
 * reuse matter more than latency — hence one strong-model call for all languages at once.
 *
 * Returns, per language, a `TranslationBlockResult` for each needed slide (others omitted).
 */
export const draftItemTranslations = async (
    provider: GeminiProvider,
    params: { sourceSlides: string[]; targets: DraftItemTarget[]; referenceText?: string; model?: string },
): Promise<Record<string, TranslationBlockResult[]>> => {
    const { sourceSlides, targets, referenceText } = params;

    const config = {
        responseMimeType: 'application/json',
        // All languages × needed slides come back in one response; give it room.
        maxOutputTokens: 32768,
        responseSchema: {
            type: genAI.Type.OBJECT,
            required: ["languages"],
            properties: {
                languages: {
                    type: genAI.Type.ARRAY,
                    items: {
                        type: genAI.Type.OBJECT,
                        required: ["language", "segments"],
                        properties: {
                            language: { type: genAI.Type.STRING },
                            segments: {
                                type: genAI.Type.ARRAY,
                                items: {
                                    type: genAI.Type.OBJECT,
                                    required: ["segmentId", "translation"],
                                    properties: {
                                        segmentId: { type: genAI.Type.INTEGER },
                                        translation: { type: genAI.Type.STRING },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    };

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

    const contents = [
        {
            role: 'user',
            parts: [
                {
                    text: `
You are translating presentation slides into several languages at once.

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
${referenceSection}
Respond with only JSON:
{ "languages": [ { "language": "<language>", "segments": [ { "segmentId": <id>, "translation": "<text in that language>" } ] } ] }

For each target language, include exactly one segment per id in its "translateSegmentIds",
with segmentIds matching the source slides. Do not include segments for ids not listed.
  `,
                },
            ],
        },
    ];

    const response = await provider.apiClient.models.generateContent({
        model: params.model ?? provider.defaultModel,
        config,
        contents,
    });
    const jsonResponse = JSON.parse(response.text || '{}');
    const languageResults = (jsonResponse.languages ?? []) as Array<{
        language: string;
        segments: Array<{ segmentId: number; translation: string }>;
    }>;

    const out: Record<string, TranslationBlockResult[]> = {};
    for (const result of languageResults) {
        const language = result.language;
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
