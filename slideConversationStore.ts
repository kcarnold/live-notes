/**
 * In-memory store of slide-translation agent conversations, keyed by Proclaim itemId.
 *
 * The agent runs server-side (it owns the Gemini loop), so the server owns the
 * conversation. The review screen pulls it down to show the agent's reasoning, tool
 * calls (Bible lookups, set_translations), and any commentary, and posts follow-up
 * messages that resume the agent.
 *
 * Deliberately ephemeral: conversations live only for the current process and are tied
 * to a per-day service. Losing them on restart just means re-running the agent — the
 * translations themselves are durable in the slideTranslations Y.Map and the library.
 */
import { createHash } from 'crypto';
import type { Content } from '@google/genai';

export type SlideConversationStatus = 'running' | 'idle' | 'error';

export interface SlideConversation {
  itemId: string;
  itemTitle: string;
  /** Snapshot of the source slides at translation time (segmentId indexes this array). */
  slides: string[];
  /** Hash of `slides`, for staleness checks against the live proclaimPresentations entry. */
  slidesHash: string;
  languages: string[];
  /** Raw Gemini history, stored verbatim so a resume replays the agent faithfully. */
  messages: Content[];
  status: SlideConversationStatus;
  updatedAt: number;
}

/**
 * Content hash of an item's slides. Mirrors the Python `slides_hash` exactly (SHA256 over
 * each slide's UTF-8 bytes followed by a NUL separator) so a conversation's snapshot hash
 * can be compared with the `slidesHash` the Proclaim service writes into
 * proclaimPresentations.
 */
export function slidesHash(slides: string[]): string {
  const hash = createHash('sha256');
  for (const slide of slides) {
    hash.update(slide, 'utf-8');
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

export class SlideConversationStore {
  private byItem = new Map<string, SlideConversation>();

  get(itemId: string): SlideConversation | undefined {
    return this.byItem.get(itemId);
  }

  /** Create or replace the conversation for an item. Stamps `updatedAt`. */
  upsert(
    conversation: Omit<SlideConversation, 'updatedAt'> & { updatedAt?: number },
  ): SlideConversation {
    const stored: SlideConversation = { ...conversation, updatedAt: Date.now() };
    this.byItem.set(conversation.itemId, stored);
    return stored;
  }

  /** Append a message to an existing conversation. No-op if the item is unknown. */
  appendMessage(itemId: string, message: Content): SlideConversation | undefined {
    const conversation = this.byItem.get(itemId);
    if (!conversation) return undefined;
    conversation.messages.push(message);
    conversation.updatedAt = Date.now();
    return conversation;
  }

  setStatus(itemId: string, status: SlideConversationStatus): void {
    const conversation = this.byItem.get(itemId);
    if (!conversation) return;
    conversation.status = status;
    conversation.updatedAt = Date.now();
  }
}
