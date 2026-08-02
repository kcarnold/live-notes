// Client presence: what each connected browser publishes about itself over Yjs
// awareness, so the status page can answer "who is on this session right now, on
// what page, from what kind of device?".
//
// This rides awareness rather than the `status` Y.Map, and that choice carries a
// few constraints worth knowing before adding fields:
//
//   - Awareness is already running. y-protocols' Awareness constructor calls
//     setLocalState({}), so every client announces itself, re-announces every
//     ~15s, and is dropped after 30s of silence. Membership *is* the liveness
//     signal; nothing here needs a heartbeat.
//   - Every field must be stable for the lifetime of a connection (or change
//     only on real user action). Each re-announce broadcasts the whole state to
//     every other client, so a ticking value — an age, a counter — turns into
//     O(n²) chatter with a congregation's worth of phones on the doc. That's why
//     `connectedSince` is a fixed timestamp the viewer subtracts from, not an age.
//   - Awareness is broadcast to *all* clients, not just whoever opened /status.
//     Anything published here is readable by any viewer with devtools, so this
//     deliberately carries a coarse device kind and never the raw user-agent.
//
// Read-only viewers can publish presence: y-sweet gates writes on SyncStep2 and
// Update messages, but relays Message::Awareness without an authorization check.
// That matters, because viewers are most of who we want to see here.

/** Coarse device classes. Deliberately coarse — see the privacy note above. */
export type DeviceKind = 'phone' | 'tablet' | 'desktop' | 'unknown';

export interface DeviceInfo {
  kind: DeviceKind;
  /** OS family, e.g. 'iOS', 'Android', 'macOS', 'Windows'. '' when unknown. */
  platform: string;
  /** Browser family, e.g. 'Safari', 'Chrome'. Omitted when unrecognizable. */
  browser?: string;
}

/** What a client publishes about itself. Keep every field stable per connection. */
export interface ClientPresence {
  /** pathname + search + hash — the layout string is the interesting part. */
  url: string;
  role: 'editor' | 'viewer';
  device: DeviceInfo;
  /** Resolved UI locale ('en' | 'fr' | 'ht' | 'es'). */
  locale: string;
  /** Epoch ms when this client connected. A fixed instant, never an age. */
  connectedSince: number;
}

/**
 * The slice of `navigator` device detection needs. Declared structurally so tests
 * can pass a plain object and so the Chromium-only `userAgentData` stays optional.
 */
export interface DeviceNavigator {
  userAgent: string;
  maxTouchPoints?: number;
  userAgentData?: {
    mobile?: boolean;
    platform?: string;
  };
}

function detectPlatform(ua: string): string {
  // Order matters: Android UAs also contain "Linux", and iPadOS contains "Mac OS X".
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return '';
}

function detectBrowser(ua: string): string | undefined {
  // Order matters: every Chromium browser claims "Safari", and Edge/Opera also
  // claim "Chrome", so the most specific token has to be tested first.
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\/|FxiOS/.test(ua)) return 'Firefox';
  if (/CriOS/.test(ua)) return 'Chrome';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return undefined;
}

/**
 * Classify the device from whatever signals are available.
 *
 * `userAgentData.mobile` (Chromium) is the only first-class signal and settles
 * phone-vs-desktop when present, but it doesn't distinguish tablets, so the UA
 * still decides that. The case that needs real care is iPadOS 13+, which
 * identifies as "Macintosh" — `maxTouchPoints > 1` is what separates an iPad from
 * a Mac, and without it every iPad in the room reads as a desktop.
 */
export function describeDevice(nav: DeviceNavigator): DeviceInfo {
  const ua = nav.userAgent ?? '';
  const touchPoints = nav.maxTouchPoints ?? 0;
  const platform = detectPlatform(ua);
  const browser = detectBrowser(ua);

  // A touch-capable "Macintosh" is an iPad claiming desktop-class Safari. This has
  // to match "Macintosh" specifically, not "Mac OS X": every iPhone UA also says
  // "like Mac OS X", and iPhones have touch points too.
  const isIpadOS = /Macintosh/i.test(ua) && touchPoints > 1;

  let kind: DeviceKind;
  if (/iPhone|iPod/i.test(ua)) {
    kind = 'phone';
  } else if (/iPad/i.test(ua) || isIpadOS) {
    kind = 'tablet';
  } else if (/Android/i.test(ua)) {
    // Android tablets are the ones that drop "Mobile" from the UA.
    kind = /Mobile/i.test(ua) ? 'phone' : 'tablet';
  } else if (nav.userAgentData?.mobile === true) {
    kind = 'phone';
  } else if (platform) {
    kind = 'desktop';
  } else {
    kind = 'unknown';
  }

  return {
    kind,
    // Chromium's platform hint is more trustworthy than UA sniffing when present.
    platform: nav.userAgentData?.platform || platform,
    ...(browser ? { browser } : {}),
  };
}

/** The current location as published — path, query, and hash, no origin. */
export function currentUrl(location: Pick<Location, 'pathname' | 'search' | 'hash'>): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

/**
 * Narrow an awareness state into a ClientPresence, or null if it isn't one.
 *
 * Awareness carries whatever any client chooses to put there, including states
 * from other features and from clients running older builds, so the status view
 * validates rather than casts.
 */
export function readClientPresence(raw: unknown): ClientPresence | null {
  if (!raw || typeof raw !== 'object') return null;
  const { url, role, device, locale, connectedSince } = raw as Record<string, unknown>;
  if (typeof url !== 'string') return null;
  if (role !== 'editor' && role !== 'viewer') return null;

  const deviceRecord = (device && typeof device === 'object' ? device : {}) as Record<string, unknown>;
  const kind = deviceRecord.kind;
  return {
    url,
    role,
    device: {
      kind:
        kind === 'phone' || kind === 'tablet' || kind === 'desktop' ? kind : 'unknown',
      platform: typeof deviceRecord.platform === 'string' ? deviceRecord.platform : '',
      ...(typeof deviceRecord.browser === 'string' && deviceRecord.browser
        ? { browser: deviceRecord.browser }
        : {}),
    },
    locale: typeof locale === 'string' ? locale : '',
    connectedSince: typeof connectedSince === 'number' ? connectedSince : 0,
  };
}

/** Emoji marker per device class, for the presence rows. */
export const DEVICE_ICON: Record<DeviceKind, string> = {
  phone: '📱',
  tablet: '📖',
  desktop: '🖥️',
  unknown: '❔',
};

export interface PresenceGroup {
  url: string;
  clients: { clientId: number; presence: ClientPresence }[];
}

/**
 * Group clients by the URL they're on, which is how an operator actually reads
 * this ("12 on the French view, 1 editor broadcasting"). Groups are ordered
 * largest first, and clients within a group oldest connection first, so the list
 * stays stable as people join and leave.
 */
export function groupByUrl(
  clients: { clientId: number; presence: ClientPresence }[],
): PresenceGroup[] {
  const groups = new Map<string, PresenceGroup>();
  for (const client of clients) {
    let group = groups.get(client.presence.url);
    if (!group) {
      group = { url: client.presence.url, clients: [] };
      groups.set(client.presence.url, group);
    }
    group.clients.push(client);
  }
  const ordered = [...groups.values()];
  for (const group of ordered) {
    group.clients.sort(
      (a, b) =>
        a.presence.connectedSince - b.presence.connectedSince || a.clientId - b.clientId,
    );
  }
  ordered.sort((a, b) => b.clients.length - a.clients.length || a.url.localeCompare(b.url));
  return ordered;
}
