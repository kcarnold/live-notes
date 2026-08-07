/**
 * Bridge between the stored conversation format and the AI SDK's message format.
 *
 * The slide-translation conversation is persisted as raw Gemini `Content[]` — in the per-day
 * Y-Sweet doc ([slideConversationStore.ts](../slideConversationStore.ts)) and rendered
 * part-by-part by the review screen ([SlideConversationPanel.tsx](../src/SlideConversationPanel.tsx),
 * which reads `part.functionCall` / `part.functionResponse` directly). Conversations from
 * previous services are already sitting in those docs.
 *
 * So a provider swap must not be a storage format change. The AI SDK agent converts on the
 * way in and back on the way out, leaving `Content[]` as the wire and disk format. That keeps
 * old conversations readable, keeps the review UI untouched, and — for the bench — means a
 * conversation drafted by one model can be resumed by another, which is the only way to
 * compare follow-up behaviour on identical history.
 *
 * ## What does not survive the round trip
 *
 * Gemini "thought" parts (`part.thought === true`) and their thought signatures are dropped.
 * They are opaque provider state, they are meaningless to any other provider, and the review
 * screen already hides them. Reasoning is therefore not replayed across a provider switch —
 * noted in [docs/llm-providers.md](../docs/llm-providers.md) as a real (small) cost of
 * routing rather than something this module can paper over.
 */
import type { Content, Part } from '@google/genai';
import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai';

/**
 * Deterministic id for a tool call that arrived without one.
 *
 * Gemini's `functionCall.id` is optional and is usually absent, but the AI SDK requires a
 * `toolCallId` on both the call and its result so it can pair them. Our agent loop always
 * emits one model turn of N calls followed by one user turn of N responses in the same
 * order, so position within the conversation is a sound identity — and being derived rather
 * than random keeps a converted conversation byte-stable across runs, which matters for
 * diffing bench output.
 */
const syntheticId = (name: string, turnIndex: number, partIndex: number): string =>
  `${name}-${turnIndex}-${partIndex}`;

/** True when every part of this turn is a function response (i.e. it's a tool turn). */
const isToolTurn = (parts: Part[]): boolean =>
  parts.length > 0 && parts.every((part) => part.functionResponse != null);

/**
 * Convert stored Gemini history into AI SDK messages.
 *
 * Tool call ids are assigned while walking and remembered per tool name, so the matching
 * `functionResponse` picks up the same id even though Gemini stored neither.
 */
export function toModelMessages(contents: Content[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  // tool name → ids of calls still awaiting a response, oldest first.
  const pendingCallIds = new Map<string, string[]>();

  contents.forEach((content, turnIndex) => {
    const parts = content.parts ?? [];

    if (content.role === 'model') {
      const assistantParts: Array<{ type: 'text'; text: string } | ToolCallPart> = [];
      parts.forEach((part, partIndex) => {
        if (part.thought) return; // provider-private reasoning; see module comment
        if (part.functionCall) {
          const name = part.functionCall.name ?? 'unknown';
          const id = part.functionCall.id ?? syntheticId(name, turnIndex, partIndex);
          const queue = pendingCallIds.get(name) ?? [];
          queue.push(id);
          pendingCallIds.set(name, queue);
          assistantParts.push({
            type: 'tool-call',
            toolCallId: id,
            toolName: name,
            input: part.functionCall.args ?? {},
          });
        } else if (typeof part.text === 'string' && part.text !== '') {
          assistantParts.push({ type: 'text', text: part.text });
        }
      });
      // A model turn that was nothing but thoughts converts to nothing at all; emitting an
      // assistant message with empty content is rejected by some providers.
      if (assistantParts.length > 0) messages.push({ role: 'assistant', content: assistantParts });
      return;
    }

    if (isToolTurn(parts)) {
      const results: ToolResultPart[] = parts.map((part, partIndex) => {
        const name = part.functionResponse?.name ?? 'unknown';
        const queue = pendingCallIds.get(name) ?? [];
        const id = part.functionResponse?.id ?? queue.shift() ?? syntheticId(name, turnIndex, partIndex);
        pendingCallIds.set(name, queue);
        return {
          type: 'tool-result',
          toolCallId: id,
          toolName: name,
          output: { type: 'json', value: (part.functionResponse?.response ?? {}) as never },
        };
      });
      messages.push({ role: 'tool', content: results });
      return;
    }

    const text = parts
      .filter((part) => !part.thought && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');
    if (text !== '') messages.push({ role: 'user', content: [{ type: 'text', text }] });
  });

  return messages;
}

/** Flatten AI SDK message content (which may be a bare string) into an array of parts. */
const contentParts = <T>(content: string | T[]): Array<T | { type: 'text'; text: string }> =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content;

/**
 * Convert AI SDK messages back into Gemini `Content[]` for storage.
 *
 * Tool results become a `user` turn of `functionResponse` parts, which is the shape the
 * existing loop, the store, and the review screen all already handle.
 */
export function toGeminiContents(messages: ModelMessage[]): Content[] {
  const contents: Content[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      // Our prompts put everything in the first user turn; a system message would have no
      // home in the stored format. Fold it in rather than dropping it silently.
      contents.push({ role: 'user', parts: [{ text: message.content }] });
      continue;
    }

    if (message.role === 'assistant') {
      const parts: Part[] = [];
      for (const part of contentParts(message.content)) {
        if (part.type === 'text' && part.text !== '') parts.push({ text: part.text });
        else if (part.type === 'tool-call') {
          parts.push({
            functionCall: {
              id: part.toolCallId,
              name: part.toolName,
              args: (part.input ?? {}) as Record<string, unknown>,
            },
          });
        }
        // reasoning / file / approval parts have no stored equivalent — see module comment.
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }

    if (message.role === 'tool') {
      const parts: Part[] = [];
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        parts.push({
          functionResponse: {
            id: part.toolCallId,
            name: part.toolName,
            response: toolOutputValue(part.output),
          },
        });
      }
      if (parts.length > 0) contents.push({ role: 'user', parts });
      continue;
    }

    const parts: Part[] = [];
    for (const part of contentParts(message.content)) {
      if (part.type === 'text' && part.text !== '') parts.push({ text: part.text });
    }
    if (parts.length > 0) contents.push({ role: 'user', parts });
  }

  return contents;
}

/**
 * Unwrap a tool result into the plain object Gemini's `functionResponse.response` expects.
 *
 * Our tools all return JSON objects, but the AI SDK also models text / error outputs, and a
 * bare value would break `SlideConversationPanel`'s `summarizeResponse`, which indexes into
 * the response object.
 */
function toolOutputValue(output: ToolResultPart['output']): Record<string, unknown> {
  switch (output.type) {
    case 'json':
    case 'error-json':
      return (output.value ?? {}) as Record<string, unknown>;
    case 'text':
      return { text: output.value };
    case 'error-text':
      return { error: output.value };
    default:
      return {};
  }
}
