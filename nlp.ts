import { generateObject } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';

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

const segmentSchema = z.object({
    segments: z.array(z.object({
        segmentId: z.number().int(),
        translation: z.string(),
    })),
});

export const translateBlock = async (model: LanguageModel, todo: TranslationTodo, language: string): Promise<TranslationBlockResult[]> => {
    const inputDocument = JSON.stringify(
        todo.chunks.map((chunk, index) => ({
            segmentId: index,
            status: todo.isTranslationNeeded[index] ? 'T' : 'C',
            text: chunk.trim()
        }))
    );
    console.log('Input document:', inputDocument);

    const { object, usage } = await generateObject({
        model,
        schema: segmentSchema,
        messages: [
            {
                role: 'user',
                content: `
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
    });

    console.dir(object, { depth: null });
    console.log(usage);

    return object.segments.map((segment) => ({
        sourceText: todo.chunks[segment.segmentId],
        translatedText: segment.translation,
    }));
}
