import { describe, it, expect, vi } from 'vitest';
import type { Content } from '@google/genai';
import {
  draftItemTranslations,
  buildSeedConversationPrompt,
  runSlideTranslationAgent,
  GeminiProvider,
  emptyUsage,
  addUsage,
  mergeUsage,
} from './nlp.ts';

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

/**
 * A provider that plays a scripted sequence of tool-call rounds, then ends its turn.
 * Each round is the list of function calls the model "makes" that round.
 */
function fakeScriptedProvider(rounds: Array<Array<{ name: string; args: object }>>): GeminiProvider {
  const generateContent = vi.fn();
  for (const calls of rounds) {
    generateContent.mockResolvedValueOnce({
      functionCalls: calls,
      candidates: [
        { content: { role: 'model', parts: calls.map((call) => ({ functionCall: call })) } },
      ],
    });
  }
  generateContent.mockResolvedValue({
    functionCalls: [],
    candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] } }],
  });
  return {
    apiClient: { models: { generateContent } },
    defaultModel: 'fake-model',
    maxTokens: 1000,
  } as unknown as GeminiProvider;
}

/** The response payload our loop returned for the Nth call of a given tool. */
function toolResponses(messages: Content[], name: string): Array<Record<string, unknown>> {
  return messages
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.functionResponse?.name === name)
    .map((part) => (part.functionResponse?.response ?? {}) as Record<string, unknown>);
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

describe('newline handling', () => {
  // The escape-unwinding itself is covered in src/slideTranslation.test.ts; these check
  // that the agent applies it and that the prompt no longer teaches the escaping.
  it('converts a translation containing literal backslash-n into real line breaks', async () => {
    const { provider } = fakeAgentProvider({
      languages: [
        {
          language: 'French',
          segments: [{ segmentId: 0, translation: 'Sainte nuit\\nNuit paisible' }],
        },
      ],
    });

    const result = await draftItemTranslations(provider, {
      sourceSlides: ['Silent night\nHoly night'],
      targets: [{ language: 'French', isTranslationNeeded: [true], context: '' }],
    });

    expect(result.French[0].translatedText).toBe('Sainte nuit\nNuit paisible');
  });

  it('shows multi-line slides to the model as real line breaks, not JSON escapes', async () => {
    const { provider, generateContent } = fakeSilentProvider();

    await draftItemTranslations(provider, {
      sourceSlides: ['Silent night\nHoly night'],
      targets: [{ language: 'French', isTranslationNeeded: [true], context: '' }],
    });

    const prompt = generateContent.mock.calls[0][0].contents[0].parts[0].text as string;
    expect(prompt).toContain('<slide id="0">\nSilent night\nHoly night\n</slide>');
    expect(prompt).not.toContain('Silent night\\nHoly night');
  });

  it('tells the model when line structure matters and when to drop it', async () => {
    const { provider, generateContent } = fakeSilentProvider();

    await draftItemTranslations(provider, {
      sourceSlides: ['Hello'],
      targets: [{ language: 'French', isTranslationNeeded: [true], context: '' }],
    });

    const prompt = generateContent.mock.calls[0][0].contents[0].parts[0].text as string;
    expect(prompt).toContain('Never write the two characters backslash-n');
    // Songs/poetry keep their lines; prose breaks are cosmetic and the viewer reflows.
    expect(prompt).toMatch(/Songs, hymns, poetry, and responsive readings/);
    expect(prompt).toMatch(/Ignore them\. Write the translation as unbroken prose/);
  });

  // The policy used to be stated in the prompt *and* in each tool parameter, which meant
  // editing it in one place silently left the other contradicting it.
  it('states the line-break policy once per prompt, not once per mention', async () => {
    const { provider, generateContent } = fakeSilentProvider();

    await draftItemTranslations(provider, {
      sourceSlides: ['Hello'],
      targets: [{ language: 'French', isTranslationNeeded: [true], context: '' }],
    });

    const call = generateContent.mock.calls[0][0];
    const prompt = call.contents[0].parts[0].text as string;
    const occurrences = prompt.split('Songs, hymns, poetry, and responsive readings').length - 1;
    expect(occurrences).toBe(1);

    // Tool parameters carry only the encoding rule, deferring on the editorial policy.
    const declarations = call.config.tools[0].functionDeclarations as Array<{
      name: string;
      parameters?: { properties?: Record<string, { description?: string }> };
    }>;
    const revise = declarations.find((declaration) => declaration.name === 'revise_translation');
    const replaceDescription = revise?.parameters?.properties?.replace?.description ?? '';
    expect(replaceDescription).toContain('never the two characters backslash-n');
    expect(replaceDescription).not.toContain('Songs, hymns, poetry');
  });
});

describe('revise_translation (targeted edits)', () => {
  const slides = ['Praise the Lord', 'Forever'];

  it('applies a str_replace-style edit to a recorded translation and reports the new text', async () => {
    const provider = fakeScriptedProvider([
      [
        {
          name: 'set_translations',
          args: {
            languages: [
              {
                language: 'French',
                segments: [
                  { segmentId: 0, translation: 'Louez le Seigneur' },
                  { segmentId: 1, translation: 'Pour toujours' },
                ],
              },
            ],
          },
        },
      ],
      [
        {
          name: 'revise_translation',
          args: { language: 'French', segmentId: 0, find: 'Louez', replace: 'Louons' },
        },
      ],
    ]);

    const result = await runSlideTranslationAgent(provider, {
      sourceSlides: slides,
      messages: [{ role: 'user', parts: [{ text: 'prompt' }] }],
      bibleLanguages: [],
    });

    // The edit is folded into the run's result, not reported separately from the draft.
    expect(result.translations.French).toEqual([
      { sourceText: 'Praise the Lord', translatedText: 'Louons le Seigneur', language: 'French' },
      { sourceText: 'Forever', translatedText: 'Pour toujours', language: 'French' },
    ]);
    expect(toolResponses(result.messages, 'revise_translation')[0]).toMatchObject({
      ok: true,
      text: 'Louons le Seigneur',
    });
  });

  it('edits translations that already existed, without the model re-sending them', async () => {
    const provider = fakeScriptedProvider([
      [
        {
          name: 'revise_translation',
          args: { language: 'French', segmentId: 1, find: 'toujours', replace: "l'éternité" },
        },
      ],
    ]);

    const result = await runSlideTranslationAgent(provider, {
      sourceSlides: slides,
      messages: [{ role: 'user', parts: [{ text: 'prompt' }] }],
      bibleLanguages: [],
      currentTranslations: { French: ['Louez le Seigneur', 'Pour toujours'] },
    });

    // Only the edited slide comes back — the untouched seed is not reported as an update.
    expect(result.translations.French).toEqual([
      { sourceText: 'Forever', translatedText: "Pour l'éternité", language: 'French' },
    ]);
  });

  it('refuses an ambiguous or missing find, leaving the text unchanged', async () => {
    const provider = fakeScriptedProvider([
      [
        // "le" appears twice; "Gloire" not at all.
        { name: 'revise_translation', args: { language: 'French', segmentId: 0, find: 'le', replace: 'la' } },
        { name: 'revise_translation', args: { language: 'French', segmentId: 0, find: 'Gloire', replace: 'X' } },
      ],
    ]);

    const result = await runSlideTranslationAgent(provider, {
      sourceSlides: slides,
      messages: [{ role: 'user', parts: [{ text: 'prompt' }] }],
      bibleLanguages: [],
      currentTranslations: { French: ['le Seigneur le veut'] },
    });

    const responses = toolResponses(result.messages, 'revise_translation');
    expect(responses[0].error).toMatch(/more than once/);
    expect(responses[1].error).toMatch(/does not appear/);
    // Nothing changed, so nothing is reported back to the browser.
    expect(result.translations).toEqual({});
  });

  it('reports a slide that has no translation yet instead of inventing one', async () => {
    const provider = fakeScriptedProvider([
      [{ name: 'revise_translation', args: { language: 'French', segmentId: 0, find: 'x', replace: 'y' } }],
    ]);

    const result = await runSlideTranslationAgent(provider, {
      sourceSlides: slides,
      messages: [{ role: 'user', parts: [{ text: 'prompt' }] }],
      bibleLanguages: [],
    });

    expect(toolResponses(result.messages, 'revise_translation')[0].error).toMatch(
      /No translation recorded yet/,
    );
    expect(result.translations).toEqual({});
  });

  it('offers the edit tool even when there are no Bible languages', async () => {
    const { provider, generateContent } = fakeSilentProvider();

    await runSlideTranslationAgent(provider, {
      sourceSlides: slides,
      messages: [{ role: 'user', parts: [{ text: 'prompt' }] }],
      bibleLanguages: [],
    });

    const names = generateContent.mock.calls[0][0].config.tools[0].functionDeclarations.map(
      (declaration: { name: string }) => declaration.name,
    );
    expect(names).toEqual(['set_translations', 'revise_translation']);
  });
});

describe('token usage accounting', () => {
  it('sums usageMetadata across rounds, tolerating missing fields', () => {
    let usage = emptyUsage();
    usage = addUsage(usage, {
      promptTokenCount: 1000,
      cachedContentTokenCount: 0,
      candidatesTokenCount: 50,
      totalTokenCount: 1050,
    });
    // Round 2: prefix now served from cache; thoughtsTokenCount present, no explicit total.
    usage = addUsage(usage, {
      promptTokenCount: 1200,
      cachedContentTokenCount: 900,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 30,
    });
    // A tool-only response with no usageMetadata still counts as a call.
    usage = addUsage(usage, undefined);

    expect(usage.promptTokenCount).toBe(2200);
    expect(usage.cachedContentTokenCount).toBe(900);
    expect(usage.candidatesTokenCount).toBe(90);
    expect(usage.thoughtsTokenCount).toBe(30);
    expect(usage.totalTokenCount).toBe(1050);
    expect(usage.callCount).toBe(3);
  });

  it('mergeUsage adds two running totals field-by-field', () => {
    const a = { ...emptyUsage(), promptTokenCount: 100, cachedContentTokenCount: 40, callCount: 1 };
    const b = { ...emptyUsage(), promptTokenCount: 200, cachedContentTokenCount: 150, callCount: 2 };
    const merged = mergeUsage(a, b);
    expect(merged.promptTokenCount).toBe(300);
    expect(merged.cachedContentTokenCount).toBe(190);
    expect(merged.callCount).toBe(3);
  });

  it('surfaces accumulated usage and tags generations for PostHog grouping', async () => {
    const args = {
      languages: [{ language: 'French', segments: [{ segmentId: 0, translation: 'Bonjour' }] }],
    };
    const callPart = { functionCall: { name: 'set_translations', args } };
    const generateContent = vi
      .fn()
      .mockResolvedValueOnce({
        functionCalls: [{ name: 'set_translations', args }],
        candidates: [{ content: { role: 'model', parts: [callPart] } }],
        usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 0, candidatesTokenCount: 20, totalTokenCount: 1020 },
      })
      .mockResolvedValueOnce({
        functionCalls: [],
        candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] } }],
        usageMetadata: { promptTokenCount: 1100, cachedContentTokenCount: 950, candidatesTokenCount: 10, totalTokenCount: 1110 },
      });
    const provider = {
      apiClient: { models: { generateContent } },
      defaultModel: 'fake-model',
      maxTokens: 1000,
    } as unknown as GeminiProvider;

    let usage: import('./nlp.ts').TokenUsage | undefined;
    await draftItemTranslations(provider, {
      sourceSlides: ['Hello'],
      targets: [{ language: 'French', isTranslationNeeded: [true], context: '' }],
      observability: { distinctId: 'doc-2026-07-12', traceId: 'conv-abc', properties: { source: 'test' } },
      onUsage: (u) => { usage = u; },
    });

    expect(usage?.promptTokenCount).toBe(2100);
    expect(usage?.cachedContentTokenCount).toBe(950);
    expect(usage?.callCount).toBe(2);

    // Every generation carries the trace/distinct-id tags so the conversation groups in PostHog.
    for (const call of generateContent.mock.calls) {
      expect(call[0].posthogTraceId).toBe('conv-abc');
      expect(call[0].posthogDistinctId).toBe('doc-2026-07-12');
      expect(call[0].posthogProperties).toEqual({ source: 'test' });
    }
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
    // Tells the resumed agent how to apply revisions — targeted first, whole-slide second.
    expect(prompt).toContain('revise_translation');
    expect(prompt).toContain('set_translations');
  });

  it('renders slides and their translations with real line breaks and matching ids', () => {
    const prompt = buildSeedConversationPrompt({
      slides: ['Silent night\nHoly night'],
      translations: { French: [{ text: 'Sainte nuit\nNuit paisible' }] },
    });

    expect(prompt).toContain('<slide id="0">\nSilent night\nHoly night\n</slide>');
    expect(prompt).toContain('<translations language="French">');
    expect(prompt).toContain('<slide id="0">\nSainte nuit\nNuit paisible\n</slide>');
    expect(prompt).not.toContain('\\n');
  });
});
