/**
 * Express glue for the server-owned "current session" (issue #111).
 *
 * Split out of server.ts for the same reason as writeAuthRoutes.ts: that module reads
 * half a dozen required env vars and stands up Y-Sweet, LiveKit and PostHog at import
 * time, so nothing in it can be driven from a test. These routes decide which doc an
 * entire service writes to, which puts them firmly in the category of things that must
 * not regress unnoticed.
 */
import { Router, type RequestHandler } from 'express';

import type { SessionRegistry } from './sessionRegistry.ts';
import { isValidDocId } from './src/sessionCurrent.ts';

export interface SessionRoutesDeps {
  registry: SessionRegistry;
  /** Gate for the routes that *change* the answer. Reading it is open to viewers. */
  requireWriteKey: (route: string) => RequestHandler;
  log?: (message: string) => void;
}

/** A `YYYY-MM-DD` date, the only form a proposal's session date may take. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function makeSessionRouter({
  registry,
  requireWriteKey,
  log = () => {},
}: SessionRoutesDeps): Router {
  const router = Router();

  /**
   * The fact everyone reads. Deliberately open and cheap: it is on the critical path of
   * every page load, and it stands between a viewer and the service — so making it
   * require anything would only add ways to be wrong.
   */
  router.get('/current', (_req, res) => {
    // Never cached, anywhere. This answer decides which doc a whole service writes to, it
    // changes the moment an operator pins one, and a viewer reloading to pick up that pin
    // is the recovery path — a proxy serving a minute-old copy would break exactly the
    // thing this endpoint exists for.
    res.setHeader('Cache-Control', 'no-store');
    res.json(registry.current());
  });

  /** Who has recently asked to write where. Turns "down" and "elsewhere" into two states. */
  router.get('/writers', (_req, res) => {
    res.json({ current: registry.current(), writers: registry.recentWriters() });
  });

  /** Pin the current session. The operator control that outranks every other party. */
  router.post('/pin', requireWriteKey('/api/session/pin'), async (req, res) => {
    const docId = req.body?.docId;
    if (!isValidDocId(docId)) {
      res.status(400).json({ error: 'docId must look like doc-2026-08-30' });
      return;
    }
    const setBy = typeof req.body?.setBy === 'string' && req.body.setBy ? req.body.setBy : 'status-page';
    const session = await registry.setPin(docId, setBy);
    log(`[session] pinned ${session.docId} by ${setBy} (until ${session.expiresAt})`);
    res.json(session);
  });

  /** Release the pin, falling back to a live proposal and then to the date. */
  router.delete('/pin', requireWriteKey('/api/session/pin'), async (_req, res) => {
    const session = await registry.clearPin();
    log(`[session] pin cleared; current is ${session.docId} (${session.source})`);
    res.json(session);
  });

  /**
   * A source reports what it sees on air and is told which doc to use.
   *
   * The response is the whole point: the caller does not get to act on its own reading.
   * `outcome` says whether the proposal was taken up, so a service can log the truth
   * ("I proposed last week's date and was told to use today's") instead of announcing
   * the doc it merely intended to write to — the specific lie in #111.
   */
  router.post('/propose', requireWriteKey('/api/session/propose'), async (req, res) => {
    const rawDate = req.body?.sessionDate;
    const sessionDate = typeof rawDate === 'string' && DATE_PATTERN.test(rawDate) ? rawDate : null;
    const setBy =
      typeof req.body?.setBy === 'string' && req.body.setBy ? req.body.setBy : 'unknown-service';
    const { outcome, session } = await registry.propose(sessionDate, setBy);
    if (outcome === 'stale') {
      log(
        `[session] ${setBy} proposed ${rawDate} (in the past); staying on ${session.docId}`,
      );
    } else if (outcome === 'pinned') {
      log(`[session] ${setBy} proposed ${rawDate}; a pin holds ${session.docId}`);
    }
    registry.noteWriter(setBy, session.docId);
    res.json({ ...session, outcome });
  });

  return router;
}
