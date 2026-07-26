import { useState } from 'react';
import type { Content, SlideConversation, TokenUsage } from './slideTranslationApi';
import { chipClass, primaryButtonClass, subtleTextClass } from './slideReviewStyles';
import { useStrings } from './useLocale';

/**
 * Pure renderer for a slide-translation agent conversation: the agent's text, its tool
 * calls (Bible lookups, set_translations), reviewer follow-ups, and manual-edit notes —
 * plus an input box to send a follow-up. Thought parts are hidden; the raw history is kept
 * server-side for replay.
 */

type Part = NonNullable<Content['parts']>[number];

function partKey(prefix: string, i: number): string {
  return `${prefix}-${i}`;
}

/** Short, human-readable summary of a function call. */
function summarizeCall(call: NonNullable<Part['functionCall']>): string {
  const args = (call.args ?? {}) as {
    book?: string;
    chapter?: number;
    startVerse?: number;
    endVerse?: number;
    languages?: Array<{ language?: string; segments?: unknown[] }>;
    language?: string;
    segmentId?: number;
    find?: string;
  };
  if (call.name === 'lookup_bible_passage') {
    const book = args.book ?? '';
    const chapter = args.chapter ?? '';
    const start = args.startVerse;
    const end = args.endVerse;
    const verses = start ? `:${start}${end && end !== start ? `-${end}` : ''}` : '';
    return `📖 ${book} ${chapter}${verses}`.trim();
  }
  if (call.name === 'set_translations') {
    const langs = args.languages ?? [];
    const summary = langs
      .map((l) => `${l.language ?? '?'} (${l.segments?.length ?? 0})`)
      .join(', ');
    return `✍️ set translations: ${summary}`;
  }
  if (call.name === 'revise_translation') {
    // Show what was targeted, not the replacement — the new text lands in the grid anyway.
    const find = (args.find ?? '').replace(/\s+/g, ' ').trim();
    const excerpt = find.length > 40 ? `${find.slice(0, 40)}…` : find;
    return `✏️ edit ${args.language ?? '?'} slide ${(args.segmentId ?? 0) + 1}: "${excerpt}"`;
  }
  return `🔧 ${call.name ?? 'tool'}`;
}

/** Short summary of a tool result (Bible passages found/missing, or set_translations ack). */
function summarizeResponse(resp: NonNullable<Part['functionResponse']>): string | null {
  const response = (resp.response ?? {}) as {
    error?: string;
    reference?: string;
    passages?: Record<string, string>;
  };
  if (resp.name === 'lookup_bible_passage') {
    if (response.error) return `⚠ ${response.error}`;
    const passages = response.passages ?? {};
    const langs = Object.keys(passages);
    return langs.length ? `✓ ${response.reference ?? ''} — ${langs.join(', ')}` : null;
  }
  // A failed targeted edit is worth showing: it means the agent's "find" missed, and the
  // retry that follows is otherwise unexplained.
  if (resp.name === 'revise_translation' && response.error) return `⚠ ${response.error}`;
  return null; // successful acks and unknowns add no useful detail
}

function MessageParts({ message, msgKey }: { message: Content; msgKey: string }) {
  const parts = message.parts ?? [];
  const rendered = parts
    .map((part, i) => {
      if (part.thought) return null;
      if (part.functionCall) {
        return (
          <span
            key={partKey(`${msgKey}-call`, i)}
            className="inline-block px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200 text-xs font-mono"
          >
            {summarizeCall(part.functionCall)}
          </span>
        );
      }
      if (part.functionResponse) {
        const summary = summarizeResponse(part.functionResponse);
        if (!summary) return null;
        return (
          <span key={partKey(`${msgKey}-resp`, i)} className={chipClass}>
            {summary}
          </span>
        );
      }
      const text = (part.text ?? '').trim();
      if (!text) return null;
      return (
        <p key={partKey(`${msgKey}-text`, i)} className="whitespace-pre-wrap text-sm">
          {text}
        </p>
      );
    })
    .filter(Boolean);
  if (rendered.length === 0) return null;
  return <div className="flex flex-col gap-1">{rendered}</div>;
}

/**
 * One-line token summary: total prompt/output tokens, how many were served from Gemini's
 * context cache, and the model-call count. The cache figure is the whole point — if it stays
 * near 0 while prompt tokens are large, the re-sent prompt isn't being cached and cost is
 * higher than it should be.
 */
function UsageSummary({ usage }: { usage: TokenUsage }) {
  const cachePct =
    usage.promptTokenCount > 0
      ? Math.round((usage.cachedContentTokenCount / usage.promptTokenCount) * 100)
      : 0;
  return (
    <p className="text-xs text-gray-400 dark:text-gray-500 font-mono" title="Token usage across all agent runs for this item">
      {usage.promptTokenCount.toLocaleString()} in
      {' · '}
      {usage.candidatesTokenCount.toLocaleString()} out
      {' · '}
      {usage.cachedContentTokenCount.toLocaleString()} cached ({cachePct}%)
      {' · '}
      {usage.callCount} {usage.callCount === 1 ? 'call' : 'calls'}
    </p>
  );
}

export interface SlideConversationPanelProps {
  conversation: SlideConversation | null;
  busy: boolean;
  editable: boolean;
  onSend: (text: string) => void;
}

export function SlideConversationPanel({
  conversation,
  busy,
  editable,
  onSend,
}: SlideConversationPanelProps) {
  const s = useStrings();
  const [draft, setDraft] = useState('');

  // Skip the first message: it's the constructed translation prompt (the big slides blob),
  // not something a reviewer needs to read.
  const visible = (conversation?.messages ?? []).slice(1);

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };

  return (
    <div className="flex flex-col gap-2 border-t border-gray-200 dark:border-gray-700 pt-2">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-200">
          {s.conversationHeader}
        </h3>
        {conversation?.status === 'running' && (
          <span className="text-xs text-blue-600 dark:text-blue-400">{s.agentThinking}</span>
        )}
        {conversation?.usage && conversation.usage.callCount > 0 && (
          <span className="ml-auto">
            <UsageSummary usage={conversation.usage} />
          </span>
        )}
      </div>

      {visible.length === 0 ? (
        <p className={subtleTextClass}>{s.noConversation}</p>
      ) : (
        <ul className="flex flex-col gap-2 max-h-72 overflow-auto">
          {visible.map((message, i) => {
            const isModel = message.role === 'model';
            const content = <MessageParts message={message} msgKey={`m${i}`} />;
            if (!content) return null;
            return (
              <li
                key={`m${i}`}
                className={`rounded p-2 text-gray-800 dark:text-gray-100 ${
                  isModel
                    ? 'bg-gray-100 dark:bg-gray-800'
                    : 'bg-blue-50 dark:bg-blue-950 ml-6'
                }`}
              >
                {content}
              </li>
            );
          })}
        </ul>
      )}

      {editable && conversation && (
        <div className="flex items-start gap-2">
          <textarea
            className="flex-1 min-h-10 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 p-2 text-sm"
            placeholder={s.followUpPlaceholder}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <button
            type="button"
            className={primaryButtonClass}
            onClick={handleSend}
            disabled={busy || draft.trim() === ''}
          >
            {s.sendMessage}
          </button>
        </div>
      )}
    </div>
  );
}

export default SlideConversationPanel;
