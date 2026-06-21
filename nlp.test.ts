import { describe, it, expect, vi } from 'vitest';
import { draftItemTranslations, GeminiProvider } from './nlp.ts';

function fakeProvider(response: object): { provider: GeminiProvider; generateContent: ReturnType<typeof vi.fn> } {
  const generateContent = vi.fn().mockResolvedValue({ text: JSON.stringify(response) });
  const provider = {
    apiClient: { models: { generateContent } },
    defaultModel: 'fake-model',
    maxTokens: 1000,
  } as unknown as GeminiProvider;
  return { provider, generateContent };
}

describe('draftItemTranslations', () => {
  it('returns per-language results keyed by source slide text', async () => {
    const { provider } = fakeProvider({
      languages: [
        {
          language: 'French',
          segments: [
            { segmentId: 0, translation: 'Louez le Seigneur' },
            { segmentId: 1, translation: 'Pour toujours' },
          ],
        },
        {
          language: 'Haitian Creole',
          segments: [
            { segmentId: 0, translation: 'Lwanj pou Senyè a' },
            { segmentId: 1, translation: 'Pou tout tan' },
          ],
        },
      ],
    });

    const result = await draftItemTranslations(provider, {
      sourceSlides: ['Praise the Lord', 'Forever'],
      targets: [
        { language: 'French', isTranslationNeeded: [true, true], context: '' },
        { language: 'Haitian Creole', isTranslationNeeded: [true, true], context: '' },
      ],
    });

    expect(result.French).toEqual([
      { sourceText: 'Praise the Lord', translatedText: 'Louez le Seigneur', language: 'French' },
      { sourceText: 'Forever', translatedText: 'Pour toujours', language: 'French' },
    ]);
    expect(result['Haitian Creole'][0].translatedText).toBe('Lwanj pou Senyè a');
  });

  it('includes the reference text and the chosen model in the request', async () => {
    const { provider, generateContent } = fakeProvider({ languages: [] });

    await draftItemTranslations(provider, {
      sourceSlides: ['Hello'],
      targets: [{ language: 'French', isTranslationNeeded: [true], context: '' }],
      referenceText: 'Bonjour le monde',
      model: 'strong-model',
    });

    const call = generateContent.mock.calls[0][0];
    expect(call.model).toBe('strong-model');
    const prompt = call.contents[0].parts[0].text as string;
    expect(prompt).toContain('Bonjour le monde');
    expect(prompt).toContain('reference_material');
  });

  it('omits the reference section when no reference is given and uses the default model', async () => {
    const { provider, generateContent } = fakeProvider({ languages: [] });

    await draftItemTranslations(provider, {
      sourceSlides: ['Hello'],
      targets: [{ language: 'French', isTranslationNeeded: [true], context: '' }],
    });

    const call = generateContent.mock.calls[0][0];
    expect(call.model).toBe('fake-model');
    expect(call.contents[0].parts[0].text).not.toContain('reference_material');
  });

  it('ignores out-of-range segmentIds and tolerates a minimal response', async () => {
    const { provider } = fakeProvider({
      languages: [
        {
          language: 'French',
          segments: [
            { segmentId: 0, translation: 'ok' },
            { segmentId: 9, translation: 'out of range' },
          ],
        },
      ],
    });

    const result = await draftItemTranslations(provider, {
      sourceSlides: ['a', 'b'],
      targets: [{ language: 'French', isTranslationNeeded: [true, true], context: '' }],
    });

    expect(result.French).toEqual([
      { sourceText: 'a', translatedText: 'ok', language: 'French' },
    ]);
  });
});
