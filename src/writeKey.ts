/**
 * The browser half of shared-key write authorization (server side: ../writeAuth.ts).
 *
 * The unit being authorized is a *device*, not a person: the booth laptop, the tablet on
 * the music stand. So the key arrives once in a URL, is stored in localStorage, and is
 * then attached to every API request that device makes from then on — no login, no
 * session, nothing to re-enter next Sunday.
 *
 * Provisioning a device means opening a URL with the key in it:
 *
 *   https://…/notes#editor&key=THEKEY      ← preferred: a fragment never leaves the browser
 *   https://…/notes?key=THEKEY#editor      ← also accepted, but reaches the server's logs
 *
 * Either form is removed from the address bar immediately after being stored, so the key
 * doesn't linger on screen, in a bookmark, or in a screenshot of the projector laptop.
 */

/** Must match WRITE_KEY_HEADER in ../writeAuth.ts (not imported: that module is Node-only). */
export const WRITE_KEY_HEADER = 'X-Write-Key';

const STORAGE_KEY = 'live-notes:writeKey';

/**
 * Fallback for when localStorage is unavailable (Safari private browsing, a locked-down
 * kiosk profile). The key then lasts only as long as the tab, which still beats failing.
 */
let memoryKey: string | null = null;

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(key: string | null): void {
  try {
    if (key === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Ignored: memoryKey already holds the value for this tab.
  }
}

/** Pull `key=…` out of a `a=1&b=2` style string, if present and non-empty. */
function readKeyParam(raw: string): string | null {
  for (const part of raw.split('&')) {
    const match = /^key=(.*)$/i.exec(part);
    if (!match) continue;
    let value: string;
    try {
      value = decodeURIComponent(match[1].replace(/\+/g, ' '));
    } catch {
      value = match[1];
    }
    if (value.trim()) return value.trim();
  }
  return null;
}

/**
 * Remove `key=…` while leaving every other part untouched — including valueless flags
 * like the `#editor` this app routes on, which a URLSearchParams round-trip would
 * rewrite to `editor=`.
 */
function stripKeyParam(raw: string): string {
  return raw
    .split('&')
    .filter((part) => !/^key=/i.test(part))
    .join('&');
}

/**
 * Capture a key from the current URL, store it, and scrub it from the address bar.
 * Idempotent, and safe to call when there is no key in the URL: an already-stored key
 * is kept. Returns the key now in effect, if any.
 */
export function initWriteKey(): string | null {
  const search = window.location.search.replace(/^\?/, '');
  const hash = window.location.hash.replace(/^#/, '');
  // The fragment wins: it is the form that never reaches a server log.
  const fromUrl = readKeyParam(hash) ?? readKeyParam(search);

  if (fromUrl) {
    memoryKey = fromUrl;
    writeStored(fromUrl);

    const strippedSearch = stripKeyParam(search);
    const strippedHash = stripKeyParam(hash);
    const url =
      window.location.pathname +
      (strippedSearch ? `?${strippedSearch}` : '') +
      (strippedHash ? `#${strippedHash}` : '');
    try {
      window.history.replaceState(window.history.state, '', url);
    } catch {
      // Non-fatal: the key is stored either way, it just stays visible in the bar.
    }
    return fromUrl;
  }

  memoryKey = readStored();
  return memoryKey;
}

/** The key this device holds, or null. */
export function getWriteKey(): string | null {
  if (memoryKey) return memoryKey;
  memoryKey = readStored();
  return memoryKey;
}

export function hasWriteKey(): boolean {
  return getWriteKey() !== null;
}

/** Store a key typed in by hand, or clear this device's key with `null`. */
export function setWriteKey(key: string | null): void {
  const normalized = key?.trim() ? key.trim() : null;
  memoryKey = normalized;
  writeStored(normalized);
}

/**
 * Show the last few characters of a key, for answering "which key is this device on?"
 * during a rotation without putting the secret on a projector. Four characters of a
 * 48-character random key identifies it among the handful in `WRITE_KEYS` and is
 * useless to anyone who doesn't already have the list.
 */
export function maskWriteKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 4) return '…';
  return `…${trimmed.slice(-4)}`;
}

/**
 * True once this page load has asked for a key. The guard is the whole reason this
 * lives here rather than at the call site: y-sweet re-invokes its auth endpoint on
 * every reconnect cycle that exhausts the retry budget, so an unguarded prompt would
 * throw a blocking modal onto the editor tablet every time the wifi hiccups mid-service
 * — a far worse failure than the missing key it is trying to fix.
 */
let hasPrompted = false;

/**
 * Ask for this device's key and store what is typed. Once per page load, whatever the
 * answer: someone who cancels has said no, and asking again on the next reconnect would
 * be nagging. Returns true only when a new key was stored, i.e. when it is worth the
 * caller retrying the request that provoked this.
 */
export function promptForWriteKeyOnce(message: string): boolean {
  if (hasPrompted) return false;
  hasPrompted = true;
  let typed: string | null;
  try {
    typed = window.prompt(message);
  } catch {
    // prompt() is unavailable (sandboxed iframe, some kiosk profiles). The device can
    // still be provisioned by URL or from the status page.
    return false;
  }
  if (!typed?.trim()) return false;
  setWriteKey(typed.trim());
  return true;
}

/** Reset the module's caches, as if this were a fresh page load. Tests only. */
export function resetWriteKeyCache(): void {
  memoryKey = null;
  hasPrompted = false;
}

/**
 * `fetch`, plus this device's write key when it has one. Use it for every `/api/` call:
 * requests that don't need a key are unaffected by carrying one, and routing them all
 * through here means a newly privileged endpoint doesn't need a new call site audited.
 */
export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const key = getWriteKey();
  if (!key) return fetch(input, init);
  const headers = new Headers(init.headers);
  headers.set(WRITE_KEY_HEADER, key);
  return fetch(input, { ...init, headers });
}
