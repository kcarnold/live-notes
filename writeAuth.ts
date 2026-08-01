/**
 * Shared-key ("pre-shared key") authorization for the app's privileged endpoints.
 *
 * This app is driven by *devices* — the Proclaim Mac, the audio feeder, a couple of
 * editor browsers/tablets — not by named users, so authorization is a short list of
 * shared keys rather than logins. Readers need no key at all: viewer traffic
 * (read-only Y-Sweet tokens, TTS, listener LiveKit tokens) stays deliberately open.
 *
 * Rollout has three modes, chosen by `WRITE_AUTH_MODE`:
 *
 *   off      No checking, no logging. Local dev, and the automatic mode when no keys
 *            are configured at all.
 *   observe  Check and record the outcome, but always allow (the default). This is how
 *            a key rollout starts: clients ship the key, and a week of logs shows that
 *            every real device presents a valid one *before* anything can be locked out.
 *   enforce  Unauthorized privileged requests are refused.
 *
 * Keys come from `WRITE_KEYS`, a comma-separated list whose entries are either `key`
 * or `label:key`. The label is only ever used in logs and telemetry — it answers
 * "which device is this?", so a rotation can be watched per device rather than as one
 * anonymous total. Rotating is editing that list and restarting: keys stay valid until
 * removed, so old and new can overlap while devices are updated one at a time.
 *
 * Deliberately dependency-free (no express, no PostHog) so it is trivially testable;
 * the express glue and the telemetry sink are injected by server.ts.
 */
import { createHash, timingSafeEqual } from 'crypto';

export type WriteAuthMode = 'off' | 'observe' | 'enforce';

/** One configured key. `label` is for logging only and is never compared. */
export interface WriteKeyEntry {
  label: string;
  key: string;
}

/** Why a privileged request was (or would have been) allowed or refused. */
export type WriteAuthStatus = 'ok' | 'missing' | 'invalid';

export interface WriteAuthResult {
  status: WriteAuthStatus;
  /** Label of the matched key, or null when nothing matched. */
  label: string | null;
}

/** The audit record emitted for every privileged request, in every non-`off` mode. */
export interface WriteAuthAudit extends WriteAuthResult {
  mode: WriteAuthMode;
  route: string;
  /** True when the request was actually refused (enforce mode + a bad key). */
  refused: boolean;
}

/** Just enough of an express Request to read headers from. */
export interface HeaderBearingRequest {
  headers: Record<string, string | string[] | undefined>;
}

/** Header clients use to present their key. `Authorization: Bearer <key>` also works. */
export const WRITE_KEY_HEADER = 'x-write-key';

/**
 * Keys shorter than this are almost certainly a placeholder rather than a real secret.
 * Warned about at boot, never rejected — refusing to start over a short key would be a
 * worse failure than running with one.
 */
const MIN_REASONABLE_KEY_LENGTH = 16;

/**
 * Parse `WRITE_KEYS`. Entries are `label:key` or a bare `key`; blanks and entries with
 * an empty key are dropped, so a trailing comma or a stray `label:` can't silently
 * install a key that matches the empty string.
 */
export function parseWriteKeys(raw: string | undefined): WriteKeyEntry[] {
  if (!raw) return [];
  const entries: WriteKeyEntry[] = [];
  for (const chunk of raw.split(',')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    const label = separator === -1 ? '' : trimmed.slice(0, separator).trim();
    const key = separator === -1 ? trimmed : trimmed.slice(separator + 1).trim();
    if (!key) continue;
    entries.push({ label: label || `key${entries.length + 1}`, key });
  }
  return entries;
}

export function parseWriteAuthMode(raw: string | undefined): WriteAuthMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'observe';
  if (value === 'off' || value === 'observe' || value === 'enforce') return value;
  // A typo here (`enfoce`) must never silently degrade to "allow everything", so this
  // is fatal rather than a warning. Leaving the variable unset is the safe default.
  throw new Error(
    `WRITE_AUTH_MODE must be one of off|observe|enforce (got '${raw}')`,
  );
}

export interface WriteAuthConfig {
  mode: WriteAuthMode;
  keys: WriteKeyEntry[];
  /** Boot-time lines for the operator: effective mode, key labels, any warnings. */
  notices: string[];
}

/**
 * Resolve the effective configuration from the environment.
 *
 * Two safety rules live here. Configuring no keys drops to `off` rather than logging a
 * miss for every request forever — an install that doesn't use this feature shouldn't
 * pay for it. Asking for `enforce` with no keys throws, because it would lock out every
 * device including the Proclaim service; that is a misconfiguration worth failing at
 * boot for, when it is one env var away from being fixed, rather than mid-service.
 */
export function resolveWriteAuthConfig(env: {
  WRITE_KEYS?: string;
  WRITE_AUTH_MODE?: string;
}): WriteAuthConfig {
  const requestedMode = parseWriteAuthMode(env.WRITE_AUTH_MODE);
  const keys = parseWriteKeys(env.WRITE_KEYS);
  const notices: string[] = [];

  if (keys.length === 0) {
    if (requestedMode === 'enforce') {
      throw new Error(
        'WRITE_AUTH_MODE=enforce requires at least one key in WRITE_KEYS; ' +
          'starting would refuse every editor, the Proclaim service and the audio feeder.',
      );
    }
    notices.push('[write-auth] no WRITE_KEYS configured — write authorization is off');
    return { mode: 'off', keys, notices };
  }

  const short = keys.filter((entry) => entry.key.length < MIN_REASONABLE_KEY_LENGTH);
  if (short.length > 0) {
    notices.push(
      `[write-auth] WARNING: short key(s) [${short.map((e) => e.label).join(', ')}] — ` +
        `use at least ${MIN_REASONABLE_KEY_LENGTH} random characters`,
    );
  }
  notices.push(
    `[write-auth] mode=${requestedMode} keys=[${keys.map((e) => e.label).join(', ')}]`,
  );
  if (requestedMode === 'observe') {
    notices.push(
      '[write-auth] observe mode: unauthorized writes are RECORDED BUT ALLOWED. ' +
        'Set WRITE_AUTH_MODE=enforce once the logs show every device presenting a key.',
    );
  }
  return { mode: requestedMode, keys, notices };
}

/**
 * Constant-time key comparison. Compares SHA-256 digests rather than the raw strings so
 * that both sides are always the same length — `timingSafeEqual` throws on a length
 * mismatch, and returning early on one would leak the key's length.
 */
function keysMatch(presented: string, configured: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(configured, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Pull the presented key from `X-Write-Key`, or from `Authorization: Bearer <key>`. */
export function extractPresentedKey(req: HeaderBearingRequest): string | null {
  const header = req.headers[WRITE_KEY_HEADER];
  const direct = Array.isArray(header) ? header[0] : header;
  if (direct && direct.trim()) return direct.trim();

  const authHeader = req.headers['authorization'];
  const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match && match[1].trim()) return match[1].trim();
  }
  return null;
}

export class WriteAuth {
  readonly mode: WriteAuthMode;
  private readonly keys: WriteKeyEntry[];
  private readonly onAudit: (audit: WriteAuthAudit) => void;

  constructor(config: WriteAuthConfig, onAudit: (audit: WriteAuthAudit) => void = () => {}) {
    this.mode = config.mode;
    this.keys = config.keys;
    this.onAudit = onAudit;
  }

  /** Does this request carry a valid key? No logging, no side effects. */
  evaluate(req: HeaderBearingRequest): WriteAuthResult {
    const presented = extractPresentedKey(req);
    if (!presented) return { status: 'missing', label: null };
    for (const entry of this.keys) {
      if (keysMatch(presented, entry.key)) return { status: 'ok', label: entry.label };
    }
    return { status: 'invalid', label: null };
  }

  /**
   * Evaluate a privileged request, record the outcome, and report whether it may
   * proceed. In `observe` mode `allowed` is always true — that is the whole point of
   * the mode — but the audit record still says what `enforce` would have done.
   */
  check(req: HeaderBearingRequest, route: string): { result: WriteAuthResult; allowed: boolean } {
    if (this.mode === 'off') {
      return { result: { status: 'ok', label: null }, allowed: true };
    }
    const result = this.evaluate(req);
    const allowed = this.mode !== 'enforce' || result.status === 'ok';
    this.onAudit({ ...result, mode: this.mode, route, refused: !allowed });
    return { result, allowed };
  }

  /**
   * `check()`, plus a 401 when the request is refused. Returns true if the caller
   * should continue handling the request.
   */
  gate(
    req: HeaderBearingRequest,
    res: { status(code: number): { json(body: unknown): unknown } },
    route: string,
  ): boolean {
    const { allowed } = this.check(req, route);
    if (allowed) return true;
    res.status(401).json({
      ok: false,
      error: 'This request needs a valid write key. See docs/WRITE_KEYS.md.',
    });
    return false;
  }
}

/** Render an audit record as a single greppable log line. */
export function formatAudit(audit: WriteAuthAudit): string {
  const key = audit.status === 'ok' ? audit.label : audit.status === 'missing' ? 'none' : 'unknown';
  const outcome =
    audit.status === 'ok'
      ? 'ok'
      : audit.refused
        ? `${audit.status.toUpperCase()} (refused)`
        : `${audit.status.toUpperCase()} (allowed — observe mode)`;
  return `[write-auth] ${audit.mode} ${audit.route} key=${key} → ${outcome}`;
}
