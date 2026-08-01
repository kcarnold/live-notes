/**
 * Wiring tests for write authorization: a real express app, real routing, the real
 * WriteAuth, driven over a real socket.
 *
 * The unit tests in writeAuth.test.ts prove the policy. These prove the two things the
 * policy is *for*, which no amount of unit testing the helper can establish: that an
 * editor without a key is quietly downgraded rather than refused, and that a stranger
 * cannot take the microphone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WriteAuth, resolveWriteAuthConfig } from './writeAuth.ts';
import { makeOrganizerGate, makeYsAuthHandler } from './writeAuthRoutes.ts';

const GOOD_KEY = '0123456789abcdef0123';
const STALE_KEY = 'last-months-booth-key';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** Start `app` on an ephemeral port and return its base URL. */
async function serve(app: express.Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function authFor(mode: 'observe' | 'enforce'): WriteAuth {
  return new WriteAuth(
    resolveWriteAuthConfig({ WRITE_KEYS: `booth:${GOOD_KEY}`, WRITE_AUTH_MODE: mode }),
  );
}

/** The real /api/ys-auth route, with only Y-Sweet itself faked out. */
async function ysAuthApp(mode: 'observe' | 'enforce') {
  const app = express();
  app.use(express.json());
  app.post(
    '/api/ys-auth',
    makeYsAuthHandler({
      writeAuth: authFor(mode),
      // Stand in for Y-Sweet, but echo the level back so a test can prove the token was
      // actually minted at the level the headers claim.
      issueToken: (docId, authorization) => Promise.resolve({ docId, authorization }),
    }),
  );
  return serve(app);
}

async function askForToken(base: string, body: unknown, key?: string) {
  const response = await fetch(`${base}/api/ys-auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'X-Write-Key': key } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    granted: response.headers.get('X-Granted-Authorization'),
    keyStatus: response.headers.get('X-Write-Key-Status'),
    body: (await response.json()) as { authorization?: string },
  };
}

describe('/api/ys-auth', () => {
  it('gives an editor with a valid key a full token', async () => {
    const base = await ysAuthApp('enforce');
    const result = await askForToken(base, { docId: 'doc-1', isEditor: true }, GOOD_KEY);

    expect(result.status).toBe(200);
    expect(result.granted).toBe('full');
    expect(result.keyStatus).toBe('ok');
    expect(result.body.authorization).toBe('full');
  });

  it('downgrades an unrecognized editor instead of refusing them', async () => {
    // The whole point of the downgrade: a device with a stale key shows the session
    // read-only mid-service rather than a blank page.
    const base = await ysAuthApp('enforce');
    const result = await askForToken(base, { docId: 'doc-1', isEditor: true }, STALE_KEY);

    expect(result.status).toBe(200);
    expect(result.granted).toBe('read-only');
    expect(result.keyStatus).toBe('invalid');
    expect(result.body.authorization).toBe('read-only');
  });

  it('downgrades an editor presenting no key at all', async () => {
    const base = await ysAuthApp('enforce');
    const result = await askForToken(base, { docId: 'doc-1', isEditor: true });

    expect(result.granted).toBe('read-only');
    expect(result.keyStatus).toBe('missing');
  });

  it('lets a viewer in with no key, and never evaluates one', async () => {
    const base = await ysAuthApp('enforce');
    const result = await askForToken(base, { docId: 'doc-1', isEditor: false });

    expect(result.status).toBe(200);
    expect(result.granted).toBe('read-only');
    // Absent, not 'ok': a viewer request is not checked, so there is nothing to report.
    expect(result.keyStatus).toBeNull();
  });

  it('still grants full access in observe mode, but says the key was not recognized', async () => {
    // This is the header that makes provisioning possible during the rollout: nothing is
    // refused, so `granted` alone can never reveal that a device is on a stale key.
    const base = await ysAuthApp('observe');
    const result = await askForToken(base, { docId: 'doc-1', isEditor: true }, STALE_KEY);

    expect(result.granted).toBe('full');
    expect(result.keyStatus).toBe('invalid');
  });
});

/** The real organizer gate, in front of a handler that just reports it was reached. */
async function livekitApp(mode: 'observe' | 'enforce') {
  const app = express();
  app.use(express.json());
  app.post('/api/livekit/token', makeOrganizerGate(authFor(mode)), (req, res) => {
    res.json({ issued: true, role: req.body?.role ?? 'attendee' });
  });
  return serve(app);
}

async function askForMicrophone(base: string, body: unknown, key?: string) {
  const response = await fetch(`${base}/api/livekit/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'X-Write-Key': key } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { issued?: boolean } };
}

describe('/api/livekit/token organizer gate', () => {
  it('refuses the microphone to a request with no key', async () => {
    const base = await livekitApp('enforce');
    const result = await askForMicrophone(base, { room: 'doc-1', role: 'organizer' });

    expect(result.status).toBe(401);
    expect(result.body.issued).toBeUndefined();
  });

  it('refuses the microphone to a stale key', async () => {
    const base = await livekitApp('enforce');
    const result = await askForMicrophone(
      base,
      { room: 'doc-1', role: 'organizer' },
      STALE_KEY,
    );
    expect(result.status).toBe(401);
  });

  it('hands the microphone to a valid key', async () => {
    const base = await livekitApp('enforce');
    const result = await askForMicrophone(
      base,
      { room: 'doc-1', role: 'organizer' },
      GOOD_KEY,
    );

    expect(result.status).toBe(200);
    expect(result.body.issued).toBe(true);
  });

  it('lets listeners through untouched — viewers must never need a key', async () => {
    const base = await livekitApp('enforce');

    for (const body of [
      { room: 'doc-1', role: 'attendee' },
      { room: 'doc-1' }, // role omitted entirely
    ]) {
      const result = await askForMicrophone(base, body);
      expect(result.status).toBe(200);
      expect(result.body.issued).toBe(true);
    }
  });

  it('hands over the microphone in observe mode even unauthorized, as designed', async () => {
    const base = await livekitApp('observe');
    const result = await askForMicrophone(base, { room: 'doc-1', role: 'organizer' });

    expect(result.status).toBe(200);
    expect(result.body.issued).toBe(true);
  });
});
