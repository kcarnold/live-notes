/**
 * In-memory store of live note-synthesis conversations, keyed by session (doc) id.
 *
 * Note synthesis runs as one continuous Gemini conversation per talk (see
 * `synthesizeNotesTurn` in nlp.ts): each turn appends the new transcript slice + current
 * outline and gets back proposed blocks. The conversation lives here so the growing,
 * cache-friendly prefix survives across the editor's per-turn requests without the client
 * resending the whole history.
 *
 * Deliberately ephemeral and thin — a placeholder for whatever the conversation-storage
 * decision settles on (a Gemini server-managed session, or Yjs alongside the slide
 * conversations). Losing it on restart just means the next turn starts a fresh conversation
 * seeded from the current Yjs outline; the outline blocks themselves are durable in Yjs.
 */
import type { Content } from '@google/genai';

interface NoteSynthSession {
  messages: Content[];
  updatedAt: number;
}

export class NoteSynthSessionStore {
  private bySession = new Map<string, NoteSynthSession>();

  /** Return the conversation history for a session, creating an empty one if needed. */
  ensure(sessionId: string): Content[] {
    let session = this.bySession.get(sessionId);
    if (!session) {
      session = { messages: [], updatedAt: Date.now() };
      this.bySession.set(sessionId, session);
    }
    return session.messages;
  }

  /** Stamp the session as just used (call after a turn mutates its messages in place). */
  touch(sessionId: string): void {
    const session = this.bySession.get(sessionId);
    if (session) session.updatedAt = Date.now();
  }

  /** Drop a session's history so the next turn starts a fresh conversation. */
  reset(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
