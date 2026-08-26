import { describe, it, expect, vi } from 'vitest';
import type { DocumentManager } from '@y-sweet/sdk';
import { connectServerDoc, serverDocTokenCallback } from './serverDoc.ts';

// The provider is the one thing here that needs a server; everything else about a
// connection — when it reports synced, what close() tears down — is ours to get right.
const providers: Array<{
  synced: boolean;
  handlers: Record<string, Array<() => void>>;
  destroy: ReturnType<typeof vi.fn>;
}> = [];
// Whether the next provider is born already synced — the race we can't otherwise stage.
const state = vi.hoisted(() => ({ syncedOnCreate: false }));
vi.mock('@y-sweet/client', () => ({
  createYjsProvider: () => {
    const provider = {
      synced: state.syncedOnCreate,
      handlers: {} as Record<string, Array<() => void>>,
      on(event: string, fn: () => void) {
        (this.handlers[event] ??= []).push(fn);
      },
      destroy: vi.fn(),
    };
    providers.push(provider);
    return provider;
  },
}));

/**
 * The failure this guards: the audio feeder joins the LiveKit room before any editor has
 * opened the day's page, the session manager starts a bridge, and its transcript writer
 * asks Y-Sweet for a token for a doc that doesn't exist yet. `getClientToken` 404s there;
 * `getOrCreateDocAndToken` creates it.
 */
describe('serverDocTokenCallback', () => {
  it('creates the doc if it does not exist yet, rather than requiring one', async () => {
    const getOrCreateDocAndToken = vi.fn().mockResolvedValue({ url: 'ws://y', docId: 'd', token: 't' });
    const getClientToken = vi.fn().mockRejectedValue(new Error('404 Not Found'));
    const dm = { getOrCreateDocAndToken, getClientToken } as unknown as DocumentManager;

    const token = await serverDocTokenCallback(dm, 'doc-2026-08-06')();

    expect(getOrCreateDocAndToken).toHaveBeenCalledWith('doc-2026-08-06');
    expect(getClientToken).not.toHaveBeenCalled();
    expect(token.docId).toBe('d');
  });
});

/**
 * Why `synced` is part of the contract rather than each caller's business: a `Y.Map`
 * set made before the initial sync is *concurrent* with whatever the doc already held,
 * and Yjs settles concurrent sets by client id. The transcript path could ignore this
 * (appends merge); the moment anything sets a field — the session's spoken language —
 * a pre-sync write becomes a coin flip against a value already in its causal past.
 */
describe('connectServerDoc', () => {
  const dm = {
    getOrCreateDocAndToken: vi.fn().mockResolvedValue({ url: 'ws://y', docId: 'd', token: 't' }),
  } as unknown as DocumentManager;

  it('resolves synced once the provider reports the initial sync', async () => {
    providers.length = 0;
    state.syncedOnCreate = false;
    const entry = connectServerDoc('doc-2026-08-06', dm);

    let settled = false;
    void entry.synced.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    providers[0].handlers.sync.forEach((fn) => fn());
    await entry.synced;
    expect(settled).toBe(true);
  });

  it('resolves synced immediately if the provider synced before we listened', async () => {
    providers.length = 0;
    state.syncedOnCreate = true;
    try {
      // Nothing will fire the event: a listener-only implementation waits forever here.
      const entry = connectServerDoc('doc-2026-08-06', dm);
      await expect(
        Promise.race([entry.synced, Promise.resolve('pending')])
      ).resolves.toBeUndefined();
      entry.close();
    } finally {
      state.syncedOnCreate = false;
    }
  });

  it('tears down both halves on close', () => {
    providers.length = 0;
    const entry = connectServerDoc('doc-2026-08-06', dm);
    const destroyed = vi.fn();
    entry.doc.on('destroy', destroyed);

    entry.close();

    expect(providers[0].destroy).toHaveBeenCalled();
    expect(destroyed).toHaveBeenCalled();
  });
});
