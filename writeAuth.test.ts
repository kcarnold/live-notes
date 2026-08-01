import { describe, it, expect, vi } from 'vitest';
import {
  WriteAuth,
  extractPresentedKey,
  formatAudit,
  parseWriteAuthMode,
  parseWriteKeys,
  resolveWriteAuthConfig,
  type WriteAuthAudit,
} from './writeAuth.ts';

const req = (headers: Record<string, string | string[] | undefined>) => ({ headers });

describe('parseWriteKeys', () => {
  it('returns nothing for unset or empty input', () => {
    expect(parseWriteKeys(undefined)).toEqual([]);
    expect(parseWriteKeys('')).toEqual([]);
    expect(parseWriteKeys('   ')).toEqual([]);
  });

  it('parses labelled entries', () => {
    expect(parseWriteKeys('proclaim:abc123,tablet:def456')).toEqual([
      { label: 'proclaim', key: 'abc123' },
      { label: 'tablet', key: 'def456' },
    ]);
  });

  it('gives bare keys a positional label', () => {
    expect(parseWriteKeys('abc123,def456')).toEqual([
      { label: 'key1', key: 'abc123' },
      { label: 'key2', key: 'def456' },
    ]);
  });

  it('tolerates whitespace and trailing commas', () => {
    expect(parseWriteKeys(' proclaim : abc123 , , tablet:def456 ,')).toEqual([
      { label: 'proclaim', key: 'abc123' },
      { label: 'tablet', key: 'def456' },
    ]);
  });

  it('drops entries with an empty key so nothing ever matches the empty string', () => {
    expect(parseWriteKeys('label:,:,good:abc123')).toEqual([
      { label: 'good', key: 'abc123' },
    ]);
  });

  it('keeps colons that appear inside the key itself', () => {
    expect(parseWriteKeys('proclaim:abc:123')).toEqual([
      { label: 'proclaim', key: 'abc:123' },
    ]);
  });
});

describe('parseWriteAuthMode', () => {
  it('defaults to observe when unset', () => {
    expect(parseWriteAuthMode(undefined)).toBe('observe');
    expect(parseWriteAuthMode('')).toBe('observe');
  });

  it('accepts the three modes, case-insensitively', () => {
    expect(parseWriteAuthMode('off')).toBe('off');
    expect(parseWriteAuthMode('Observe')).toBe('observe');
    expect(parseWriteAuthMode(' ENFORCE ')).toBe('enforce');
  });

  it('throws on a typo rather than silently allowing everything', () => {
    expect(() => parseWriteAuthMode('enfoce')).toThrow(/off\|observe\|enforce/);
  });
});

describe('resolveWriteAuthConfig', () => {
  it('turns itself off when no keys are configured', () => {
    const config = resolveWriteAuthConfig({});
    expect(config.mode).toBe('off');
    expect(config.notices.join('\n')).toMatch(/no WRITE_KEYS configured/);
  });

  it('defaults to observe once keys exist', () => {
    const config = resolveWriteAuthConfig({ WRITE_KEYS: 'proclaim:0123456789abcdef' });
    expect(config.mode).toBe('observe');
    expect(config.keys).toHaveLength(1);
    expect(config.notices.join('\n')).toMatch(/RECORDED BUT ALLOWED/);
  });

  it('refuses to start in enforce mode with no keys', () => {
    expect(() => resolveWriteAuthConfig({ WRITE_AUTH_MODE: 'enforce' })).toThrow(
      /requires at least one key/,
    );
  });

  it('warns about implausibly short keys but still starts', () => {
    const config = resolveWriteAuthConfig({ WRITE_KEYS: 'tablet:hunter2' });
    expect(config.mode).toBe('observe');
    expect(config.notices.join('\n')).toMatch(/short key\(s\) \[tablet\]/);
  });
});

describe('extractPresentedKey', () => {
  it('reads the X-Write-Key header', () => {
    expect(extractPresentedKey(req({ 'x-write-key': 'abc123' }))).toBe('abc123');
  });

  it('reads an Authorization: Bearer header', () => {
    expect(extractPresentedKey(req({ authorization: 'Bearer abc123' }))).toBe('abc123');
    expect(extractPresentedKey(req({ authorization: 'bearer abc123' }))).toBe('abc123');
  });

  it('prefers X-Write-Key when both are present', () => {
    expect(
      extractPresentedKey(req({ 'x-write-key': 'abc123', authorization: 'Bearer other' })),
    ).toBe('abc123');
  });

  it('trims surrounding whitespace', () => {
    expect(extractPresentedKey(req({ 'x-write-key': '  abc123  ' }))).toBe('abc123');
  });

  it('returns null when absent, blank, or a non-Bearer scheme', () => {
    expect(extractPresentedKey(req({}))).toBeNull();
    expect(extractPresentedKey(req({ 'x-write-key': '   ' }))).toBeNull();
    expect(extractPresentedKey(req({ authorization: 'Basic abc123' }))).toBeNull();
  });

  it('uses the first value when a header is repeated', () => {
    expect(extractPresentedKey(req({ 'x-write-key': ['abc123', 'def456'] }))).toBe('abc123');
  });
});

describe('WriteAuth.evaluate', () => {
  const auth = new WriteAuth(
    resolveWriteAuthConfig({ WRITE_KEYS: 'proclaim:0123456789abcdef,tablet:fedcba9876543210' }),
  );

  it('matches a configured key and reports its label', () => {
    expect(auth.evaluate(req({ 'x-write-key': '0123456789abcdef' }))).toEqual({
      status: 'ok',
      label: 'proclaim',
    });
    expect(auth.evaluate(req({ 'x-write-key': 'fedcba9876543210' }))).toEqual({
      status: 'ok',
      label: 'tablet',
    });
  });

  it('reports a missing key separately from a wrong one', () => {
    expect(auth.evaluate(req({}))).toEqual({ status: 'missing', label: null });
    expect(auth.evaluate(req({ 'x-write-key': 'nope' }))).toEqual({
      status: 'invalid',
      label: null,
    });
  });

  it('does not match a prefix, a suffix, or a different case', () => {
    expect(auth.evaluate(req({ 'x-write-key': '0123456789abcde' })).status).toBe('invalid');
    expect(auth.evaluate(req({ 'x-write-key': '0123456789abcdefg' })).status).toBe('invalid');
    expect(auth.evaluate(req({ 'x-write-key': '0123456789ABCDEF' })).status).toBe('invalid');
  });
});

describe('WriteAuth.check', () => {
  const keys = { WRITE_KEYS: 'proclaim:0123456789abcdef' };

  it('allows everything and audits nothing when off', () => {
    const onAudit = vi.fn();
    const auth = new WriteAuth(resolveWriteAuthConfig({}), onAudit);
    expect(auth.check(req({}), '/api/translateItem').allowed).toBe(true);
    expect(onAudit).not.toHaveBeenCalled();
  });

  it('allows an unauthorized request in observe mode, but records what enforce would do', () => {
    const audits: WriteAuthAudit[] = [];
    const auth = new WriteAuth(resolveWriteAuthConfig(keys), (a) => audits.push(a));

    expect(auth.check(req({}), '/api/translateItem').allowed).toBe(true);

    expect(audits).toEqual([
      {
        mode: 'observe',
        route: '/api/translateItem',
        status: 'missing',
        label: null,
        refused: false,
      },
    ]);
  });

  it('refuses an unauthorized request in enforce mode', () => {
    const audits: WriteAuthAudit[] = [];
    const auth = new WriteAuth(
      resolveWriteAuthConfig({ ...keys, WRITE_AUTH_MODE: 'enforce' }),
      (a) => audits.push(a),
    );

    expect(auth.check(req({}), '/api/ys-auth').allowed).toBe(false);
    expect(auth.check(req({ 'x-write-key': 'wrong' }), '/api/ys-auth').allowed).toBe(false);
    expect(auth.check(req({ 'x-write-key': '0123456789abcdef' }), '/api/ys-auth').allowed).toBe(
      true,
    );

    expect(audits.map((a) => [a.status, a.refused])).toEqual([
      ['missing', true],
      ['invalid', true],
      ['ok', false],
    ]);
  });
});

describe('WriteAuth.gate', () => {
  const enforcing = () =>
    new WriteAuth(
      resolveWriteAuthConfig({
        WRITE_KEYS: 'proclaim:0123456789abcdef',
        WRITE_AUTH_MODE: 'enforce',
      }),
    );

  const fakeRes = () => {
    const json = vi.fn();
    return { json, status: vi.fn(() => ({ json })) };
  };

  it('sends a 401 and stops the request when refused', () => {
    const res = fakeRes();
    expect(enforcing().gate(req({}), res, '/api/translateItem')).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.stringContaining('write key') }),
    );
  });

  it('leaves the response untouched when authorized', () => {
    const res = fakeRes();
    expect(
      enforcing().gate(req({ 'x-write-key': '0123456789abcdef' }), res, '/api/translateItem'),
    ).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('formatAudit', () => {
  const base = { mode: 'observe' as const, route: '/api/ys-auth' };

  it('names the device on success', () => {
    expect(formatAudit({ ...base, status: 'ok', label: 'proclaim', refused: false })).toBe(
      '[write-auth] observe /api/ys-auth key=proclaim → ok',
    );
  });

  it('spells out that observe mode let an unauthorized request through', () => {
    expect(formatAudit({ ...base, status: 'missing', label: null, refused: false })).toBe(
      '[write-auth] observe /api/ys-auth key=none → MISSING (allowed — observe mode)',
    );
  });

  it('marks a refusal', () => {
    expect(
      formatAudit({ ...base, mode: 'enforce', status: 'invalid', label: null, refused: true }),
    ).toBe('[write-auth] enforce /api/ys-auth key=unknown → INVALID (refused)');
  });
});
