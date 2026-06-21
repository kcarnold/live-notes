/**
 * TranscriptWriter: a server-side Yjs writer that persists live translation
 * transcripts into the session's shared Y-Sweet doc, so any viewer — including
 * late joiners — can read the full, stable transcript history.
 *
 * One writer per session (doc), shared by all of that session's TranslationBridges.
 * Each language's finalized segments accumulate in a `liveTranscript-{code}`
 * Y.Text; the client renders those as stable, chunked paragraphs. In-progress
 * (interim) lines are NOT written here — they stay ephemeral on the LiveKit data
 * channel to avoid bloating the persisted doc.
 *
 * Mirrors the Proclaim service's "external process writes into Yjs" pattern, but
 * in-process on the Node server using the same Y-Sweet DocumentManager that issues
 * client tokens.
 */

import * as Y from "yjs";
import { createYjsProvider, type YSweetProvider } from "@y-sweet/client";
import type { DocumentManager } from "@y-sweet/sdk";

const KEY_PREFIX = "liveTranscript-";

export class TranscriptWriter {
  public readonly docId: string;
  private doc = new Y.Doc();
  private provider: YSweetProvider;
  private ready: Promise<void>;

  constructor(docId: string, documentManager: DocumentManager) {
    this.docId = docId;
    this.provider = createYjsProvider(
      this.doc,
      docId,
      () => documentManager.getClientToken(docId),
      { connect: true }
    );

    this.ready = new Promise<void>((resolve) => {
      if (this.provider.synced) {
        resolve();
        return;
      }
      this.provider.once("synced", () => resolve());
    });
  }

  /** Resolve once the initial sync with Y-Sweet is complete. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Append a finalized transcript segment for a language, separated by a blank line. */
  appendSegment(code: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ytext = this.doc.getText(`${KEY_PREFIX}${code}`);
    const separator = ytext.length > 0 ? "\n\n" : "";
    ytext.insert(ytext.length, separator + trimmed);
  }

  /**
   * Clear every language's transcript. Called when a fresh talk begins so the
   * day-scoped doc doesn't show a previous service's transcript to late joiners.
   * Waits for the initial sync first, otherwise server state would re-populate
   * the texts right after we clear them.
   */
  async clearAll(): Promise<void> {
    await this.ready;
    for (const key of this.doc.share.keys()) {
      if (!key.startsWith(KEY_PREFIX)) continue;
      const ytext = this.doc.getText(key);
      if (ytext.length > 0) ytext.delete(0, ytext.length);
    }
  }

  close(): void {
    this.provider.destroy();
    this.doc.destroy();
  }
}
