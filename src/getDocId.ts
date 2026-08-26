/**
 * Which session this client is in.
 *
 * This used to be a formula — wall-clock today — evaluated independently here, in the
 * Proclaim service, and implicitly by whatever a browser passed LiveKit as a room name.
 * Issue #111 is what happens when two of those disagree: the service wrote a whole
 * service's slides into last week's doc while logging this week's.
 *
 * So the doc id is no longer computed here. It is *fetched* once, from the server that
 * owns the answer, before anything mounts. Two consequences worth stating plainly:
 *
 *   - There is no local date fallback. The same server hands out this bundle and the
 *     Y-Sweet token, so a client that can't reach it has nothing to fall back *to*, and
 *     guessing would only recreate the original defect: a component acting on its own
 *     private answer and presenting it as fact. Unreachable is reported, not papered over.
 *   - `?doc=` still wins outright, without a round trip. It is the escape hatch for when
 *     the server's answer is wrong, and how the record/replay harness targets a throwaway
 *     doc.
 *
 * The resolved id is cached in this module so the many synchronous callers (`ListenViewer`,
 * `BroadcastControl`, the slide-translation API) keep working unchanged — `App` resolves
 * before rendering them, so by the time any of them asks, the answer is in hand.
 */
import type { CurrentSession } from './sessionCurrent.ts';

export type { CurrentSession };

let resolved: CurrentSession | null = null;

/** The `?doc=` override, or null. Read fresh each time; the URL can change under us. */
export function getDocOverride(): string | null {
  const override = new URLSearchParams(window.location.search).get('doc');
  return override && override.trim() ? override.trim() : null;
}

/**
 * The current doc id, synchronously.
 *
 * Only valid after {@link resolveCurrentSession} has completed (or with a `?doc=`
 * override). Callers all live under a component tree `App` doesn't render until then.
 */
export function getDocId(): string {
  const override = getDocOverride();
  if (override) return override;
  if (resolved) return resolved.docId;
  throw new Error('getDocId() called before the current session was resolved');
}

/** The whole server answer, for screens that show *why* this is the current doc. */
export function getCurrentSession(): CurrentSession | null {
  return resolved;
}

/**
 * Ask the server which session we are in, and cache it.
 *
 * Rejects rather than guessing when the server can't be reached — see the module comment.
 */
export async function resolveCurrentSession(
  fetchImpl: typeof fetch = fetch,
): Promise<CurrentSession> {
  const override = getDocOverride();
  if (override) {
    // An override is the answer; don't let a server round trip stand in front of the
    // one path that exists precisely for when the server is wrong.
    resolved = { docId: override, source: 'pin', since: null, setBy: 'url', expiresAt: null };
    return resolved;
  }
  const response = await fetchImpl('/api/session/current');
  if (!response.ok) {
    throw new Error(`Server returned ${response.status} for the current session`);
  }
  const session = (await response.json()) as CurrentSession;
  if (!session || typeof session.docId !== 'string' || !session.docId) {
    throw new Error('Server did not name a current session');
  }
  resolved = session;
  return session;
}

/** Test seam: forget the cached answer. */
export function resetResolvedSession(): void {
  resolved = null;
}
