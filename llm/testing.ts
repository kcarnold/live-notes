/**
 * A scripted language model for tests.
 *
 * Not test code itself (it ships no assertions) but test *support*: it lets the agent loop,
 * the bench tasks, and the report be exercised end to end without an API key, which is the
 * only way any of that gets covered in CI. Kept beside the code it fakes so the two stay in
 * step when the AI SDK's mock shape changes.
 */
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModel } from 'ai';

/** One scripted model turn: either a set of tool calls, or a final text reply. */
export type ScriptedTurn = { toolCalls: Array<{ name: string; input: unknown }> } | { text: string };

/** Token usage every scripted turn reports, in the provider-level (V4) shape. */
const scriptedUsage = () => ({
  inputTokens: { total: 100, noCache: 90, cacheRead: 10, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
});

export interface ScriptedModel {
  model: LanguageModel;
  /** What the SDK actually sent, per call — tools, prompt, settings. */
  capturedOptions: Array<{ tools?: Array<{ name: string; inputSchema?: unknown }> }>;
  /** How many times the model was called. */
  callCount: () => number;
}

/**
 * Build a model that replays `turns` in order and then repeats the last one.
 *
 * Repeating rather than erroring is what lets a test drive the loop into its `maxSteps` cap:
 * a model that keeps calling tools forever is a real failure mode, and the cap is the thing
 * standing between it and the API bill.
 */
export function scriptedModel(turns: ScriptedTurn[]): ScriptedModel {
  const capturedOptions: ScriptedModel['capturedOptions'] = [];
  let index = 0;

  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      capturedOptions.push(options as ScriptedModel['capturedOptions'][number]);
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;

      if ('text' in turn) {
        return {
          content: [{ type: 'text' as const, text: turn.text }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: scriptedUsage(),
          warnings: [],
        };
      }
      return {
        content: turn.toolCalls.map((call, position) => ({
          type: 'tool-call' as const,
          toolCallId: `call-${index}-${position}`,
          toolName: call.name,
          input: JSON.stringify(call.input),
        })),
        finishReason: { unified: 'tool-calls' as const, raw: undefined },
        usage: scriptedUsage(),
        warnings: [],
      };
    },
  });

  return { model, capturedOptions, callCount: () => index };
}

/**
 * A model that answers with one JSON object, for the structured-output (notes) path.
 *
 * `Output.object` asks the model for text and parses it, so the fake just returns the JSON
 * as its text content.
 */
export function jsonModel(value: unknown): LanguageModel {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: scriptedUsage(),
      warnings: [],
    }),
  });
}
