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
import { randomUUID } from 'crypto';
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
  /**
   * Called when a *full* token is issued, with the key's label when one matched.
   *
   * This is where the server learns who is writing to which doc, which is half of the
   * answer to #111: a service writing to the wrong doc and a service that isn't running
   * produce the same empty pane, and this call is what tells them apart.
   */
  onGrantFull?: (docId: string | null, label: string | null) => void;
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
  onGrantFull = () => {},
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
    if (authorization === 'full') onGrantFull(docId, check?.result.label ?? null);
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
 * The roles `/api/livekit/token` will issue. A closed set, and refused rather than
 * coerced: an unrecognized role used to silently become an attendee, which was safe only
 * because two separate files happened to compare against the same `'organizer'` literal.
 * That is a coincidence to maintain by hand, not an invariant.
 */
export const LIVEKIT_ROLES = ['organizer', 'attendee'] as const;
export type LiveKitRole = (typeof LIVEKIT_ROLES)[number];

/**
 * The role a request is asking for, or null if it named one we don't issue.
 *
 * An absent role is `attendee` — listeners are the default and the overwhelming majority,
 * and the microphone is the thing you have to ask for by name.
 */
export function parseLiveKitRole(raw: unknown): LiveKitRole | null {
  if (raw === undefined || raw === null) return 'attendee';
  return (LIVEKIT_ROLES as readonly unknown[]).includes(raw) ? (raw as LiveKitRole) : null;
}

/**
 * The participant identity to issue for `role`. **Never** the one the client asked for.
 *
 * LiveKit allows one participant per identity and resolves a collision by evicting the
 * incumbent, so an identity is not a name — it is a claim on a seat in the room. Three
 * seats matter here, and each of them used to be claimable by anyone who could reach the
 * endpoint, with no key, because the gate above keys on `role` while the token carried
 * whatever identity the body asked for:
 *
 *   - `organizer-host` — evicts the live broadcaster, and makes the translation
 *     supervisor believe a broadcaster is present (it tests the `organizer-` prefix), so
 *     it starts a paid Gemini bridge in an otherwise empty room.
 *   - `translator-{code}` — evicts that language's translator bot.
 *   - another listener's `attendee-…` — evicts that listener.
 *
 * Deriving it here closes all three at once, and makes `makeOrganizerGate` sufficient
 * rather than approximately right: asking for `role: 'organizer'` becomes the only way to
 * reach an organizer identity, so gating the role really is gating the microphone.
 *
 * The random suffix is injectable for tests only.
 */
export function livekitIdentity(
  role: LiveKitRole,
  organizerIdentity: string,
  randomSuffix: () => string = randomUUID,
): string {
  return role === 'organizer' ? organizerIdentity : `attendee-${randomSuffix()}`;
}

/**
 * Gate the broadcaster's microphone, and only the microphone.
 *
 * An organizer token is the microphone. Its holder can speak into the room and — because
 * every broadcaster joins under the same `organizer-host` identity, which LiveKit
 * resolves by evicting the incumbent — can silently cut off whoever is currently
 * speaking. Listeners ask for no such thing and need no key.
 *
 * An unparseable role falls through to the route, which refuses it with a 400. This gate
 * deliberately doesn't do that itself: it has one job, and a role it doesn't recognize is
 * by definition not a request for the microphone.
 */
export function makeOrganizerGate(
  writeAuth: WriteAuth,
  route = '/api/livekit/token',
): RequestHandler {
  return (req, res, next) => {
    if (parseLiveKitRole(req.body?.role) !== 'organizer') return next();
    if (writeAuth.gate(req, res, route)) next();
  };
}
