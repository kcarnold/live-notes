/**
 * How the server's own Yjs writers reach a session doc — the connection and the token
 * it connects with.
 *
 * These connect on their own schedule — the audio feeder can join a room, or the
 * Proclaim service can start, before any browser has opened the day's session. Y-Sweet's
 * plain `getClientToken` 404s on a doc that doesn't exist yet, so a writer that used it
 * would fail exactly on the unattended path it exists to serve. Create-or-get instead,
 * which is what `/api/ys-auth` already does for browsers and the Proclaim service: the
 * first arrival makes the doc, whoever that turns out to be.
 *
 * Both server-side writers — live transcripts and slide conversations — open their
 * connection the same way, and used to each spell it out. They had drifted: only one
 * waited for the initial sync, which is the difference between a considered overwrite
 * and a coin flip (see `synced`).
 */

import * as Y from 'yjs';
import { createYjsProvider } from '@y-sweet/client';
import type { ClientToken, DocumentManager } from '@y-sweet/sdk';

/** The `authCallback` to hand `createYjsProvider` for a server-side writer. */
export function serverDocTokenCallback(
  documentManager: DocumentManager,
  docId: string,
): () => Promise<ClientToken> {
  return () => documentManager.getOrCreateDocAndToken(docId);
}

/**
 * One server-side connection to a session's shared doc.
 *
 * The provider is deliberately not exposed: everything a caller legitimately wants from
 * it is here, and keeping the surface to `doc` / `synced` / `close` is what lets a test
 * stand in a plain local Y.Doc for the whole thing.
 */
export interface ServerDoc {
  /** The replica. Y-Sweet has no partial sync, so this is the *whole* session doc. */
  doc: Y.Doc;
  /**
   * Resolves once the initial Y-Sweet sync completes.
   *
   * Appending to a transcript can ignore this — appends merge. Anything that *sets* a
   * field cannot: a `Y.Map` set made before sync is concurrent with whatever the doc
   * already held, and Yjs settles concurrent sets by client id, so a pre-sync write is
   * a coin flip against a value that is actually in its causal past.
   */
  synced: Promise<void>;
  close(): void;
}

/** Connect to (or create) a session doc as a server-side writer. */
export function connectServerDoc(docId: string, documentManager: DocumentManager): ServerDoc {
  const doc = new Y.Doc();
  const provider = createYjsProvider(
    doc,
    docId,
    serverDocTokenCallback(documentManager, docId),
    { connect: true },
  );
  // `sync` fires when the initial sync completes (and on reconnects). Resolve at once if
  // we somehow already synced before attaching the listener.
  const synced = new Promise<void>((resolve) => {
    if (provider.synced) resolve();
    else provider.on('sync', () => resolve());
  });
  return {
    doc,
    synced,
    close() {
      provider.destroy();
      doc.destroy();
    },
  };
}
