// ClientPresenceView: an operator-facing list of who is connected to this session
// right now — which page each client has open, and what kind of device it's on.
//
// Fed by Yjs awareness rather than the `status` Y.Map, so it needs no backend and
// no heartbeat producer: awareness membership already expires 30s after a client
// stops announcing, which makes the list self-cleaning. See presence.ts for the
// constraints that come with that choice.
import { useEffect, useState } from 'react';
import { useAwareness, usePresence } from '@y-sweet/react';
import { useStrings, resolveLocale } from './useLocale';
import {
  DEVICE_ICON,
  type ClientPresence,
  type DeviceKind,
  groupByUrl,
  readClientPresence,
} from './presence';

export interface ClientPresenceViewProps {
  clients: { clientId: number; presence: ClientPresence }[];
  /** The local client's id, marked in the list so an operator can spot themselves. */
  selfClientId?: number;
}

/** A "now" that re-renders once a minute, for the connected-for ages. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** "5 minutes ago", localized. Anything under a minute reads as "now". */
function formatAge(connectedSince: number, now: number, s: ReturnType<typeof useStrings>): string {
  if (!connectedSince) return '';
  const seconds = Math.round((now - connectedSince) / 1000);
  if (seconds < 60) return s.statusPresenceJustNow;
  const format = new Intl.RelativeTimeFormat(resolveLocale(), { numeric: 'auto' });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return format.format(-minutes, 'minute');
  return format.format(-Math.round(minutes / 60), 'hour');
}

function deviceLabel(kind: DeviceKind, s: ReturnType<typeof useStrings>): string {
  switch (kind) {
    case 'phone':
      return s.statusDevicePhone;
    case 'tablet':
      return s.statusDeviceTablet;
    case 'desktop':
      return s.statusDeviceDesktop;
    default:
      return s.statusDeviceUnknown;
  }
}

export function ClientPresenceView({ clients, selfClientId }: ClientPresenceViewProps) {
  const s = useStrings();
  const now = useNow(clients.length > 0);

  if (clients.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{s.statusPresenceEmpty}</p>;
  }

  const groups = groupByUrl(clients);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {s.statusPresenceConnected} ({clients.length})
      </p>
      {groups.map((group) => (
        <div
          key={group.url}
          className="rounded border border-gray-200 dark:border-gray-700 p-3 flex flex-col gap-2"
        >
          <div className="flex items-baseline gap-2">
            <code className="text-xs break-all">{group.url}</code>
            <span className="ml-auto text-xs tabular-nums text-gray-500 dark:text-gray-400 shrink-0">
              {group.clients.length}
            </span>
          </div>
          <ul className="flex flex-col gap-1">
            {group.clients.map(({ clientId, presence }) => (
              <li key={clientId} className="flex items-center gap-2 text-xs">
                <span aria-hidden="true">{DEVICE_ICON[presence.device.kind]}</span>
                <span>{deviceLabel(presence.device.kind, s)}</span>
                {presence.device.platform && (
                  <span className="text-gray-500 dark:text-gray-400">
                    {[presence.device.platform, presence.device.browser].filter(Boolean).join(' · ')}
                  </span>
                )}
                {presence.role === 'editor' && (
                  <span className="px-1.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                    {s.statusPresenceEditor}
                  </span>
                )}
                {clientId === selfClientId && (
                  <span className="px-1.5 rounded bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                    {s.statusPresenceYou}
                  </span>
                )}
                {presence.locale && (
                  <span className="text-gray-400 dark:text-gray-500 uppercase">{presence.locale}</span>
                )}
                <span className="ml-auto tabular-nums text-gray-500 dark:text-gray-400 shrink-0">
                  {formatAge(presence.connectedSince, now, s)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Yjs connector: reads awareness presence for every client on this session. */
export function ClientPresenceViewContainer() {
  // includeSelf so the operator's own device is accounted for in the count —
  // otherwise "1 connected" on a page you're looking at reads as a bug.
  const presence = usePresence<ClientPresence>({ includeSelf: true });
  const awareness = useAwareness();

  const clients: { clientId: number; presence: ClientPresence }[] = [];
  presence.forEach((raw, clientId) => {
    // Awareness carries whatever any client puts there, including states from
    // older builds and other features, so validate instead of casting.
    const parsed = readClientPresence(raw);
    if (parsed) clients.push({ clientId, presence: parsed });
  });

  return <ClientPresenceView clients={clients} selfClientId={awareness?.clientID} />;
}

export default ClientPresenceView;
