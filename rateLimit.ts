/**
 * A crude per-caller request cap for the two endpoints a write key can't protect.
 *
 * `/api/tts` and `/api/livekit/translate` are called by *listeners* — legitimately, and
 * often — so they cannot require an editor's key (see docs/WRITE_KEYS.md). That makes
 * them the whole of the unmetered spend once `WRITE_AUTH_MODE=enforce` closes everything
 * else, and the first place anyone holding the URL will land.
 *
 * This is a stopgap, not the answer. The answer is in that doc's TODO: TTS should only
 * speak lines that are actually in the notes, and there should be a ceiling on live
 * translator bots. This just makes a script cost something before it costs money.
 *
 * Deliberately generous, and deliberately dependency-free so it is easy to revert.
 *
 * ## Two things to know before tuning it
 *
 * **A congregation shares one address.** Everyone on the church wifi arrives from a single
 * public IP, so a limit tight enough to be interesting is also tight enough to cut off the
 * room. The defaults are set well above what a full service generates — a listener pings
 * `/api/livekit/translate` every 10s, and auto-speak fetches a line at a time — and the
 * failure they are guarding against is a script in a loop, which is orders of magnitude
 * away, not a factor of two.
 *
 * **The caller key is spoofable.** It prefers `X-Forwarded-For` over `req.ip`, because
 * behind a reverse proxy `req.ip` is the *proxy* — which would collapse every listener
 * into one bucket and take the service down at the first busy Sunday. A forged header
 * lets an abuser evade the cap, which leaves us no worse off than having no cap at all.
 * Never use this for anything but rate limiting.
 */
import type { RequestHandler } from 'express';

export interface RateLimitedRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Who to count this request against. See the header note above: this identifies a caller
 * for accounting only, and must never be treated as trustworthy.
 */
export function callerKey(req: RateLimitedRequest): string {
  const header = req.headers['x-forwarded-for'];
  const forwarded = Array.isArray(header) ? header[0] : header;
  const first = forwarded?.split(',')[0]?.trim();
  return first || req.ip || 'unknown';
}

export interface RateLimitOptions {
  /** Requests allowed per window. 0 or less disables the limiter entirely. */
  limit: number;
  windowMs?: number;
  /** Route name, for the log line. */
  route: string;
  /** Called the first time a caller trips the limit within a window. */
  onLimited?: (info: { caller: string; route: string; count: number }) => void;
  now?: () => number;
}

interface Window {
  count: number;
  startedAt: number;
}

/** Sweep expired windows every so many requests, so the map can't grow forever. */
const SWEEP_EVERY = 500;

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly route: string;
  private readonly onLimited: (info: { caller: string; route: string; count: number }) => void;
  private readonly now: () => number;
  private sinceSweep = 0;

  constructor(options: RateLimitOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs ?? 60_000;
    this.route = options.route;
    this.onLimited = options.onLimited ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.limit > 0;
  }

  /** Record a request. Returns whether it may proceed, and when to retry if not. */
  check(caller: string): { allowed: boolean; retryAfterSeconds: number } {
    if (!this.enabled) return { allowed: true, retryAfterSeconds: 0 };

    const now = this.now();
    if (++this.sinceSweep >= SWEEP_EVERY) {
      this.sinceSweep = 0;
      for (const [key, window] of this.windows) {
        if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
      }
    }

    const existing = this.windows.get(caller);
    const window =
      existing && now - existing.startedAt < this.windowMs
        ? existing
        : { count: 0, startedAt: now };
    window.count += 1;
    this.windows.set(caller, window);

    if (window.count <= this.limit) return { allowed: true, retryAfterSeconds: 0 };
    // Only the request that crosses the line reports, not every one after it — a script
    // in a loop should cost one log line per window, not thousands.
    if (window.count === this.limit + 1) {
      this.onLimited({ caller, route: this.route, count: window.count });
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + this.windowMs - now) / 1000)),
    };
  }
}

export function makeRateLimit(options: RateLimitOptions): RequestHandler {
  const limiter = new RateLimiter(options);
  return (req, res, next) => {
    const { allowed, retryAfterSeconds } = limiter.check(callerKey(req));
    if (allowed) return next();
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({ ok: false, error: 'Too many requests; slow down.' });
  };
}

/** Read a per-minute limit from the environment. Unset keeps the default; 0 disables. */
export function limitFromEnv(raw: string | undefined, fallback: number): number {
  const value = Number((raw ?? '').trim());
  if (!(raw ?? '').trim() || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}
