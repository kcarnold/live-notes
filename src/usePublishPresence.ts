// Publishes this client's presence over Yjs awareness. Mounted once inside the
// session's YDocProvider (App.tsx) so it runs on *every* page, not just /status:
// @y-sweet/react's usePresence skips clients whose awareness state is empty, so a
// client that never publishes is invisible to the status view.
import { useEffect, useRef, useState } from 'react';
import { usePresenceSetter } from '@y-sweet/react';
import { useAtomValue } from 'jotai';
import { isEditorAtom } from './configAtoms';
import { resolveLocale } from './useLocale';
import { type ClientPresence, currentUrl, describeDevice } from './presence';

/** How often to re-read the URL. See useCurrentUrl for why polling. */
const URL_POLL_MS = 2000;

/**
 * The current path/query/hash, kept fresh however it changes.
 *
 * The language selector rewrites the layout with `history.replaceState`
 * (App.tsx), which fires no event and doesn't remount, so a one-shot read at
 * mount goes stale the moment someone switches language. Rather than thread
 * routing state out of LayoutPage, this listens to the events that do exist and
 * polls at a low rate to catch replaceState. Deliberately dumber than the
 * alternative, and it can't miss a mutation path we didn't think of.
 */
function useCurrentUrl(): string {
  const [url, setUrl] = useState(() => currentUrl(window.location));
  useEffect(() => {
    const read = () => setUrl(currentUrl(window.location));
    read(); // the URL may have changed between the initializer and this effect
    window.addEventListener('popstate', read);
    window.addEventListener('hashchange', read);
    const id = setInterval(read, URL_POLL_MS);
    return () => {
      window.removeEventListener('popstate', read);
      window.removeEventListener('hashchange', read);
      clearInterval(id);
    };
  }, []);
  return url;
}

/**
 * Publish this client's presence, refreshing it when the URL changes.
 *
 * Every field is stable for the connection's lifetime apart from `url`: awareness
 * re-broadcasts the whole state to every peer on each announce, so a value that
 * ticks would cost O(n²) messages across a room full of phones. `connectedSince`
 * is therefore a fixed instant captured once, and the viewer renders the age.
 */
export function usePublishPresence(): void {
  const setPresence = usePresenceSetter<ClientPresence>();
  const isEditor = useAtomValue(isEditorAtom);
  const url = useCurrentUrl();

  // The connection's fixed identity: captured on the first publish (i.e. at mount)
  // and reused afterwards, so re-publishing on navigation doesn't reset the clock
  // or re-sniff the device. Both reads are impure, hence the effect rather than
  // a render-time initializer.
  const identity = useRef<{ connectedSince: number; device: ClientPresence['device'] } | null>(
    null,
  );

  useEffect(() => {
    identity.current ??= { connectedSince: Date.now(), device: describeDevice(navigator) };
    setPresence({
      url,
      role: isEditor ? 'editor' : 'viewer',
      device: identity.current.device,
      locale: resolveLocale(),
      connectedSince: identity.current.connectedSince,
    });
  }, [setPresence, url, isEditor]);
}

/** Renders nothing; exists so App can mount the publisher inside YDocProvider. */
export function PresencePublisher(): null {
  usePublishPresence();
  return null;
}
