/**
 * Resolves the current session before anything that needs a doc id mounts (issue #111).
 *
 * The one thing this must never do is guess. Before #111 every client computed the doc
 * id for itself and displayed whatever it computed as fact; the resulting failure — a
 * service quietly writing to last week's doc — was invisible because nothing anywhere
 * ever said "I don't know". So an unreachable server produces a screen that says so,
 * with the `?doc=` escape hatch spelled out, rather than a plausible empty session.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { resolveCurrentSession } from './getDocId';
import { useStrings } from './useLocale';

type GateState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

export function SessionGate({ children }: { children: ReactNode }) {
  const s = useStrings();
  const [state, setState] = useState<GateState>({ status: 'loading' });
  // Bumped by the retry button to re-run the effect. The attempt lives in state rather
  // than in a callback so the effect stays the only thing that touches the network.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const resolve = async () => {
      try {
        await resolveCurrentSession();
        if (active) setState({ status: 'ready' });
      } catch (error: unknown) {
        console.error('[session] could not resolve the current session', error);
        if (active) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    void resolve();
    return () => {
      active = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  if (state.status === 'ready') return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-100 to-gray-300 dark:from-gray-950 dark:to-gray-900 text-black dark:text-gray-200 p-6">
      {state.status === 'loading' ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">{s.sessionResolving}</p>
      ) : (
        <div className="max-w-md flex flex-col gap-3 text-center">
          <h1 className="text-xl font-bold">{s.sessionUnreachableTitle}</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">{s.sessionUnreachableBody}</p>
          <code className="text-xs text-gray-500 dark:text-gray-500 break-all">{state.message}</code>
          <button
            type="button"
            onClick={retry}
            className="self-center px-4 py-2 rounded bg-blue-500 text-white hover:bg-blue-600 text-sm"
          >
            {s.retry}
          </button>
        </div>
      )}
    </div>
  );
}

export default SessionGate;
