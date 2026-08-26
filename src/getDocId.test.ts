/**
 * The client half of #111: this file's job is to *not* have an opinion about which doc is
 * current, beyond the `?doc=` escape hatch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  getDocId,
  getDocOverride,
  resetResolvedSession,
  resolveCurrentSession,
} from './getDocId';

/** Point `window.location.search` at a query string. */
function setSearch(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  resetResolvedSession();
  setSearch('');
});

describe('before resolution', () => {
  it('refuses to guess a doc id rather than inventing today', () => {
    expect(() => getDocId()).toThrow(/before the current session was resolved/);
  });
});

describe('resolveCurrentSession', () => {
  it('takes the doc id the server names', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ docId: 'doc-2026-08-09', source: 'proposal', since: null, setBy: 'proclaim-service', expiresAt: null }),
    );
    await resolveCurrentSession(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/api/session/current');
    expect(getDocId()).toBe('doc-2026-08-09');
  });

  it('rejects when the server is unreachable — no local date fallback', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(resolveCurrentSession(fetchImpl as unknown as typeof fetch)).rejects.toThrow('offline');
    expect(() => getDocId()).toThrow();
  });

  it('rejects a server error rather than carrying on', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 500));
    await expect(resolveCurrentSession(fetchImpl as unknown as typeof fetch)).rejects.toThrow(/500/);
  });

  it('rejects an answer that names no doc', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ docId: '' }));
    await expect(resolveCurrentSession(fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /did not name/,
    );
  });
});

describe('?doc= override', () => {
  it('wins without asking the server at all', async () => {
    setSearch('?doc=doc-test-123');
    const fetchImpl = vi.fn();
    await resolveCurrentSession(fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getDocId()).toBe('doc-test-123');
  });

  it('still wins after the server has answered otherwise', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ docId: 'doc-2026-08-09', source: 'date', since: null, setBy: null, expiresAt: null }),
    );
    await resolveCurrentSession(fetchImpl);
    setSearch('?doc=doc-throwaway');
    expect(getDocId()).toBe('doc-throwaway');
  });

  it('ignores a blank override', () => {
    setSearch('?doc=%20');
    expect(getDocOverride()).toBeNull();
  });
});
