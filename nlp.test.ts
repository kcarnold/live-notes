import { describe, it, expect, vi } from 'vitest';
import { alignReferenceTranslation, GeminiProvider } from './nlp.ts';

function fakeProvider(response: object): GeminiProvider {
  return {
    apiClient: {
      models: { generateContent: vi.fn().mockResolvedValue({ text: JSON.stringify(response) }) },
    },
    defaultModel: 'fake-model',
    maxTokens: 1000,
  } as unknown as GeminiProvider;
}

describe('alignReferenceTranslation', () => {
  it('maps segments to per-slide aligned text and returns the detected language', async () => {
    const provider = fakeProvider({
      language: 'French',
      segments: [
        { segmentId: 0, translation: 'Louez le Seigneur' },
        { segmentId: 1, translation: 'Pour toujours' },
      ],
    });
    const result = await alignReferenceTranslation(provider, {
      sourceSlides: ['Praise the Lord', 'Forever'],
      referenceText: 'Louez le Seigneur. Pour toujours.',
      allowedLanguages: ['French', 'Haitian Creole'],
    });
    expect(result.language).toBe('French');
    expect(result.slides).toEqual(['Louez le Seigneur', 'Pour toujours']);
  });

  it('fills missing slides with empty strings and ignores out-of-range segmentIds', async () => {
    const provider = fakeProvider({
      language: 'Unknown',
      segments: [
        { segmentId: 1, translation: 'only second' },
        { segmentId: 5, translation: 'out of range' },
      ],
    });
    const result = await alignReferenceTranslation(provider, {
      sourceSlides: ['a', 'b'],
      referenceText: 'x',
      allowedLanguages: ['French'],
    });
    expect(result.slides).toEqual(['', 'only second']);
    expect(result.language).toBe('Unknown');
  });

  it('defaults to Unknown + empty slides on a minimal response', async () => {
    const provider = fakeProvider({});
    const result = await alignReferenceTranslation(provider, {
      sourceSlides: ['a'],
      referenceText: 'x',
      allowedLanguages: ['French'],
    });
    expect(result).toEqual({ language: 'Unknown', slides: [''] });
  });
});
