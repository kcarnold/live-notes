/**
 * One source of truth for "the current session" (issue #111).
 *
 * The bug this exists to kill: three parties independently *computed* which doc was live
 * — the browser from its wall clock, the Proclaim service from the on-air show's
 * `DateGiven`, LiveKit from whatever a browser passed it — and nothing reconciled them.
 * One Sunday the service silently retargeted itself at the previous week's doc and went
 * on logging the doc it *meant* to write to, so the disagreement was invisible from
 * everywhere except the server's own auth log.
 *
 * The fix is not a better formula. It is making the current session a fact the server
 * owns and everyone else *reads*:
 *
 *   - An operator **pin** (set from /status) always wins. It is the escape hatch that
 *     works from a pew with a phone, which is the point of the exercise.
 *   - Otherwise the Proclaim service's **proposal** ("a show dated X is on air") applies,
 *     if the server accepts it. The service proposes; it never decides, and it never
 *     changes a pin.
 *   - Otherwise the **date formula**, evaluated here rather than in three places.
 *
 * Both a pin and a proposal expire (see {@link entryExpiry}), so a forgotten pin cannot
 * silently capture next week's service — the failure mode that would make this cure worse
 * than the disease.
 *
 * Everything is persisted to a small JSON file so a server restart mid-service doesn't
 * drop the pin someone just set.
 */
import fs from 'fs/promises';
import path from 'path';

import {
  dateDocId,
  docIdForDate,
  isValidDocId,
  localDateString,
  zoneHour,
  type CurrentSession,
  type SessionSource,
  type WriterSighting,
} from './src/sessionCurrent.ts';

export type { CurrentSession, SessionSource, WriterSighting };

/**
 * Hour of the local morning at which a pin or proposal lapses. Late enough that a service
 * running past midnight keeps its pin, early enough that nobody is setting up before it.
 */
export const RESET_HOUR = 4;

/**
 * Floor on how long an entry lives, so pinning at 2am (a rehearsal, an overnight setup)
 * doesn't expire two hours later at the very 4am boundary meant to protect it.
 */
export const MIN_LIFETIME_MS = 6 * 60 * 60 * 1000;

/** How long a writer stays in the "recently seen" list before it's presumed gone. */
export const WRITER_TTL_MS = 15 * 60 * 1000;

interface StoredEntry {
  docId: string;
  /** ISO timestamp it was recorded. */
  since: string;
  /** Free-text label for whoever set it. */
  setBy: string;
}

interface RegistryFile {
  version: 1;
  pin: StoredEntry | null;
  proposal: StoredEntry | null;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * When an entry recorded at `since` stops applying: the next {@link RESET_HOUR} in
 * `timeZone`, but never sooner than {@link MIN_LIFETIME_MS} after it was set.
 *
 * Walks forward an hour at a time rather than doing calendar arithmetic, so a spring-
 * forward night can't land on an hour that doesn't exist or skip the boundary entirely.
 * At most ~30 steps. Zones offset by a half or quarter hour land on their own :30/:15,
 * which is close enough for a housekeeping deadline.
 */
export function entryExpiry(since: Date, timeZone?: string): Date {
  const floor = since.getTime() + MIN_LIFETIME_MS;
  let t = Math.ceil(since.getTime() / HOUR_MS) * HOUR_MS;
  for (let steps = 0; steps < 24 * 3; steps++, t += HOUR_MS) {
    if (t > floor && zoneHour(new Date(t), timeZone) === RESET_HOUR) return new Date(t);
  }
  return new Date(floor);
}

/** Why a proposal was or wasn't taken up — reported back so the service can log it. */
export type ProposalOutcome =
  /** Recorded; it is now the current session. */
  | 'accepted'
  /** An operator pin is in force. The service must follow it, not fight it. */
  | 'pinned'
  /** The show is dated before today. This is the exact shape of the original bug. */
  | 'stale'
  /** Nothing to propose (no date on the show), so the answer is whatever it already was. */
  | 'no-date';

export interface ProposalResult {
  outcome: ProposalOutcome;
  session: CurrentSession;
}

export class SessionRegistry {
  private filePath: string;
  private timeZone: string | undefined;
  private pin: StoredEntry | null = null;
  private proposal: StoredEntry | null = null;
  private writers = new Map<string, WriterSighting>();
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * @param timeZone IANA zone the congregation keeps (`SESSION_TIMEZONE`). Omit for the
   *   host's own zone — which in a container is UTC, and which is why this is a parameter.
   */
  constructor(filePath: string, timeZone?: string) {
    this.filePath = filePath;
    this.timeZone = timeZone;
  }

  /** The zone this registry reckons dates and the 4am boundary in. */
  get zone(): string {
    return this.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** Load a persisted pin/proposal. A missing or unreadable file starts empty. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as RegistryFile;
      this.pin = readEntry(parsed.pin);
      this.proposal = readEntry(parsed.proposal);
    } catch {
      // A corrupt file must not stop the server from booting into a service. Losing the
      // pin degrades to the date formula, which is where we started.
      console.warn(`[session] ignoring unreadable session registry at ${this.filePath}`);
    }
  }

  // -- reading ---------------------------------------------------------------

  /** The current session: pin, else proposal, else the date. Expired entries are skipped. */
  current(now: Date = new Date()): CurrentSession {
    const live = this.liveEntry(now);
    if (!live) {
      return {
        docId: dateDocId(now, this.timeZone),
        source: 'date',
        since: null,
        setBy: null,
        expiresAt: null,
      };
    }
    const [source, entry] = live;
    return {
      docId: entry.docId,
      source,
      since: entry.since,
      setBy: entry.setBy,
      expiresAt: entryExpiry(new Date(entry.since), this.timeZone).toISOString(),
    };
  }

  private liveEntry(now: Date): [SessionSource, StoredEntry] | null {
    if (this.pin && !this.isExpired(this.pin, now)) return ['pin', this.pin];
    if (this.proposal && !this.isExpired(this.proposal, now)) return ['proposal', this.proposal];
    return null;
  }

  /** Whether an operator pin is currently in force (a proposal must not override it). */
  isPinned(now: Date = new Date()): boolean {
    return this.pin !== null && !this.isExpired(this.pin, now);
  }

  // -- writing ---------------------------------------------------------------

  /** Pin a doc as the current session. Overrides any proposal until it expires. */
  async setPin(docId: string, setBy: string, now: Date = new Date()): Promise<CurrentSession> {
    if (!isValidDocId(docId)) throw new Error(`Invalid doc id: ${docId}`);
    this.pin = { docId, since: now.toISOString(), setBy };
    await this.persist();
    return this.current(now);
  }

  /** Drop the pin, falling back to any live proposal and then to the date. */
  async clearPin(now: Date = new Date()): Promise<CurrentSession> {
    this.pin = null;
    await this.persist();
    return this.current(now);
  }

  /**
   * Record what a source says is on air, and answer with the doc to actually use.
   *
   * `sessionDate` is the show's own date (Proclaim's `DateGiven`). A date *before today*
   * is refused: that is precisely how last week's deck captured this week's service, and
   * a proposal that can reach into the past is the same bug with a nicer interface. A
   * date today or later is taken — which is the pre-staging case `DateGiven` was added
   * for, and which now works for browsers too, since they read this same answer.
   */
  async propose(
    sessionDate: string | null,
    setBy: string,
    now: Date = new Date(),
  ): Promise<ProposalResult> {
    if (this.isPinned(now)) return { outcome: 'pinned', session: this.current(now) };
    if (!sessionDate) return { outcome: 'no-date', session: this.current(now) };
    if (sessionDate < localDateString(now, this.timeZone)) {
      return { outcome: 'stale', session: this.current(now) };
    }
    const docId = docIdForDate(sessionDate);
    if (!isValidDocId(docId)) return { outcome: 'stale', session: this.current(now) };
    // Re-recording an identical proposal every poll would keep pushing its expiry out,
    // so leave an unchanged live proposal alone.
    const live = this.proposal && !this.isExpired(this.proposal, now) ? this.proposal : null;
    if (!live || live.docId !== docId) {
      this.proposal = { docId, since: now.toISOString(), setBy };
      await this.persist();
    }
    return { outcome: 'accepted', session: this.current(now) };
  }

  // -- who is writing where --------------------------------------------------

  /**
   * Note that `writer` is writing to `docId`.
   *
   * This is the other half of the fix. "The service is down" and "the service is writing
   * to a different doc than you're looking at" produced identical symptoms — an empty
   * slide pane — and only one of them is fixable during a service.
   */
  noteWriter(writer: string, docId: string, now: Date = new Date()): void {
    if (!isValidDocId(docId)) return;
    this.writers.set(`${writer} ${docId}`, { writer, docId, at: now.toISOString() });
  }

  /** Recently-seen writers, newest first, dropping anything past {@link WRITER_TTL_MS}. */
  recentWriters(now: Date = new Date()): WriterSighting[] {
    const cutoff = now.getTime() - WRITER_TTL_MS;
    for (const [key, sighting] of this.writers) {
      if (new Date(sighting.at).getTime() < cutoff) this.writers.delete(key);
    }
    return [...this.writers.values()].sort((a, b) => b.at.localeCompare(a.at));
  }

  private isExpired(entry: StoredEntry, now: Date): boolean {
    return now.getTime() >= entryExpiry(new Date(entry.since), this.timeZone).getTime();
  }

  private persist(): Promise<void> {
    const snapshot: RegistryFile = { version: 1, pin: this.pin, proposal: this.proposal };
    const serialized = JSON.stringify(snapshot, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, serialized, 'utf-8');
      await fs.rename(tmp, this.filePath);
    });
    return this.writeChain;
  }
}

/** Narrow one persisted entry, dropping anything malformed rather than trusting the file. */
function readEntry(raw: unknown): StoredEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const { docId, since, setBy } = raw as Record<string, unknown>;
  if (!isValidDocId(docId) || typeof since !== 'string' || Number.isNaN(Date.parse(since))) {
    return null;
  }
  return { docId, since, setBy: typeof setBy === 'string' ? setBy : 'unknown' };
}
