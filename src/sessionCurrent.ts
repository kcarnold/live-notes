/**
 * The shape of "which doc is the current session" — shared by the server that owns the
 * answer and the browser that reads it.
 *
 * This lives under `src/` (not at the repo root with the other server modules) for one
 * reason: `getDocId.ts` needs it, and the browser bundle can't import from outside `src/`.
 *
 * The date formula is here too, and it is now the *only* copy, evaluated in exactly one
 * place: the server, as its default when nothing is pinned or proposed. Before issue #111
 * the same formula ran three times — in the browser, in the Proclaim service, and
 * implicitly in whatever a LiveKit client passed as its room name — and the bug was two of
 * those disagreeing.
 *
 * Clients deliberately do *not* keep a copy to fall back on. The same server hands out the
 * app bundle and the Y-Sweet token, so a client that can't reach it has nothing to fall
 * back to; guessing a doc id in that moment would only re-create #111's real defect, which
 * was a component acting on its own private answer and reporting it as fact.
 */

/**
 * The date, `YYYY-MM-DD`, in `timeZone` (IANA; omit for the host's own zone).
 *
 * The zone is explicit because moving this formula from the browser to the server moved
 * it from the *congregation's* clock to the server's, and a container's clock is UTC. A
 * Sunday-evening service in the Americas would otherwise be filed under Monday. Set
 * `SESSION_TIMEZONE` to the church's zone.
 */
export function localDateString(now: Date = new Date(), timeZone?: string): string {
  // en-CA formats as YYYY-MM-DD, which is the format we want and not a coincidence
  // worth re-deriving from parts.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The hour (0-23) in `timeZone` at instant `now`. */
export function zoneHour(now: Date, timeZone?: string): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now),
  );
}

/** The doc id for a given date, `doc-YYYY-MM-DD`. */
export function docIdForDate(date: string): string {
  return `doc-${date}`;
}

/** The server's default when nothing is pinned or proposed: the wall clock's doc. */
export function dateDocId(now: Date = new Date(), timeZone?: string): string {
  return docIdForDate(localDateString(now, timeZone));
}

/**
 * Where the current doc id came from. Worth reporting to an operator: "today's date"
 * and "someone pinned today's date" look identical until something goes wrong.
 */
export type SessionSource =
  /** An operator pinned it from /status. Beats everything until it expires or is cleared. */
  | 'pin'
  /** The Proclaim service proposed it (a show dated X went on air) and the server agreed. */
  | 'proposal'
  /** Nothing is pinned or proposed, so: the date formula, evaluated on the server. */
  | 'date';

/** The server's answer to "what session are we in?" — `GET /api/session/current`. */
export interface CurrentSession {
  docId: string;
  source: SessionSource;
  /** ISO timestamp the pin/proposal was recorded. Null when `source` is `date`. */
  since: string | null;
  /** Free-text label for who set it (`status-page`, `proclaim-service`). Null for `date`. */
  setBy: string | null;
  /** ISO timestamp this pin/proposal stops applying. Null when `source` is `date`. */
  expiresAt: string | null;
}

/** A doc id must look like one before it becomes the answer everyone reads. */
export const DOC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidDocId(value: unknown): value is string {
  return typeof value === 'string' && DOC_ID_PATTERN.test(value);
}
