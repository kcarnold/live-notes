import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WRITE_KEY_HEADER,
  apiFetch,
  getWriteKey,
  hasWriteKey,
  initWriteKey,
  maskWriteKey,
  promptForWriteKeyOnce,
  resetWriteKeyCache,
  setWriteKey,
} from './writeKey.ts';

/** Point jsdom at a URL, the way a device would be provisioned. */
function visit(url: string) {
  window.history.replaceState(null, '', url);
}

beforeEach(() => {
  window.localStorage.clear();
  resetWriteKeyCache();
  visit('/notes');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('initWriteKey', () => {
  it('captures a key from the fragment and scrubs it from the address bar', () => {
    visit('/notes#editor&key=SECRET123');

    expect(initWriteKey()).toBe('SECRET123');
    expect(getWriteKey()).toBe('SECRET123');
    expect(window.location.href).not.toContain('SECRET123');
  });

  it('leaves the rest of the fragment alone, including the bare #editor flag', () => {
    visit('/notes#editor&key=SECRET123');
    initWriteKey();
    // App.tsx routes on hash.includes("editor"), so this must survive verbatim.
    expect(window.location.hash).toBe('#editor');
  });

  it('captures a key from the query string too, preserving other params', () => {
    visit('/notes?doc=doc-2026-08-02&key=SECRET123#editor');

    expect(initWriteKey()).toBe('SECRET123');
    expect(window.location.search).toBe('?doc=doc-2026-08-02');
    expect(window.location.hash).toBe('#editor');
  });

  it('prefers the fragment when a key appears in both places', () => {
    visit('/notes?key=FROM_QUERY#key=FROM_HASH');
    expect(initWriteKey()).toBe('FROM_HASH');
  });

  it('url-decodes the key', () => {
    visit('/notes#key=a%2Fb%2Bc');
    expect(initWriteKey()).toBe('a/b+c');
  });

  it('persists across a reload', () => {
    visit('/notes#editor&key=SECRET123');
    initWriteKey();

    resetWriteKeyCache();
    visit('/notes#editor');

    expect(initWriteKey()).toBe('SECRET123');
    expect(hasWriteKey()).toBe(true);
  });

  it('keeps the stored key when the URL has none', () => {
    setWriteKey('STORED');
    resetWriteKeyCache();
    visit('/notes#editor');

    expect(initWriteKey()).toBe('STORED');
  });

  it('replaces the stored key when a new one arrives', () => {
    setWriteKey('OLD');
    visit('/notes#key=NEW');

    expect(initWriteKey()).toBe('NEW');
    expect(getWriteKey()).toBe('NEW');
  });

  it('returns null when no key has ever been seen', () => {
    expect(initWriteKey()).toBeNull();
    expect(hasWriteKey()).toBe(false);
  });

  it('ignores an empty key param', () => {
    visit('/notes#editor&key=');
    expect(initWriteKey()).toBeNull();
  });

  it('still works for the tab when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    visit('/notes#key=SECRET123');

    expect(initWriteKey()).toBe('SECRET123');
    expect(getWriteKey()).toBe('SECRET123');
  });
});

describe('setWriteKey', () => {
  it('stores a hand-typed key', () => {
    setWriteKey('  TYPED  ');
    resetWriteKeyCache();
    expect(getWriteKey()).toBe('TYPED');
  });

  it('clears the device key with null or blank', () => {
    setWriteKey('TYPED');
    setWriteKey(null);
    expect(getWriteKey()).toBeNull();

    setWriteKey('TYPED');
    setWriteKey('   ');
    expect(getWriteKey()).toBeNull();
  });
});

describe('apiFetch', () => {
  const mockFetch = () => {
    const spy = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', spy);
    return spy;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches the key when the device has one', async () => {
    setWriteKey('SECRET123');
    const spy = mockFetch();

    await apiFetch('/api/translateItem', { method: 'POST' });

    const init = spy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get(WRITE_KEY_HEADER)).toBe('SECRET123');
  });

  it('preserves headers the caller already set', async () => {
    setWriteKey('SECRET123');
    const spy = mockFetch();

    await apiFetch('/api/translateItem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const headers = new Headers((spy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get(WRITE_KEY_HEADER)).toBe('SECRET123');
  });

  it('sends nothing extra when the device has no key', async () => {
    const spy = mockFetch();

    await apiFetch('/api/tts', { method: 'POST' });

    const init = spy.mock.calls[0][1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get(WRITE_KEY_HEADER)).toBeNull();
  });
});

describe('maskWriteKey', () => {
  it('shows only the tail, enough to tell two keys apart during a rotation', () => {
    expect(maskWriteKey('kZ8xQ2vLm4vt7Rb9ab12')).toBe('…ab12');
  });

  it('gives away nothing about a key too short to mask', () => {
    expect(maskWriteKey('abcd')).toBe('…');
  });
});

describe('promptForWriteKeyOnce', () => {
  it('stores what was typed and asks the caller to retry', () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('  NEWKEY  ');

    expect(promptForWriteKeyOnce('needs a key')).toBe(true);
    expect(prompt).toHaveBeenCalledWith('needs a key');
    expect(getWriteKey()).toBe('NEWKEY');
  });

  it('asks only once per page load', () => {
    // The guard that matters: y-sweet re-invokes its auth endpoint on every reconnect
    // cycle that exhausts the retry budget, so without this a flaky booth wifi would
    // throw a blocking modal onto the editor tablet over and over mid-service.
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('NEWKEY');

    expect(promptForWriteKeyOnce('needs a key')).toBe(true);
    expect(promptForWriteKeyOnce('needs a key')).toBe(false);
    expect(promptForWriteKeyOnce('needs a key')).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('does not ask again after the operator cancels', () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);

    expect(promptForWriteKeyOnce('needs a key')).toBe(false);
    expect(promptForWriteKeyOnce('needs a key')).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(getWriteKey()).toBeNull();
  });

  it('leaves an existing key alone when the operator submits nothing', () => {
    setWriteKey('OLDKEY');
    vi.spyOn(window, 'prompt').mockReturnValue('   ');

    expect(promptForWriteKeyOnce('needs a key')).toBe(false);
    expect(getWriteKey()).toBe('OLDKEY');
  });

  it('survives a context where prompt() is unavailable', () => {
    vi.spyOn(window, 'prompt').mockImplementation(() => {
      throw new Error('blocked in a sandboxed iframe');
    });

    expect(promptForWriteKeyOnce('needs a key')).toBe(false);
  });
});
