import { describe, it, expect } from 'vitest';
import {
  type ClientPresence,
  currentUrl,
  describeDevice,
  groupByUrl,
  readClientPresence,
} from './presence';

// Real user-agent strings, because every interesting case here is a quirk of a
// specific device lying about what it is.
const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadOld:
    'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
  // iPadOS 13+ claims to be a Mac; only maxTouchPoints gives it away.
  ipadDesktopClass:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  androidPhone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  firefox:
    'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
};

describe('describeDevice', () => {
  it('classifies an iPhone as a phone on iOS', () => {
    const device = describeDevice({ userAgent: UA.iphone, maxTouchPoints: 5 });
    expect(device.kind).toBe('phone');
    expect(device.platform).toBe('iOS');
    expect(device.browser).toBe('Safari');
  });

  it('classifies an older iPad as a tablet', () => {
    expect(describeDevice({ userAgent: UA.ipadOld, maxTouchPoints: 5 }).kind).toBe('tablet');
  });

  it('classifies a desktop-class iPad as a tablet, not a Mac', () => {
    // The UA is identical to a Mac's; maxTouchPoints is the only distinguishing signal.
    expect(describeDevice({ userAgent: UA.ipadDesktopClass, maxTouchPoints: 5 }).kind).toBe(
      'tablet',
    );
  });

  it('classifies a real Mac as a desktop', () => {
    const device = describeDevice({ userAgent: UA.mac, maxTouchPoints: 0 });
    expect(device.kind).toBe('desktop');
    expect(device.platform).toBe('macOS');
    expect(device.browser).toBe('Chrome');
  });

  it('splits Android phones from Android tablets on the Mobile token', () => {
    expect(describeDevice({ userAgent: UA.androidPhone }).kind).toBe('phone');
    expect(describeDevice({ userAgent: UA.androidTablet }).kind).toBe('tablet');
    expect(describeDevice({ userAgent: UA.androidPhone }).platform).toBe('Android');
  });

  it('prefers the Chromium platform hint over sniffing the user-agent', () => {
    const device = describeDevice({
      userAgent: UA.windows,
      userAgentData: { mobile: false, platform: 'Windows' },
    });
    expect(device.kind).toBe('desktop');
    expect(device.platform).toBe('Windows');
  });

  it('reads userAgentData.mobile when the user-agent gives no platform away', () => {
    const device = describeDevice({
      userAgent: 'Mozilla/5.0',
      userAgentData: { mobile: true, platform: 'Unknown' },
    });
    expect(device.kind).toBe('phone');
  });

  it('picks the most specific browser token', () => {
    // Edge claims Chrome and Safari; Chrome claims Safari.
    expect(describeDevice({ userAgent: UA.windows }).browser).toBe('Edge');
    expect(describeDevice({ userAgent: UA.firefox }).browser).toBe('Firefox');
  });

  it('falls back to unknown rather than guessing', () => {
    const device = describeDevice({ userAgent: '' });
    expect(device.kind).toBe('unknown');
    expect(device.platform).toBe('');
    expect(device.browser).toBeUndefined();
  });
});

describe('currentUrl', () => {
  it('joins path, query, and hash without the origin', () => {
    expect(
      currentUrl({ pathname: '/translatedText-French', search: '?doc=doc-1', hash: '#editor' }),
    ).toBe('/translatedText-French?doc=doc-1#editor');
  });
});

describe('readClientPresence', () => {
  const valid = {
    url: '/sourceText',
    role: 'editor',
    device: { kind: 'desktop', platform: 'macOS', browser: 'Chrome' },
    locale: 'en',
    connectedSince: 1_700_000_000_000,
  };

  it('accepts a well-formed presence state', () => {
    expect(readClientPresence(valid)).toEqual(valid);
  });

  it('rejects states that are not client presence', () => {
    // Awareness is a shared channel: other features and older builds put things there.
    expect(readClientPresence({})).toBeNull();
    expect(readClientPresence(null)).toBeNull();
    expect(readClientPresence('nope')).toBeNull();
    expect(readClientPresence({ cursor: { x: 1 } })).toBeNull();
    expect(readClientPresence({ ...valid, role: 'admin' })).toBeNull();
  });

  it('defaults the fields a partial state is missing', () => {
    const parsed = readClientPresence({ url: '/status', role: 'viewer' });
    expect(parsed).toEqual({
      url: '/status',
      role: 'viewer',
      device: { kind: 'unknown', platform: '' },
      locale: '',
      connectedSince: 0,
    });
  });
});

describe('groupByUrl', () => {
  const client = (
    clientId: number,
    url: string,
    connectedSince: number,
  ): { clientId: number; presence: ClientPresence } => ({
    clientId,
    presence: {
      url,
      role: 'viewer',
      device: { kind: 'phone', platform: 'iOS' },
      locale: 'fr',
      connectedSince,
    },
  });

  it('groups clients by URL, largest group first', () => {
    const groups = groupByUrl([
      client(1, '/sourceText', 100),
      client(2, '/translatedText-French', 100),
      client(3, '/translatedText-French', 100),
    ]);
    expect(groups.map((g) => [g.url, g.clients.length])).toEqual([
      ['/translatedText-French', 2],
      ['/sourceText', 1],
    ]);
  });

  it('orders clients within a group by connection time, oldest first', () => {
    const groups = groupByUrl([client(9, '/status', 300), client(4, '/status', 100)]);
    expect(groups[0].clients.map((c) => c.clientId)).toEqual([4, 9]);
  });

  it('returns nothing for no clients', () => {
    expect(groupByUrl([])).toEqual([]);
  });
});
