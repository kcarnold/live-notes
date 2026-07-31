/**
 * End-to-end tests for the AI SDK agent loop against a mock model.
 *
 * These are what let the port be trusted without spending money: the loop, the tool
 * plumbing, the JSON-Schema conversion, and the message round trip are all exercised, with
 * only the model itself faked. A scripted mock also lets us assert things a live model can't
 * be relied on to do on cue — like calling `revise_translation` with a `find` that appears
 * twice, and recovering.
 */
import { describe, expect, it, vi } from 'vitest';
import { scriptedModel } from './testing.ts';
import { runSlideTranslationAgent, toTokenUsage } from './slideAgent.ts';

const SLIDES = ['Amazing grace,\nhow sweet the sound', 'Praise God from whom all blessings flow'];

const setTranslations = (segments: Array<{ segmentId: number; translation: string }>) => ({
  name: 'set_translations',
  input: { languages: [{ language: 'French', segments }] },
});

const draftPrompt = [{ role: 'user' as const, parts: [{ text: 'translate these' }] }];

describe('runSlideTranslationAgent (AI SDK)', () => {
  it('records translations from set_translations and reports them per language', async () => {
    const { model } = scriptedModel([
      { toolCalls: [setTranslations([{ segmentId: 0, translation: 'Grâce infinie' }])] },
      { text: 'Done.' },
    ]);

    const result = await runSlideTranslationAgent({
      model,
      sourceSlides: SLIDES,
      messages: draftPrompt,
      bibleLanguages: [],
    });

    expect(result.setTranslationsCalled).toBe(true);
    expect(result.translations.French).toEqual([
      { sourceText: SLIDES[0], translatedText: 'Grâce infinie', language: 'French' },
    ]);
  });

  it('reports only the slides the run changed, not the ones it was seeded with', async () => {
    const { model } = scriptedModel([
      { toolCalls: [setTranslations([{ segmentId: 1, translation: 'Louez Dieu' }])] },
      { text: '' },
    ]);

    const result = await runSlideTranslationAgent({
      model,
      sourceSlides: SLIDES,
      messages: draftPrompt,
      bibleLanguages: [],
      currentTranslations: { French: ['Grâce infinie', null] },
    });

    expect(result.translations.French.map((block) => block.sourceText)).toEqual([SLIDES[1]]);
  });

  it('applies a targeted revise_translation to a seeded translation', async () => {
    const { model } = scriptedModel([
      {
        toolCalls: [
          {
            name: 'revise_translation',
            input: { language: 'French', segmentId: 0, find: 'infinie', replace: 'étonnante' },
          },
        ],
      },
      { text: 'Changed one word.' },
    ]);

    const result = await runSlideTranslationAgent({
      model,
      sourceSlides: SLIDES,
      messages: draftPrompt,
      bibleLanguages: [],
      currentTranslations: { French: ['Grâce infinie', 'Louez Dieu'] },
    });

    expect(result.translations.French).toEqual([
      { sourceText: SLIDES[0], translatedText: 'Grâce étonnante', language: 'French' },
    ]);
    expect(result.setTranslationsCalled).toBe(false);
  });

  it('returns the ambiguity error to the model instead of editing the wrong occurrence', async () => {
    const { model } = scriptedModel([
      {
        toolCalls: [
          { name: 'revise_translation', input: { language: 'French', segmentId: 0, find: 'la', replace: 'le' } },
        ],
      },
      { text: 'Understood.' },
    ]);

    const result = await runSlideTranslationAgent({
      model,
      sourceSlides: SLIDES,
      messages: draftPrompt,
      bibleLanguages: [],
      currentTranslations: { French: ['la grâce et la paix', 'Louez Dieu'] },
    });

    expect(result.translations).toEqual({});
    const toolTurn = result.messages.find((content) =>
      content.parts?.some((part) => part.functionResponse?.name === 'revise_translation'),
    );
    const response = toolTurn?.parts?.[0].functionResponse?.response as { error?: string };
    expect(response.error).toContain('more than once');
  });

  it('executes bible lookups and reports them through onToolCall', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          chapter: { number: 23, content: [{ type: 'verse', number: 1, content: ['Le Seigneur est mon berger'] }] },
        }),
        { status: 200 },
      ),
    );
    const calls: string[] = [];
    const { model } = scriptedModel([
      { toolCalls: [{ name: 'lookup_bible_passage', input: { book: 'PSA', chapter: 23, startVerse: 1 } }] },
      { toolCalls: [setTranslations([{ segmentId: 0, translation: 'Le Seigneur est mon berger' }])] },
      { text: 'Grounded in the published text.' },
    ]);

    const result = await runSlideTranslationAgent({
      model,
      sourceSlides: SLIDES,
      messages: draftPrompt,
      bibleLanguages: ['French'],
      onToolCall: (call) => calls.push(call.reference),
    });

    expect(calls).toEqual(['PSA 23:1']);
    expect(result.steps).toBe(3);
    fetchSpy.mockRestore();
  });

  it('does not offer the bible tool when no target language has a canonical translation', async () => {
    const { model, capturedOptions } = scriptedModel([{ text: 'nothing to do' }]);

    await runSlideTranslationAgent({ model, sourceSlides: SLIDES, messages: draftPrompt, bibleLanguages: [] });

    const toolNames = (capturedOptions[0].tools ?? []).map((entry) => entry.name);
    expect(toolNames).toEqual(['set_translations', 'revise_translation']);
  });

  it('sends the tool schemas as JSON Schema with lower-case types', async () => {
    const { model, capturedOptions } = scriptedModel([{ text: 'ok' }]);

    await runSlideTranslationAgent({ model, sourceSlides: SLIDES, messages: draftPrompt, bibleLanguages: [] });

    const setTool = (capturedOptions[0].tools ?? []).find((entry) => entry.name === 'set_translations');
    const schema = (setTool as { inputSchema: { type: string; properties: Record<string, { type: string }> } })
      .inputSchema;
    expect(schema.type).toBe('object');
    expect(schema.properties.languages.type).toBe('array');
  });

  it('appends the run to the conversation in the stored Gemini format', async () => {
    const { model } = scriptedModel([
      { toolCalls: [setTranslations([{ segmentId: 0, translation: 'Grâce infinie' }])] },
      { text: 'Done.' },
    ]);

    const result = await runSlideTranslationAgent({
      model,
      sourceSlides: SLIDES,
      messages: draftPrompt,
      bibleLanguages: [],
    });

    expect(result.messages[0]).toEqual(draftPrompt[0]);
    expect(result.messages.map((content) => content.role)).toEqual(['user', 'model', 'user', 'model']);
    expect(result.messages[1].parts?.[0].functionCall?.name).toBe('set_translations');
    expect(result.messages.at(-1)?.parts?.[0].text).toBe('Done.');
  });

  it('stops at maxSteps when the model keeps calling tools', async () => {
    const { model } = scriptedModel([
      { toolCalls: [setTranslations([{ segmentId: 0, translation: 'encore' }])] },
    ]);

    const result = await runSlideTranslationAgent({
      model,
      sourceSlides: SLIDES,
      messages: draftPrompt,
      bibleLanguages: [],
      maxSteps: 3,
    });

    expect(result.steps).toBe(3);
  });

  it('sums usage across steps, keeping cached input tokens visible', async () => {
    const { model } = scriptedModel([
      { toolCalls: [setTranslations([{ segmentId: 0, translation: 'Grâce infinie' }])] },
      { text: 'Done.' },
    ]);

    const result = await runSlideTranslationAgent({
      model,
      sourceSlides: SLIDES,
      messages: draftPrompt,
      bibleLanguages: [],
    });

    expect(result.usage.callCount).toBe(2);
    expect(result.usage.promptTokenCount).toBe(200);
    expect(result.usage.cachedContentTokenCount).toBe(20);
    expect(result.usage.candidatesTokenCount).toBe(40);
  });
});

describe('toTokenUsage', () => {
  it('maps the AI SDK usage shape onto the stored TokenUsage fields', () => {
    expect(
      toTokenUsage({
        inputTokens: 1000,
        outputTokens: 300,
        totalTokens: 1300,
        inputTokenDetails: { cacheReadTokens: 800 },
        outputTokenDetails: { reasoningTokens: 120 },
      }),
    ).toEqual({
      promptTokenCount: 1000,
      cachedContentTokenCount: 800,
      candidatesTokenCount: 300,
      thoughtsTokenCount: 120,
      totalTokenCount: 1300,
    });
  });

  it('records absent fields as zero, like the Gemini path does', () => {
    expect(toTokenUsage({})).toEqual({
      promptTokenCount: 0,
      cachedContentTokenCount: 0,
      candidatesTokenCount: 0,
      thoughtsTokenCount: 0,
      totalTokenCount: 0,
    });
  });
});
