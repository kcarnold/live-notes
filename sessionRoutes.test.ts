/**
 * Wiring tests for the current-session endpoint: a real express app, real routing, the
 * real WriteAuth, driven over a real socket — the same shape as writeAuthRoutes.test.ts.
 *
 * sessionRegistry.test.ts proves the policy. These prove the things the policy is for and
 * that a unit test can't reach: that a viewer can read the answer without a key, that a
 * stranger cannot move an entire service to another doc, and that a proposal comes back
 * with a verdict rather than a rubber stamp.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { WriteAuth, resolveWriteAuthConfig } from './writeAuth.ts';
import { SessionRegistry } from './sessionRegistry.ts';
import { makeSessionRouter } from './sessionRoutes.ts';
import { dateDocId, localDateString } from './src/sessionCurrent.ts';

const GOOD_KEY = '0123456789abcdef0123';

const servers: Server[] = [];
let dir: string;
let registry: SessionRegistry;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-routes-'));
  registry = new SessionRegistry(path.join(dir, 'current-session.json'));
  await registry.load();
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await fs.rm(dir, { recursive: true, force: true });
});

async function serve(mode: 'observe' | 'enforce' = 'enforce'): Promise<string> {
  const writeAuth = new WriteAuth(
    resolveWriteAuthConfig({ WRITE_KEYS: `booth:${GOOD_KEY}`, WRITE_AUTH_MODE: mode }),
  );
  const app = express();
  app.use(express.json());
  app.use(
    '/api/session',
    makeSessionRouter({
      registry,
      requireWriteKey: (route) => (req, res, next) => {
        if (writeAuth.gate(req, res, route)) next();
      },
    }),
  );
  // Mounted after the router, exactly as in server.ts: an unrelated /api/session/* route
  // must still be reachable through the mount.
  app.get('/api/session/export', (_req, res) => {
    res.json({ export: true });
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(base: string, route: string, body: unknown, key?: string) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'X-Write-Key': key } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('GET /api/session/current', () => {
  it('is open to viewers — it is on the critical path of every page load', async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/session/current`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ docId: dateDocId(), source: 'date' });
  });

  it('reports a pin an operator set', async () => {
    const base = await serve();
    await post(base, '/api/session/pin', { docId: 'doc-rehearsal' }, GOOD_KEY);
    expect(await (await fetch(`${base}/api/session/current`)).json()).toMatchObject({
      docId: 'doc-rehearsal',
      source: 'pin',
      setBy: 'status-page',
    });
  });

  it('is never cached — reloading is how a viewer picks up a new pin', async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/session/current`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /api/session/pin', () => {
  it('refuses a stranger: nobody keyless moves the whole service', async () => {
    const base = await serve('enforce');
    const response = await post(base, '/api/session/pin', { docId: 'doc-elsewhere' });
    expect(response.status).toBe(401);
    expect(registry.current().source).toBe('date');
  });

  it('refuses a doc id that is not one', async () => {
    const base = await serve();
    const response = await post(base, '/api/session/pin', { docId: '../../etc/passwd' }, GOOD_KEY);
    expect(response.status).toBe(400);
  });

  it('is released by DELETE', async () => {
    const base = await serve();
    await post(base, '/api/session/pin', { docId: 'doc-rehearsal' }, GOOD_KEY);
    const response = await fetch(`${base}/api/session/pin`, {
      method: 'DELETE',
      headers: { 'X-Write-Key': GOOD_KEY },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: 'date' });
  });
});

describe('POST /api/session/propose', () => {
  it("answers last week's deck with today's doc, and says why", async () => {
    const base = await serve();
    const response = await post(
      base,
      '/api/session/propose',
      { sessionDate: '2020-01-05', setBy: 'proclaim-service' },
      GOOD_KEY,
    );
    expect(await response.json()).toMatchObject({
      outcome: 'stale',
      docId: dateDocId(),
      source: 'date',
    });
  });

  it("takes today's show and makes it the answer everyone reads", async () => {
    const base = await serve();
    const today = localDateString();
    await post(base, '/api/session/propose', { sessionDate: today, setBy: 'proclaim-service' }, GOOD_KEY);
    expect(await (await fetch(`${base}/api/session/current`)).json()).toMatchObject({
      docId: `doc-${today}`,
      source: 'proposal',
      setBy: 'proclaim-service',
    });
  });

  it('is told to follow the pin instead of changing it', async () => {
    const base = await serve();
    await post(base, '/api/session/pin', { docId: 'doc-rehearsal' }, GOOD_KEY);
    const response = await post(
      base,
      '/api/session/propose',
      { sessionDate: localDateString(), setBy: 'proclaim-service' },
      GOOD_KEY,
    );
    expect(await response.json()).toMatchObject({ outcome: 'pinned', docId: 'doc-rehearsal' });
  });

  it('records the proposing service as a writer on the doc it was given', async () => {
    const base = await serve();
    await post(base, '/api/session/propose', { sessionDate: null, setBy: 'proclaim-service' }, GOOD_KEY);
    const { writers } = (await (await fetch(`${base}/api/session/writers`)).json()) as {
      writers: { writer: string; docId: string }[];
    };
    expect(writers).toContainEqual(
      expect.objectContaining({ writer: 'proclaim-service', docId: dateDocId() }),
    );
  });

  it('needs a key, like every other route that changes the answer', async () => {
    const base = await serve('enforce');
    const response = await post(base, '/api/session/propose', { sessionDate: '2030-01-01' });
    expect(response.status).toBe(401);
  });
});

describe('mounting', () => {
  it('falls through to routes registered after it, like /api/session/export', async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/session/export`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ export: true });
  });
});
