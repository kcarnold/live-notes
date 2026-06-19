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

export type AlignReferenceResult = {
    /** The detected language of the reference (one of allowedLanguages, or 'Unknown'). */
    language: string;
    /** Per-source-slide aligned translation, same length/order as sourceSlides ('' if none). */
    slides: string[];
};

/**
 * Align an existing translation (in an unknown language) to a list of source slides.
 *
 * Rather than index-matching pre-split segments, the model re-segments the existing
 * translation to match the source slides and detects its language. Used to turn
 * Proclaim's existing translation-screen text into a per-slide first draft.
 */
export const alignReferenceTranslation = async (
    provider: GeminiProvider,
    params: { sourceSlides: string[]; referenceText: string; allowedLanguages: string[] },
): Promise<AlignReferenceResult> => {
    const { sourceSlides, referenceText, allowedLanguages } = params;

    const config = {
        responseMimeType: 'application/json',
        responseSchema: {
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
    };

    const inputDocument = JSON.stringify(
        sourceSlides.map((text, index) => ({ segmentId: index, text: text.trim() }))
    );

    const allowedList = allowedLanguages.join(', ');
    const contents = [
        {
            role: 'user',
            parts: [
                {
                    text: `
You are aligning an existing translation to a list of source slides.

The source text is split into numbered slides:
<source_slides>
${inputDocument}
</source_slides>

Here is an existing translation of this same content, in a single unknown language.
It may be split differently from the source slides, or not split at all:
<existing_translation>
${referenceText}
</existing_translation>

Tasks:
1. Detect the language of the existing translation. Respond with exactly one of:
   ${allowedList}. If it is none of these (for example it is actually in the source
   language), respond with "Unknown".
2. For each source slide, return the portion of the existing translation that
   corresponds to it, re-segmented to match the source slides. Preserve the existing
   wording; only adjust segmentation and whitespace. If a source slide has no
   corresponding text, return an empty string.

Respond with only JSON:
{ "language": "<detected language>", "segments": [{ "segmentId": <id>, "translation": "<text>" }] }

Include exactly one segment per source slide, with segmentIds matching the input.
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
    const jsonResponse = JSON.parse(response.text || '{}');
    const language: string = jsonResponse.language || 'Unknown';
    const segments = (jsonResponse.segments ?? []) as Array<{ segmentId: number; translation: string }>;

    const slides = sourceSlides.map(() => '');
    for (const segment of segments) {
        if (segment.segmentId >= 0 && segment.segmentId < slides.length) {
            slides[segment.segmentId] = segment.translation ?? '';
        }
    }

    return { language, slides };
}
