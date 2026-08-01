/**
 * Express glue for write authorization: the two routes where a key changes *what* a
 * request gets, rather than simply whether it succeeds.
 *
 * They live here rather than inline in server.ts because that module cannot be imported
 * by a test — it reads half a dozen required env vars and stands up Y-Sweet, LiveKit and
 * PostHog at import time. These two behaviors are the ones that would ruin a service if
 * they regressed (an editor silently losing the ability to edit; a stranger taking the
 * microphone), so they need to be drivable against a bare express app.
 */
import type { RequestHandler } from 'express';
import type { WriteAuth } from './writeAuth.ts';

export type GrantedAuthorization = 'full' | 'read-only';

/** What the caller actually got. Read by src/App.tsx. */
export const GRANTED_AUTHORIZATION_HEADER = 'X-Granted-Authorization';
/** Why the key was or wasn't accepted — a different question. Read by src/App.tsx. */
export const WRITE_KEY_STATUS_HEADER = 'X-Write-Key-Status';

export interface YsAuthDeps {
  writeAuth: WriteAuth;
  /** Mint a Y-Sweet client token at the given authorization level. */
  issueToken: (docId: string | null, authorization: GrantedAuthorization) => Promise<unknown>;
  log?: (message: string) => void;
}

/**
 * Y-Sweet token issuance.
 *
 * Read-only tokens are unconditional — anyone may watch a session. A *full* token is the
 * app's real write boundary (the browser talks to Y-Sweet directly with it), so asking
 * for one is what requires a key.
 *
 * An unauthorized editor request is downgraded to read-only rather than refused: a device
 * with a stale key then shows the session as a viewer instead of a blank page, which is
 * the failure anyone would rather have mid-service.
 */
export function makeYsAuthHandler({
  writeAuth,
  issueToken,
  log = () => {},
}: YsAuthDeps): RequestHandler {
  return async (req, res) => {
    const docId = (req.body?.docId as string | undefined) ?? null;
    const wantsEditor = req.body?.isEditor ?? false;
    // Only editor requests are evaluated, and so only they are audited: a viewer needs no
    // key, and checking one anyway would put an audit record on every page load of every
    // screen in the session.
    const check = wantsEditor ? writeAuth.check(req, '/api/ys-auth') : null;
    const authorization: GrantedAuthorization = check?.allowed ? 'full' : 'read-only';
    log(`Auth request: doc=${docId} isEditor=${wantsEditor} granted=${authorization}`);
    const clientToken = await issueToken(docId, authorization);
    res.setHeader(GRANTED_AUTHORIZATION_HEADER, authorization);
    // In observe mode nothing is refused, so `granted` is always `full` and this header
    // is the only way a device can discover it is holding a stale key — during the
    // observe window, which is exactly when that is still cheap to fix.
    if (check) res.setHeader(WRITE_KEY_STATUS_HEADER, check.result.status);
    res.send(clientToken);
  };
}

/**
 * Gate the broadcaster's microphone, and only the microphone.
 *
 * An organizer token is the microphone. Its holder can speak into the room and — because
 * every broadcaster joins under the same `organizer-host` identity, which LiveKit
 * resolves by evicting the incumbent — can silently cut off whoever is currently
 * speaking. Listeners ask for no such thing and need no key.
 */
export function makeOrganizerGate(
  writeAuth: WriteAuth,
  route = '/api/livekit/token',
): RequestHandler {
  return (req, res, next) => {
    if ((req.body?.role as string | undefined) !== 'organizer') return next();
    if (writeAuth.gate(req, res, route)) next();
  };
}
