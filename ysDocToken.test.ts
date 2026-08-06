import { describe, it, expect, vi } from 'vitest';
import type { DocumentManager } from '@y-sweet/sdk';
import { serverDocTokenCallback } from './ysDocToken.ts';

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
