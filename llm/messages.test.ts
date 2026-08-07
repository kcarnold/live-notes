import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import type { ModelMessage } from 'ai';
import { toGeminiContents, toModelMessages } from './messages.ts';

/** A draft-then-revise conversation in the shape our agent loop actually produces. */
const conversation: Content[] = [
  { role: 'user', parts: [{ text: 'Translate these slides.' }] },
  {
    role: 'model',
    parts: [
      { text: 'Looking up the passage first.' },
      { functionCall: { name: 'lookup_bible_passage', args: { book: 'PSA', chapter: 23 } } },
    ],
  },
  {
    role: 'user',
    parts: [
      { functionResponse: { name: 'lookup_bible_passage', response: { reference: 'PSA 23', passages: { French: '…' } } } },
    ],
  },
  {
    role: 'model',
    parts: [
      {
        functionCall: {
          name: 'set_translations',
          args: { languages: [{ language: 'French', segments: [{ segmentId: 0, translation: 'Bonjour' }] }] },
        },
      },
    ],
  },
  { role: 'user', parts: [{ functionResponse: { name: 'set_translations', response: { ok: true } } }] },
  { role: 'model', parts: [{ text: 'Done.' }] },
];

describe('toModelMessages', () => {
  it('maps roles onto the AI SDK message kinds', () => {
    const messages = toModelMessages(conversation);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('pairs each tool result with the id of the call it answers', () => {
    const messages = toModelMessages(conversation);

    const assistant = messages[1];
    const toolTurn = messages[2];
    if (assistant.role !== 'assistant' || toolTurn.role !== 'tool') throw new Error('unexpected shape');
    const call = (assistant.content as Array<{ type: string; toolCallId?: string }>).find(
      (part) => part.type === 'tool-call',
    );

    const firstResult = toolTurn.content[0];
    expect(call?.toolCallId).toBeTruthy();
    expect(firstResult.type === 'tool-result' ? firstResult.toolCallId : undefined).toBe(call?.toolCallId);
  });

  it('gives calls of the same tool in different turns distinct ids', () => {
    const messages = toModelMessages(conversation);
    const ids = messages
      .filter((message) => message.role === 'tool')
      .flatMap((message) =>
        message.role === 'tool'
          ? message.content.flatMap((part) => (part.type === 'tool-result' ? [part.toolCallId] : []))
          : [],
      );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('drops thought parts but keeps the rest of the turn', () => {
    const messages = toModelMessages([
      { role: 'model', parts: [{ text: 'private reasoning', thought: true }, { text: 'visible' }] },
    ]);
    expect(messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'visible' }] }]);
  });

  it('emits nothing for a turn that was only thoughts', () => {
    expect(toModelMessages([{ role: 'model', parts: [{ text: 'hmm', thought: true }] }])).toEqual([]);
  });
});

describe('toGeminiContents', () => {
  it('round-trips a full agent conversation back to the stored format', () => {
    const roundTripped = toGeminiContents(toModelMessages(conversation));

    // Ids are added on the way back (Gemini's are optional and were absent); compare on the
    // parts the store and the review screen actually read.
    expect(roundTripped.map((content) => content.role)).toEqual(conversation.map((content) => content.role));
    expect(roundTripped[1].parts?.[1].functionCall?.name).toBe('lookup_bible_passage');
    expect(roundTripped[1].parts?.[1].functionCall?.args).toEqual({ book: 'PSA', chapter: 23 });
    expect(roundTripped[2].parts?.[0].functionResponse?.response).toEqual({
      reference: 'PSA 23',
      passages: { French: '…' },
    });
    expect(roundTripped[5].parts?.[0].text).toBe('Done.');
  });

  it('keeps tool results as a user turn of functionResponse parts', () => {
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'a', toolName: 'set_translations', output: { type: 'json', value: { ok: true } } },
        ],
      },
    ];
    expect(toGeminiContents(messages)).toEqual([
      { role: 'user', parts: [{ functionResponse: { id: 'a', name: 'set_translations', response: { ok: true } } }] },
    ]);
  });

  it('wraps non-JSON tool output so the review screen still gets an object', () => {
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'a', toolName: 'revise_translation', output: { type: 'error-text', value: 'boom' } },
        ],
      },
    ];
    expect(toGeminiContents(messages)[0].parts?.[0].functionResponse?.response).toEqual({ error: 'boom' });
  });

  it('folds a system message into a user turn, since the stored format has no system role', () => {
    expect(toGeminiContents([{ role: 'system', content: 'be careful' }])).toEqual([
      { role: 'user', parts: [{ text: 'be careful' }] },
    ]);
  });

  it('accepts string content as well as part arrays', () => {
    expect(toGeminiContents([{ role: 'assistant', content: 'plain' }])).toEqual([
      { role: 'model', parts: [{ text: 'plain' }] },
    ]);
  });
});
