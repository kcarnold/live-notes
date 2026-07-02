import { describe, it, expect, vi } from 'vitest';
import {
  draftItemTranslations,
  buildSeedConversationPrompt,
  parseProposedBlocks,
  synthesizeNotesTurn,
  GeminiProvider,
  emptyUsage,
  addUsage,
  mergeUsage,
} from './nlp.ts';
import type { OutlineSnapshotBlock } from './nlp.ts';

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
    // Tells the resumed agent how to apply revisions.
    expect(prompt).toContain('set_translations');
  });
});

/** A provider whose model returns the given JSON text as its structured response. */
function fakeJsonProvider(text: string): {
  provider: GeminiProvider;
  generateContent: ReturnType<typeof vi.fn>;
} {
  const generateContent = vi.fn().mockResolvedValue({
    text,
    candidates: [{ content: { role: 'model', parts: [{ text }] } }],
  });
  const provider = {
    apiClient: { models: { generateContent } },
    defaultModel: 'fake-model',
    maxTokens: 1000,
  } as unknown as GeminiProvider;
  return { provider, generateContent };
}

describe('parseProposedBlocks', () => {
  it('parses well-formed blocks and clamps level', () => {
    const blocks = parseProposedBlocks(
      JSON.stringify({ blocks: [{ type: 'heading', level: 9, content: 'Intro' }, { type: 'bullet', level: 1, content: 'A point' }] })
    );
    expect(blocks).toEqual([
      { type: 'heading', level: 5, content: 'Intro' },
      { type: 'bullet', level: 1, content: 'A point' },
    ]);
  });

  it('returns an empty array for an empty proposal (quiet turn)', () => {
    expect(parseProposedBlocks(JSON.stringify({ blocks: [] }))).toEqual([]);
  });

  it('is tolerant of bad JSON and missing fields', () => {
    expect(parseProposedBlocks('not json')).toEqual([]);
    expect(parseProposedBlocks(undefined)).toEqual([]);
    expect(parseProposedBlocks(JSON.stringify({ blocks: [{ level: 0, content: '' }, { content: 'x' }] })))
      .toEqual([{ type: 'bullet', level: 0, content: 'x' }]); // empty dropped, missing type -> bullet
  });
});

describe('synthesizeNotesTurn', () => {
  const outline: OutlineSnapshotBlock[] = [
    { type: 'heading', level: 0, content: 'Welcome', status: 'confirmed' },
  ];

  it('prepends standing instructions on the first turn and returns parsed blocks', async () => {
    const { provider, generateContent } = fakeJsonProvider(
      JSON.stringify({ blocks: [{ type: 'bullet', level: 0, content: 'New idea' }] })
    );
    const messages: never[] = [];
    const result = await synthesizeNotesTurn(provider, {
      messages,
      newTranscript: 'The speaker introduces a new idea.',
      outline,
    });

    expect(result.blocks).toEqual([{ type: 'bullet', level: 0, content: 'New idea' }]);
    // First user turn carries the instructions, the outline, and the transcript.
    const firstUserText = generateContent.mock.calls[0][0].contents[0].parts[0].text as string;
    expect(firstUserText).toContain('live outline of a talk');
    expect(firstUserText).toContain('[CONFIRMED]');
    expect(firstUserText).toContain('new idea');
    // History grows: user turn + model turn kept verbatim.
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'model']);
  });

  it('omits instructions on later turns and can propose nothing', async () => {
    const { provider, generateContent } = fakeJsonProvider(JSON.stringify({ blocks: [] }));
    // A continuing conversation already has history.
    const messages = [
      { role: 'user', parts: [{ text: 'earlier' }] },
      { role: 'model', parts: [{ text: '{"blocks":[]}' }] },
    ];
    const result = await synthesizeNotesTurn(provider, {
      messages,
      newTranscript: 'um, so, yeah',
      outline,
    });

    expect(result.blocks).toEqual([]);
    expect(generateContent).toHaveBeenCalledTimes(1);
    // The turn we appended is the last user message (a model turn is added after the call).
    const userTurns = result.messages.filter((m) => m.role === 'user');
    const laterUserText = userTurns.at(-1)?.parts?.[0].text as string;
    expect(laterUserText).not.toContain('live outline of a talk');
    expect(laterUserText).toContain('<transcript>');
  });
});
