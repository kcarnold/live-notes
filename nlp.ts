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

Here is some text that has already been translated, provided for reference for style and terminology.

<already_translated>
${todo.translatedContext}
</already_translated>

The input document is a JSON array of segments where each object has:
- "segmentId": the segment id
- "status": "C" (context, already translated) or "T" (needs translation)
- "text": the content to translate

For each segment with status "T", translate the text into the target language.

Return exactly as many segments as were provided in the input document, in the same order.

Your response should be a JSON object with a "segments" field that is an array of objects. Each object should have:
- "segmentId": the segment id
- "translation": the translated text (or the original text if status was "C")

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
