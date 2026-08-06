/**
 * Yjs-backed store of slide-translation agent conversations.
 *
 * The agent runs server-side (it owns the Gemini loop), but the conversation now lives in
 * the per-day Y-Sweet doc under a `slideConversations` Y.Map keyed by conversation id
 * (Proclaim itemId, or a content hash for ad-hoc pastes). Two wins over the old in-memory
 * map: Y-Sweet persists the doc, so conversations survive a server restart; and every
 * watcher (the review screen, the Proclaim service) sees the agent's status, reasoning, and
 * tool calls stream in live, with no polling.
 *
 * Each conversation is stored as a single plain-object value; updates replace the whole
 * snapshot (the server is the sole writer, so there's no need for nested Y types). This
 * mirrors the server-side Yjs writer pattern already used for live transcripts
 * (live-audio/transcript-writer.ts).
 */
import { createHash } from 'crypto';
import * as Y from 'yjs';
import { createYjsProvider, type YSweetProvider } from '@y-sweet/client';
import type { DocumentManager } from '@y-sweet/sdk';
import type { Content } from '@google/genai';
import type { TokenUsage } from './nlp.ts';
import { serverDocTokenCallback } from './ysDocToken.ts';

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
  /**
   * Token usage summed across every agent run for this conversation (the initial draft plus
   * each follow-up). `cachedContentTokenCount` shows how much of the re-sent prompt Gemini's
   * context cache actually served — a running total stuck near 0 means we're paying full
   * price for the prefix on every round. Absent on conversations created before this existed.
   */
  usage?: TokenUsage;
  updatedAt: number;
}

/** Name of the Y.Map (within the per-day doc) that holds conversations by id. */
export const CONVERSATIONS_MAP = 'slideConversations';

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

// --- Pure Y.Map helpers ---------------------------------------------------------------
// These operate on a plain Y.Map and never touch the network, so they're unit-testable
// with a local Y.Doc. Values are stored/replaced as immutable plain objects (Yjs stores
// them as JSON-compatible values); callers must treat a read value as read-only and write
// a fresh object to update.

type ConversationMap = Y.Map<SlideConversation>;

/** Read a conversation snapshot, or undefined if there isn't one. */
export function readConversation(map: ConversationMap, id: string): SlideConversation | undefined {
  return map.get(id);
}

/** Create or replace a conversation, stamping `updatedAt`. Returns the stored snapshot. */
export function writeConversation(
  map: ConversationMap,
  conversation: Omit<SlideConversation, 'updatedAt'> & { updatedAt?: number },
): SlideConversation {
  const stored: SlideConversation = { ...conversation, updatedAt: Date.now() };
  map.set(conversation.itemId, stored);
  return stored;
}

/** Append a message to an existing conversation. No-op (undefined) if the id is unknown. */
export function appendMessageTo(
  map: ConversationMap,
  id: string,
  message: Content,
): SlideConversation | undefined {
  const existing = map.get(id);
  if (!existing) return undefined;
  const updated: SlideConversation = {
    ...existing,
    messages: [...existing.messages, message],
    updatedAt: Date.now(),
  };
  map.set(id, updated);
  return updated;
}

/** Update only the status of an existing conversation. No-op if the id is unknown. */
export function setStatusIn(
  map: ConversationMap,
  id: string,
  status: SlideConversationStatus,
): void {
  const existing = map.get(id);
  if (!existing) return;
  map.set(id, { ...existing, status, updatedAt: Date.now() });
}

// --- Connection manager ---------------------------------------------------------------

interface DocEntry {
  doc: Y.Doc;
  provider: YSweetProvider;
  /** Resolves once the initial Y-Sweet sync completes, so reads don't clobber the doc. */
  synced: Promise<void>;
}

/**
 * Manages one Y-Sweet provider per doc id and hands out the doc's `slideConversations`
 * Y.Map, already synced. Providers are opened lazily on first use and kept for the process
 * lifetime (there's typically one active doc per day; an idle-close policy can come later).
 */
export class SlideConversationStore {
  private documentManager: DocumentManager;
  private docs = new Map<string, DocEntry>();

  constructor(documentManager: DocumentManager) {
    this.documentManager = documentManager;
  }

  /**
   * Connect to (or reuse) the per-day doc and return its conversations map, waiting for the
   * initial sync so callers read real state rather than an empty doc.
   */
  async getConversationsMap(docId: string): Promise<ConversationMap> {
    let entry = this.docs.get(docId);
    if (!entry) {
      const doc = new Y.Doc();
      const provider = createYjsProvider(
        doc,
        docId,
        serverDocTokenCallback(this.documentManager, docId),
        { connect: true },
      );
      // `sync` fires when the initial sync completes (and on reconnects). Resolve at once if
      // we somehow already synced before attaching the listener.
      const synced = new Promise<void>((resolve) => {
        if (provider.synced) resolve();
        else provider.on('sync', () => resolve());
      });
      entry = { doc, provider, synced };
      this.docs.set(docId, entry);
    }
    await entry.synced;
    return entry.doc.getMap<SlideConversation>(CONVERSATIONS_MAP);
  }

  /** Tear down all providers (shutdown / tests). */
  close(): void {
    for (const { doc, provider } of this.docs.values()) {
      provider.destroy();
      doc.destroy();
    }
    this.docs.clear();
  }
}
