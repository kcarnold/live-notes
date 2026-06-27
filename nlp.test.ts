import { describe, it, expect, vi } from 'vitest';
import { draftItemTranslations, buildSeedConversationPrompt, GeminiProvider } from './nlp.ts';

/**
 * A provider whose model calls `set_translations` with the given args, then ends its turn.
 * Mirrors the two round-trips the agent loop makes: (1) the tool call, (2) the closing turn
 * with no function calls.
 */
function fakeAgentProvider(setTranslationsArgs: object): {
  provider: GeminiProvider;
  generateContent: ReturnType<typeof vi.fn>;
} {
  const callPart = { functionCall: { name: 'set_translations', args: setTranslationsArgs } };
  const generateContent = vi
    .fn()
    .mockResolvedValueOnce({
      functionCalls: [{ name: 'set_translations', args: setTranslationsArgs }],
      candidates: [{ content: { role: 'model', parts: [callPart] } }],
    })
    .mockResolvedValueOnce({
      functionCalls: [],
      candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] } }],
    });
  const provider = {
    apiClient: { models: { generateContent } },
    defaultModel: 'fake-model',
    maxTokens: 1000,
  } as unknown as GeminiProvider;
  return { provider, generateContent };
}

/** A provider whose model ends its turn immediately (no tool calls). */
function fakeSilentProvider(): {
  provider: GeminiProvider;
  generateContent: ReturnType<typeof vi.fn>;
} {
  const generateContent = vi.fn().mockResolvedValue({ functionCalls: [], candidates: [] });
  const provider = {
    apiClient: { models: { generateContent } },
    defaultModel: 'fake-model',
    maxTokens: 1000,
  } as unknown as GeminiProvider;
  return { provider, generateContent };
}

describe('draftItemTranslations', () => {
  it('returns per-language results keyed by source slide text', async () => {
    const { provider } = fakeAgentProvider({
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
    const { provider, generateContent } = fakeSilentProvider();

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
    const { provider, generateContent } = fakeSilentProvider();

    await draftItemTranslations(provider, {
      sourceSlides: ['Hello'],
      targets: [{ language: 'French', isTranslationNeeded: [true], context: '' }],
    });

    const call = generateContent.mock.calls[0][0];
    expect(call.model).toBe('fake-model');
    expect(call.contents[0].parts[0].text).not.toContain('reference_material');
  });

  it('includes the general context and a cautious existing-translation section', async () => {
    const { provider, generateContent } = fakeSilentProvider();

    await draftItemTranslations(provider, {
      sourceSlides: ['Hello'],
      targets: [{ language: 'French', isTranslationNeeded: [true], context: '' }],
      generalContext: 'PCA church; translations are for understanding, not singing.',
      existingTranslation: 'Bonjour (peut-être généré par machine)',
    });

    const prompt = generateContent.mock.calls[0][0].contents[0].parts[0].text as string;
    expect(prompt).toContain('PCA church');
    expect(prompt).toContain('existing_translation');
    expect(prompt).toContain('Bonjour (peut-être généré par machine)');
    // Framed cautiously, distinct from the trusted reference paste.
    expect(prompt).toContain('may itself be machine-generated');
  });

  it('ignores out-of-range segmentIds and tolerates a minimal response', async () => {
    const { provider } = fakeAgentProvider({
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

  it('captures the raw conversation verbatim and ends on the model end-of-turn', async () => {
    const args = {
      languages: [{ language: 'French', segments: [{ segmentId: 0, translation: 'Bonjour' }] }],
    };
    const { provider, generateContent } = fakeAgentProvider(args);
    let captured: import('@google/genai').Content[] | undefined;

    const result = await draftItemTranslations(provider, {
      sourceSlides: ['Hello'],
      targets: [{ language: 'French', isTranslationNeeded: [true], context: '' }],
      onConversation: (messages) => {
        captured = messages;
      },
    });

    expect(result.French[0].translatedText).toBe('Bonjour');
    // Two rounds: the set_translations call, then the closing turn with no calls.
    expect(generateContent).toHaveBeenCalledTimes(2);
    // Raw history kept verbatim: prompt, model tool call, our tool result, model closing text.
    expect(captured?.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model']);
    expect(captured?.[1].parts?.[0].functionCall?.name).toBe('set_translations');
    expect(captured?.[2].parts?.[0].functionResponse?.name).toBe('set_translations');
  });
});

describe('buildSeedConversationPrompt', () => {
  it('carries slides, current translations, and context for a no-agent follow-up', () => {
    const prompt = buildSeedConversationPrompt({
      slides: ['Hello', 'World'],
      translations: { French: [{ text: 'Bonjour' }, { text: 'Monde' }] },
      generalContext: 'PCA church setting.',
    });

    expect(prompt).toContain('PCA church setting.');
    expect(prompt).toContain('Hello');
    expect(prompt).toContain('Bonjour');
    // Tells the resumed agent how to apply revisions.
    expect(prompt).toContain('set_translations');
  });
});
