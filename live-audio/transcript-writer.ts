/**
 * TranscriptWriter: a server-side Yjs writer that persists live translation
 * transcripts into the session's shared Y-Sweet doc, so any viewer — including
 * late joiners — can read the full transcript history.
 *
 * One writer per session (doc), shared by all of that session's TranslationBridges.
 * Each language's transcript accumulates in a `liveTranscript-{code}` Y.Text:
 * Gemini Live Translate streams a continuous flow of transcription deltas (it has
 * no "turns", so no turnComplete to flush on), so we append each delta verbatim
 * and start a fresh paragraph after sentence-ending punctuation. The Y.Text is the
 * single source of truth — there is no separate ephemeral interim stream.
 *
 * Mirrors the Proclaim service's "external process writes into Yjs" pattern, but
 * in-process on the Node server using the same Y-Sweet DocumentManager that issues
 * client tokens.
 */

import * as Y from "yjs";
import { createYjsProvider, type YSweetProvider } from "@y-sweet/client";
import type { DocumentManager } from "@y-sweet/sdk";

const KEY_PREFIX = "liveTranscript-";

/**
 * Whether a transcription delta ends an utterance, used to start a new paragraph.
 * Cheap heuristic: the trimmed text ends with sentence-ending punctuation,
 * optionally followed by a closing quote or bracket. Abbreviations ("Dr.") may
 * split a paragraph early — acceptable for a live transcript.
 */
export function endsSentence(text: string): boolean {
  return /[.!?…。！？][")'\]]?\s*$/.test(text);
}

export class TranscriptWriter {
  public readonly docId: string;
  private doc = new Y.Doc();
  private provider: YSweetProvider;

  constructor(docId: string, documentManager: DocumentManager) {
    this.docId = docId;
    this.provider = createYjsProvider(
      this.doc,
      docId,
      () => documentManager.getClientToken(docId),
      { connect: true }
    );
  }

  /**
   * Append a streamed transcription delta for a language. The delta is inserted
   * verbatim (no trimming — inter-delta spacing is significant), and a paragraph
   * break is added once a sentence finishes so the client renders readable
   * paragraphs. Edits made before the initial sync are merged by Yjs.
   */
  appendDelta(code: string, text: string): void {
    if (!text) return;
    const ytext = this.doc.getText(`${KEY_PREFIX}${code}`);
    ytext.insert(ytext.length, text);
    // Start a new paragraph after a completed sentence, unless the delta already
    // ended with a newline (so we don't stack blank lines).
    if (endsSentence(text) && !ytext.toString().endsWith("\n")) {
      ytext.insert(ytext.length, "\n\n");
    }
  }

  close(): void {
    this.provider.destroy();
    this.doc.destroy();
  }
}
