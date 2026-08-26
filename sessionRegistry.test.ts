/**
 * The policy tests for the server-owned current session (#111).
 *
 * The scenario that produced the issue is the first test: a service reports that last
 * week's deck is on air, and the answer it gets back is today's doc.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { SessionRegistry, entryExpiry, MIN_LIFETIME_MS } from './sessionRegistry.ts';
import { dateDocId, localDateString } from './src/sessionCurrent.ts';

let dir: string;
let registry: SessionRegistry;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-registry-'));
  registry = new SessionRegistry(path.join(dir, 'current-session.json'));
  await registry.load();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A local-time Date, so tests read the same way the (local-time) date formula does. */
function at(y: number, m: number, d: number, h = 10, min = 0): Date {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

describe('with nothing set', () => {
  it('answers with today, from the date formula', () => {
    const now = at(2026, 8, 30);
    expect(registry.current(now)).toMatchObject({
      docId: dateDocId(now),
      source: 'date',
      since: null,
      expiresAt: null,
    });
  });
});

describe('proposals', () => {
  it("refuses a show dated before today — the #111 failure, in one call", async () => {
    const now = at(2026, 8, 9);
    const result = await registry.propose('2026-08-02', 'proclaim-service', now);
    expect(result.outcome).toBe('stale');
    expect(result.session.docId).toBe('doc-2026-08-09');
    expect(result.session.source).toBe('date');
  });

  it("accepts today's show", async () => {
    const now = at(2026, 8, 9);
    const result = await registry.propose('2026-08-09', 'proclaim-service', now);
    expect(result.outcome).toBe('accepted');
    expect(result.session).toMatchObject({ docId: 'doc-2026-08-09', source: 'proposal' });
  });

  it('accepts a future show, so pre-staging next week works for browsers too', async () => {
    const now = at(2026, 8, 6); // Thursday
    const result = await registry.propose('2026-08-09', 'volunteer-laptop', now);
    expect(result.outcome).toBe('accepted');
    expect(registry.current(now).docId).toBe('doc-2026-08-09');
  });

  it('reports no-date and changes nothing when the show has no date', async () => {
    const now = at(2026, 8, 9);
    const result = await registry.propose(null, 'proclaim-service', now);
    expect(result.outcome).toBe('no-date');
    expect(result.session.source).toBe('date');
  });

  it('does not push its own expiry out by re-proposing the same doc every poll', async () => {
    const start = at(2026, 8, 9, 9);
    await registry.propose('2026-08-09', 'proclaim-service', start);
    const firstSince = registry.current(start).since;
    await registry.propose('2026-08-09', 'proclaim-service', at(2026, 8, 9, 11));
    expect(registry.current(start).since).toBe(firstSince);
  });
});

describe('pins', () => {
  it('outranks a live proposal', async () => {
    const now = at(2026, 8, 9);
    await registry.propose('2026-08-09', 'proclaim-service', now);
    await registry.setPin('doc-rehearsal', 'status-page', now);
    expect(registry.current(now)).toMatchObject({
      docId: 'doc-rehearsal',
      source: 'pin',
      setBy: 'status-page',
    });
  });

  it('is not overwritten by a later proposal — the service never changes a pin', async () => {
    const now = at(2026, 8, 9);
    await registry.setPin('doc-rehearsal', 'status-page', now);
    const result = await registry.propose('2026-08-09', 'proclaim-service', now);
    expect(result.outcome).toBe('pinned');
    expect(result.session.docId).toBe('doc-rehearsal');
  });

  it('falls back to a live proposal when cleared', async () => {
    const now = at(2026, 8, 9);
    await registry.propose('2026-08-09', 'proclaim-service', now);
    await registry.setPin('doc-rehearsal', 'status-page', now);
    const session = await registry.clearPin(now);
    expect(session).toMatchObject({ docId: 'doc-2026-08-09', source: 'proposal' });
  });

  it('refuses a doc id that is not one', async () => {
    await expect(registry.setPin('../../etc/passwd', 'status-page')).rejects.toThrow();
  });

  it('lapses by the next service, so a forgotten pin cannot capture it', async () => {
    const sunday = at(2026, 8, 9, 10);
    await registry.setPin('doc-rehearsal', 'status-page', sunday);
    expect(registry.current(at(2026, 8, 9, 23)).source).toBe('pin');
    const nextSunday = at(2026, 8, 16, 10);
    expect(registry.current(nextSunday)).toMatchObject({
      docId: dateDocId(nextSunday),
      source: 'date',
    });
  });

  it('survives a server restart mid-service', async () => {
    const now = at(2026, 8, 9);
    await registry.setPin('doc-rehearsal', 'status-page', now);
    const reloaded = new SessionRegistry(path.join(dir, 'current-session.json'));
    await reloaded.load();
    expect(reloaded.current(now).docId).toBe('doc-rehearsal');
  });

  it('starts empty rather than crashing on a corrupt file', async () => {
    const file = path.join(dir, 'current-session.json');
    await fs.writeFile(file, '{ not json', 'utf-8');
    const reloaded = new SessionRegistry(file);
    await reloaded.load();
    expect(reloaded.current(at(2026, 8, 9)).source).toBe('date');
  });
});

describe('entryExpiry', () => {
  it('carries a mid-morning pin past midnight to the next 4am', () => {
    expect(entryExpiry(at(2026, 8, 9, 10))).toEqual(at(2026, 8, 10, 4));
  });

  it('gives a 2am pin a working lifetime instead of expiring it at once', () => {
    const since = at(2026, 8, 9, 2);
    const expiry = entryExpiry(since);
    expect(expiry.getTime() - since.getTime()).toBeGreaterThanOrEqual(MIN_LIFETIME_MS);
    expect(expiry.getHours()).toBe(4);
  });
});

describe('timezone', () => {
  it("uses the church's zone, not the container's, so a Sunday evening stays Sunday", () => {
    // 8pm Sunday in Detroit is already Monday 00:00 UTC. A UTC server computing the date
    // for itself would file the evening service under the wrong day.
    const sundayEvening = new Date('2026-08-09T00:30:00Z');
    const utc = new SessionRegistry(path.join(dir, 'utc.json'), 'UTC');
    const detroit = new SessionRegistry(path.join(dir, 'detroit.json'), 'America/Detroit');
    expect(utc.current(sundayEvening).docId).toBe('doc-2026-08-09');
    expect(detroit.current(sundayEvening).docId).toBe('doc-2026-08-08');
  });

  it('reckons the 4am boundary in that zone too', async () => {
    const detroit = new SessionRegistry(path.join(dir, 'detroit.json'), 'America/Detroit');
    await detroit.load();
    // 10am Sunday Detroit.
    await detroit.setPin('doc-rehearsal', 'status-page', new Date('2026-08-09T14:00:00Z'));
    // 3am Monday Detroit — still before the reset.
    expect(detroit.current(new Date('2026-08-10T07:00:00Z')).source).toBe('pin');
    // 5am Monday Detroit — past it.
    expect(detroit.current(new Date('2026-08-10T09:00:00Z')).source).toBe('date');
  });
});

describe('recent writers', () => {
  it('shows two writers on different docs — "down" and "elsewhere" stop matching', () => {
    const now = at(2026, 8, 9);
    registry.noteWriter('proclaim-service', 'doc-2026-08-02', now);
    registry.noteWriter('booth', 'doc-2026-08-09', now);
    const writers = registry.recentWriters(now);
    expect(writers.map((w) => w.docId).sort()).toEqual(['doc-2026-08-02', 'doc-2026-08-09']);
  });

  it('collapses repeat sightings of the same writer on the same doc', () => {
    const now = at(2026, 8, 9);
    registry.noteWriter('booth', 'doc-2026-08-09', now);
    registry.noteWriter('booth', 'doc-2026-08-09', at(2026, 8, 9, 10, 5));
    expect(registry.recentWriters(at(2026, 8, 9, 10, 6))).toHaveLength(1);
  });

  it('forgets a writer that stopped reporting', () => {
    registry.noteWriter('booth', 'doc-2026-08-09', at(2026, 8, 9, 10));
    expect(registry.recentWriters(at(2026, 8, 9, 11))).toHaveLength(0);
  });

  it('ignores a doc id that is not one', () => {
    const now = at(2026, 8, 9);
    registry.noteWriter('booth', '../secrets', now);
    expect(registry.recentWriters(now)).toHaveLength(0);
  });
});

describe('localDateString', () => {
  it('pads to YYYY-MM-DD', () => {
    expect(localDateString(at(2026, 1, 5))).toBe('2026-01-05');
  });
});
