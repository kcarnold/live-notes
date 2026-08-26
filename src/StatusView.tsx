import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useMap, useYDoc } from '@y-sweet/react';
import { useStrings } from './useLocale';
import { getDocId } from './getDocId';
import { TranscriptHealth } from './TranscriptHealth';
import { getWriteKey, maskWriteKey, setWriteKey } from './writeKey';
import { clearSessionPin, fetchSessionWriters, pinSession, type WriterSighting } from './sessionApi';
import type { CurrentSession } from './sessionCurrent';

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

/** What the Proclaim service reports about itself under the `proclaimService` key (#73). */
interface ProclaimServiceStatus {
  gitShaShort?: string;
  gitBranch?: string;
  /** The release branch has moved past the running SHA — restart to pick it up. */
  updatePending: boolean;
}

/**
 * Narrow the untyped `status` entry the Proclaim service writes. Returns null when
 * the service hasn't reported (or reported something unrecognizable), so the tile
 * falls back to its placeholder.
 */
function readProclaimServiceStatus(entries: Record<string, unknown>): ProclaimServiceStatus | null {
  const raw = entries['proclaimService'];
  if (!raw || typeof raw !== 'object') return null;
  const { gitShaShort, gitBranch, updatePending } = raw as Record<string, unknown>;
  return {
    gitShaShort: typeof gitShaShort === 'string' && gitShaShort ? gitShaShort : undefined,
    gitBranch: typeof gitBranch === 'string' && gitBranch ? gitBranch : undefined,
    updatePending: updatePending === true,
  };
}

const SECTION_CLASS = 'bg-white/80 dark:bg-gray-800/80 rounded shadow p-4 flex flex-col gap-3';
const SECTION_TITLE_CLASS = 'font-semibold text-lg';
const PLACEHOLDER_CLASS = 'text-sm text-gray-500 dark:text-gray-400';

/**
 * This device's write key: whether it has one, and a way to change it that doesn't
 * involve typing `#editor&key=…` into a tablet's address bar.
 *
 * The masked tail is the point of the display. During a rotation the question is never
 * "is there a key" but "is this device on the new one yet", and four characters answer
 * that without putting the secret on a screen that may well be projected.
 */
function WriteKeySection({
  writeKey,
  onWriteKeyChange,
}: {
  writeKey: string | null;
  onWriteKeyChange: (key: string | null) => void;
}) {
  const s = useStrings();
  const [typed, setTyped] = useState('');
  const pending = typed.trim();

  return (
    <section className={SECTION_CLASS}>
      <h2 className={SECTION_TITLE_CLASS}>{s.statusWriteKeyTitle}</h2>
      <p className={PLACEHOLDER_CLASS}>{s.statusWriteKeyDescription}</p>
      <div className="flex items-center gap-2 text-sm">
        <span
          className={`inline-block w-2.5 h-2.5 rounded-full ${
            writeKey ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
          }`}
        />
        {writeKey ? (
          <>
            <span>{s.statusWriteKeyInstalled}</span>
            <code className="text-xs text-gray-500 dark:text-gray-400">
              {maskWriteKey(writeKey)}
            </code>
          </>
        ) : (
          <span>{s.statusWriteKeyMissing}</span>
        )}
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending) return;
          onWriteKeyChange(pending);
          setTyped('');
        }}
      >
        <input
          type="password"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder={s.statusWriteKeyPlaceholder}
          autoComplete="off"
          aria-label={s.statusWriteKeyPlaceholder}
          className="flex-1 min-w-40 px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm"
        />
        <button
          type="submit"
          disabled={!pending}
          className="px-3 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 disabled:hover:bg-blue-500 text-sm"
        >
          {s.statusWriteKeySave}
        </button>
        {writeKey && (
          <button
            type="button"
            onClick={() => onWriteKeyChange(null)}
            className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 text-sm"
          >
            {s.statusWriteKeyClear}
          </button>
        )}
      </form>
    </section>
  );
}

/**
 * The operator control from #111: which doc everything is writing to, and the pin that
 * overrides it.
 *
 * This is the piece that would have let last Sunday be fixed from a pew — the whole point
 * of moving the decision to the server. It sits next to the writer list deliberately:
 * "the service is down" and "the service is writing to last week's doc" produced the
 * identical empty pane, and only one of them is fixable in the next thirty seconds.
 */
function CurrentSessionSection({
  session,
  writers,
  error,
  busy,
  onPin,
  onClearPin,
}: {
  session: CurrentSession;
  writers: WriterSighting[];
  error: string | null;
  busy: boolean;
  onPin: (docId: string) => void;
  onClearPin: () => void;
}) {
  const s = useStrings();
  const [typed, setTyped] = useState('');
  const pending = typed.trim();

  const sourceLabel = {
    pin: s.statusSessionSourcePin,
    proposal: s.statusSessionSourceProposal,
    date: s.statusSessionSourceDate,
  }[session.source];

  return (
    <section className={SECTION_CLASS}>
      <h2 className={SECTION_TITLE_CLASS}>{s.statusSessionTitle}</h2>
      <p className={PLACEHOLDER_CLASS}>{s.statusSessionDescription}</p>

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <code className="font-semibold">{session.docId}</code>
        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700">
          {sourceLabel}
        </span>
        {session.setBy && (
          <span className={PLACEHOLDER_CLASS}>
            {s.statusSessionSetBy} {session.setBy}
          </span>
        )}
        {session.expiresAt && (
          <span className={PLACEHOLDER_CLASS}>
            · {s.statusSessionLapses} {new Date(session.expiresAt).toLocaleString()}
          </span>
        )}
      </div>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending) return;
          onPin(pending);
          setTyped('');
        }}
      >
        <input
          type="text"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder={s.statusSessionPlaceholder}
          aria-label={s.statusSessionPlaceholder}
          autoComplete="off"
          spellCheck={false}
          className="flex-1 min-w-40 px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm font-mono"
        />
        <button
          type="submit"
          disabled={!pending || busy}
          className="px-3 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40 disabled:hover:bg-blue-500 text-sm"
        >
          {s.statusSessionPin}
        </button>
        {session.source === 'pin' && (
          <button
            type="button"
            disabled={busy}
            onClick={onClearPin}
            className="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 text-sm disabled:opacity-40"
          >
            {s.statusSessionClearPin}
          </button>
        )}
      </form>
      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {s.statusSessionFailed}: {error}
        </p>
      )}

      <h3 className="text-sm font-semibold mt-1">{s.statusWritersTitle}</h3>
      {writers.length === 0 ? (
        <p className={PLACEHOLDER_CLASS}>{s.statusWritersEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {writers.map((writer) => {
            const elsewhere = writer.docId !== session.docId;
            return (
              <li key={`${writer.writer} ${writer.docId}`} className="flex flex-wrap items-baseline gap-2">
                <span className={`inline-block w-2.5 h-2.5 rounded-full ${elsewhere ? 'bg-amber-500' : 'bg-green-500'}`} />
                <span>{writer.writer}</span>
                <code className="text-xs text-gray-500 dark:text-gray-400">{writer.docId}</code>
                {elsewhere && (
                  <span className="text-xs text-amber-700 dark:text-amber-400">
                    {s.statusWritersElsewhere}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

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
  /** This device's stored write key, or null when it has none. */
  writeKey?: string | null;
  /**
   * Store a key typed here, or clear it with null. Omitting this hides the write-key
   * section entirely, which is what keeps the section out of tests that don't care.
   */
  onWriteKeyChange?: (key: string | null) => void;
  /**
   * The server's current-session answer (#111). Omitting it hides the section, on the
   * same principle as the write key above.
   */
  session?: CurrentSession | null;
  /** Writers recently seen, so a doc-id disagreement is visible rather than inferred. */
  writers?: WriterSighting[];
  /** Why the last pin change failed, if it did. */
  sessionError?: string | null;
  /** True while a pin change is in flight. */
  sessionBusy?: boolean;
  onPinSession?: (docId: string) => void;
  onClearSessionPin?: () => void;
}

export function StatusView({
  docId,
  statusEntries,
  liveTranscripts,
  writeKey = null,
  onWriteKeyChange,
  session = null,
  writers = [],
  sessionError = null,
  sessionBusy = false,
  onPinSession,
  onClearSessionPin,
}: StatusViewProps) {
  const s = useStrings();
  const exportHref = `/api/session/export?doc=${encodeURIComponent(docId)}`;
  const reportingCount = Object.keys(statusEntries).length;
  const proclaim = readProclaimServiceStatus(statusEntries);

  const sectionClass = SECTION_CLASS;
  const sectionTitleClass = SECTION_TITLE_CLASS;
  const placeholderClass = PLACEHOLDER_CLASS;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-100 to-gray-300 dark:from-gray-950 dark:to-gray-900 text-black dark:text-gray-200 overflow-auto">
      <div className="max-w-2xl mx-auto px-4 py-8 flex flex-col gap-6">
        <header className="flex items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold">{s.statusTitle}</h1>
          <code className="text-xs text-gray-500 dark:text-gray-400">{docId}</code>
        </header>

        {/* Which session everything is writing to (#111). First, because every other
            tile on this page is meaningless if the answer is the wrong doc. */}
        {session && onPinSession && onClearSessionPin && (
          <CurrentSessionSection
            session={session}
            writers={writers}
            error={sessionError}
            busy={sessionBusy}
            onPin={onPinSession}
            onClearPin={onClearSessionPin}
          />
        )}

        {/* Health — placeholder tiles until #72 wires component heartbeats. */}
        <section className={sectionClass}>
          <h2 className={sectionTitleClass}>{s.statusHealthTitle}</h2>
          <div className="grid grid-cols-2 gap-2">
            {PLANNED_COMPONENTS.map((name) => {
              // The Proclaim service is the one component reporting so far (#73): it
              // announces the version it's running and whether the release branch has
              // moved on. Everything else stays a placeholder until #72 wires it.
              const version = name === 'Proclaim service' ? proclaim : null;
              const dotClass = version
                ? version.updatePending
                  ? 'bg-amber-500'
                  : 'bg-green-500'
                : 'bg-gray-300 dark:bg-gray-600';
              return (
                <div
                  key={name}
                  className="rounded border border-gray-200 dark:border-gray-700 p-2 flex items-center gap-2"
                >
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${dotClass}`} />
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">{name}</span>
                    {version ? (
                      <>
                        <code className="text-xs text-gray-500 dark:text-gray-400">
                          {[version.gitShaShort, version.gitBranch].filter(Boolean).join(' · ')}
                        </code>
                        {version.updatePending && (
                          <span className="text-xs text-amber-700 dark:text-amber-400">
                            {s.statusUpdatePending}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-xs text-gray-500 dark:text-gray-400">{s.statusNotReporting}</span>
                    )}
                  </div>
                </div>
              );
            })}
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

        {/* This device's write key — provisioning and rotation, off the viewer screens. */}
        {onWriteKeyChange && (
          <WriteKeySection writeKey={writeKey} onWriteKeyChange={onWriteKeyChange} />
        )}

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

/** How often the writer list refreshes. Fast enough to watch a service come up. */
const WRITERS_POLL_MS = 10_000;

/** Yjs connector: reads the `status` Y.Map and the session doc id. */
export function StatusViewContainer() {
  useYDoc(); // Ensure this renders within the session's YDocProvider.
  const statusMap = useMap('status');
  const statusEntries: Record<string, unknown> = {};
  statusMap.forEach((value, key) => {
    statusEntries[key] = value;
  });
  // The stored key isn't reactive, so mirror it into state to re-render on a change.
  const [writeKey, setWriteKeyState] = useState<string | null>(() => getWriteKey());

  // The current session and who is writing where. Polled rather than pushed: it lives on
  // the server, not in the doc — deliberately, since a doc-scoped view of "which doc is
  // current" could only ever agree with itself.
  const [session, setSession] = useState<CurrentSession | null>(null);
  const [writers, setWriters] = useState<WriterSighting[]>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);

  // Bumped after a pin change so the poll re-runs at once instead of on its next tick.
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const { current, writers: seen } = await fetchSessionWriters();
        if (!active) return;
        setSession(current);
        setWriters(seen);
      } catch (error) {
        console.warn('[status] could not read the current session', error);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), WRITERS_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refreshToken]);

  /** Run a pin change, then re-read rather than trusting our own optimistic guess. */
  const change = useCallback(async (action: () => Promise<CurrentSession>) => {
    setSessionBusy(true);
    setSessionError(null);
    try {
      setSession(await action());
      setRefreshToken((n) => n + 1);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionBusy(false);
    }
  }, []);

  return (
    <StatusView
      docId={getDocId()}
      statusEntries={statusEntries}
      liveTranscripts={<TranscriptHealth />}
      writeKey={writeKey}
      onWriteKeyChange={(key) => {
        setWriteKey(key);
        setWriteKeyState(key);
      }}
      session={session}
      writers={writers}
      sessionError={sessionError}
      sessionBusy={sessionBusy}
      onPinSession={(docId) => void change(() => pinSession(docId))}
      onClearSessionPin={() => void change(() => clearSessionPin())}
    />
  );
}

export default StatusView;
