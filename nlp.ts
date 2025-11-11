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
        required: ["lines"],
        properties: {
          lines: {
            type: genAI.Type.ARRAY,
            items: {
              type: genAI.Type.OBJECT,
              required: ["num", "translation"],
              properties: {
                num: {
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
    const model = 'gemini-2.0-flash-lite';
    const inputDocument = todo.chunks.map((chunk, index) => {
        const isTranslationNeeded = todo.isTranslationNeeded[index];
        const lineNumber = index;
        return `${lineNumber} ${isTranslationNeeded ? 'T' : 'C'} ${chunk.trim()}`;
    }).join('\n');
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

The input document will be in the form:
NUMBER C_OR_T TEXT

Where C_OR_T is either C (for context) or T (for translation).

For each line marked with T, translate the text into the target language.

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
    const lines = jsonResponse.lines;
    const translatedBlocks: TranslationBlockResult[] = lines.map((line: any) => {
        const lineNumber = line.num;
        const translatedText = line.translation;
        const sourceText = todo.chunks[lineNumber];
        return { sourceText, translatedText, language };
    });
    return translatedBlocks;
}  
