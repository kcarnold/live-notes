/**
 * Token supplier for the server's own Yjs writers (transcripts, slide conversations).
 *
 * These connect on their own schedule — the audio feeder can join a room, or the
 * Proclaim service can start, before any browser has opened the day's session. Y-Sweet's
 * plain `getClientToken` 404s on a doc that doesn't exist yet, so a writer that used it
 * would fail exactly on the unattended path it exists to serve. Create-or-get instead,
 * which is what `/api/ys-auth` already does for browsers and the Proclaim service: the
 * first arrival makes the doc, whoever that turns out to be.
 */

import type { ClientToken, DocumentManager } from '@y-sweet/sdk';

/** The `authCallback` to hand `createYjsProvider` for a server-side writer. */
export function serverDocTokenCallback(
  documentManager: DocumentManager,
  docId: string,
): () => Promise<ClientToken> {
  return () => documentManager.getOrCreateDocAndToken(docId);
}
