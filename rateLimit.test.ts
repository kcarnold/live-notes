import { describe, it, expect, vi } from 'vitest';
import { RateLimiter, callerKey, limitFromEnv } from './rateLimit.ts';

/** A clock the test drives by hand, so no window has to be waited out. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('callerKey', () => {
  it('prefers the forwarded address, since req.ip behind a proxy is the proxy', () => {
    // The failure this avoids: every listener collapsing into one bucket and the cap
    // taking down a full service.
    expect(
      callerKey({ ip: '10.0.0.1', headers: { 'x-forwarded-for': '203.0.113.7' } }),
    ).toBe('203.0.113.7');
  });

  it('takes the first hop of a forwarded chain', () => {
    expect(
      callerKey({ ip: '10.0.0.1', headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.5' } }),
    ).toBe('203.0.113.7');
  });

  it('falls back to the socket address, then to a constant', () => {
    expect(callerKey({ ip: '203.0.113.7', headers: {} })).toBe('203.0.113.7');
    expect(callerKey({ headers: {} })).toBe('unknown');
    expect(callerKey({ ip: '203.0.113.7', headers: { 'x-forwarded-for': '  ' } })).toBe(
      '203.0.113.7',
    );
  });
});

describe('RateLimiter', () => {
  it('allows exactly the limit, then refuses', () => {
    const limiter = new RateLimiter({ limit: 3, route: '/api/tts' });
    const results = [1, 2, 3, 4].map(() => limiter.check('caller').allowed);
    expect(results).toEqual([true, true, true, false]);
  });

  it('counts each caller separately', () => {
    const limiter = new RateLimiter({ limit: 1, route: '/api/tts' });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('forgives once the window rolls over', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 60_000,
      route: '/api/tts',
      now: clock.now,
    });

    expect(limiter.check('caller').allowed).toBe(true);
    expect(limiter.check('caller').allowed).toBe(false);

    clock.advance(60_000);
    expect(limiter.check('caller').allowed).toBe(true);
  });

  it('says how long to wait', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 60_000,
      route: '/api/tts',
      now: clock.now,
    });

    limiter.check('caller');
    clock.advance(15_000);
    expect(limiter.check('caller').retryAfterSeconds).toBe(45);
  });

  it('reports once per window, not once per refused request', () => {
    // A script in a loop should cost one log line a minute, not thousands.
    const onLimited = vi.fn();
    const limiter = new RateLimiter({ limit: 1, route: '/api/tts', onLimited });

    for (let i = 0; i < 50; i++) limiter.check('caller');

    expect(onLimited).toHaveBeenCalledTimes(1);
    expect(onLimited).toHaveBeenCalledWith({ caller: 'caller', route: '/api/tts', count: 2 });
  });

  it('is disabled by a limit of zero, and lets everything through', () => {
    const limiter = new RateLimiter({ limit: 0, route: '/api/tts' });
    expect(limiter.enabled).toBe(false);
    for (let i = 0; i < 100; i++) expect(limiter.check('caller').allowed).toBe(true);
  });

  it('does not accumulate windows forever', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({
      limit: 10,
      windowMs: 60_000,
      route: '/api/tts',
      now: clock.now,
    });

    for (let i = 0; i < 600; i++) limiter.check(`caller-${i}`);
    clock.advance(60_000);
    for (let i = 600; i < 1200; i++) limiter.check(`caller-${i}`);

    // The sweep runs every 500 requests, so the expired first batch is gone rather than
    // held forever by a server that runs for months.
    const windows = limiter as unknown as { windows: Map<string, unknown> };
    expect(windows.windows.size).toBeLessThan(1200);
  });
});

describe('limitFromEnv', () => {
  it('keeps the default when unset or unparseable', () => {
    expect(limitFromEnv(undefined, 600)).toBe(600);
    expect(limitFromEnv('', 600)).toBe(600);
    expect(limitFromEnv('  ', 600)).toBe(600);
    expect(limitFromEnv('lots', 600)).toBe(600);
    expect(limitFromEnv('-5', 600)).toBe(600);
  });

  it('takes an explicit value, including zero to disable', () => {
    expect(limitFromEnv('100', 600)).toBe(100);
    expect(limitFromEnv('0', 600)).toBe(0);
  });
});
