import type { ReactNode } from 'react';
import { useMap, useYDoc } from '@y-sweet/react';
import { useStrings } from './useLocale';
import { getDocId } from './getDocId';
import { TranscriptHealth } from './TranscriptHealth';

/**
 * Session status / admin page.
 *
 * This is the skeleton for issue #72 (component heartbeats + web status view +
 * preflight canary). It intentionally ships only the structure plus one working
 * admin action — the session export — which is an operator-level tool that
 * shouldn't clutter the viewer-facing session layouts. The Health and Canary
 * sections are placeholders that #72 will fill in:
 *
 *   - Health: green/red tiles fed by each component's heartbeat in the `status`
 *     Y.Map (bridge per language, proclaim service, server, broadcaster).
 *   - Canary: a 30-second end-to-end preflight check run before a service.
 *
 * The pure component takes plain props so it's testable without Yjs; the
 * container wires it to the doc.
 */

/** Planned heartbeat sources from #72. Rendered as placeholder tiles until wired. */
const PLANNED_COMPONENTS = ['Server', 'Proclaim service', 'Live-audio bridges', 'Broadcaster'] as const;

export interface StatusViewProps {
  /** The session's doc id (drives the export link). */
  docId: string;
  /**
   * Raw entries from the `status` Y.Map (#72), keyed by component id. Empty until
   * components start heartbeating; the skeleton only reports the count for now.
   */
  statusEntries: Record<string, unknown>;
  /**
   * Live-transcript liveness tiles, injected by the container (they need per-Y.Text
   * observers). Kept as a slot so the pure component stays testable without Yjs.
   */
  liveTranscripts?: ReactNode;
}

export function StatusView({ docId, statusEntries, liveTranscripts }: StatusViewProps) {
  const s = useStrings();
  const exportHref = `/api/session/export?doc=${encodeURIComponent(docId)}`;
  const reportingCount = Object.keys(statusEntries).length;

  const sectionClass =
    'bg-white/80 dark:bg-gray-800/80 rounded shadow p-4 flex flex-col gap-3';
  const sectionTitleClass = 'font-semibold text-lg';
  const placeholderClass = 'text-sm text-gray-500 dark:text-gray-400';

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-100 to-gray-300 dark:from-gray-950 dark:to-gray-900 text-black dark:text-gray-200 overflow-auto">
      <div className="max-w-2xl mx-auto px-4 py-8 flex flex-col gap-6">
        <header className="flex items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold">{s.statusTitle}</h1>
          <code className="text-xs text-gray-500 dark:text-gray-400">{docId}</code>
        </header>

        {/* Health — placeholder tiles until #72 wires component heartbeats. */}
        <section className={sectionClass}>
          <h2 className={sectionTitleClass}>{s.statusHealthTitle}</h2>
          <div className="grid grid-cols-2 gap-2">
            {PLANNED_COMPONENTS.map((name) => (
              <div
                key={name}
                className="rounded border border-gray-200 dark:border-gray-700 p-2 flex items-center gap-2"
              >
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-300 dark:bg-gray-600" />
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{name}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{s.statusNotReporting}</span>
                </div>
              </div>
            ))}
          </div>
          <p className={placeholderClass}>
            {s.statusHealthPlaceholder}
            {reportingCount > 0 ? ` (${reportingCount})` : ''}
          </p>
        </section>

        {/* Live transcripts — real end-to-end liveness, read from the transcript Y.Texts. */}
        <section className={sectionClass}>
          <h2 className={sectionTitleClass}>{s.statusTranscriptsTitle}</h2>
          {liveTranscripts ?? (
            <p className={placeholderClass}>{s.statusTranscriptsEmpty}</p>
          )}
        </section>

        {/* Preflight canary — placeholder until #72. */}
        <section className={sectionClass}>
          <h2 className={sectionTitleClass}>{s.statusCanaryTitle}</h2>
          <p className={placeholderClass}>{s.statusCanaryPlaceholder}</p>
        </section>

        {/* Session export — the one working admin action, moved off the viewer screens. */}
        <section className={sectionClass}>
          <h2 className={sectionTitleClass}>{s.statusExportTitle}</h2>
          <p className={placeholderClass}>{s.statusExportDescription}</p>
          <a
            href={exportHref}
            download
            className="self-start px-4 py-2 rounded bg-blue-500 text-white hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700 transition text-sm shadow hover:shadow-lg"
          >
            ⬇️ {s.downloadSession}
          </a>
        </section>

        <a
          href="/"
          className="text-sm underline text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
        >
          {s.goHome}
        </a>
      </div>
    </div>
  );
}

/** Yjs connector: reads the `status` Y.Map and the session doc id. */
export function StatusViewContainer() {
  useYDoc(); // Ensure this renders within the session's YDocProvider.
  const statusMap = useMap('status');
  const statusEntries: Record<string, unknown> = {};
  statusMap.forEach((value, key) => {
    statusEntries[key] = value;
  });
  return (
    <StatusView
      docId={getDocId()}
      statusEntries={statusEntries}
      liveTranscripts={<TranscriptHealth />}
    />
  );
}

export default StatusView;
