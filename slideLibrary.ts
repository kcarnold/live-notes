/**
 * Persistent, file-backed slide-translation library (server-side).
 *
 * This is the durable "reviewed" tier from the plan: it outlives the per-day Yjs
 * doc and is reused across services (canonical Bible/creed texts, past human
 * reviews). Auto/machine fallbacks are NOT stored here — those live in the per-day
 * doc. The library therefore only ever holds `reviewed` entries.
 *
 * Storage is a single JSON file written atomically (temp file + rename). Writes are
 * serialized through a promise chain so concurrent upserts can't interleave.
 */
import fs from 'fs/promises';
import path from 'path';

import {
  normalizeSlideText,
  slideTranslationKey,
  type SlideProvenance,
  type SlideTranslationEntry,
  type SlideTranslationLookup,
} from './src/slideTranslation.ts';

/** A stored entry plus the language and normalized source text it was keyed by. */
export interface SlideLibraryRecord extends SlideTranslationEntry {
  language: string;
  sourceText: string;
}

interface LibraryFile {
  version: 1;
  entries: SlideLibraryRecord[];
}

export interface UpsertInput {
  language: string;
  sourceText: string;
  text: string;
  provenance?: SlideProvenance;
}

export class SlideLibrary {
  private filePath: string;
  private records = new Map<string, SlideLibraryRecord>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Load existing entries from disk. Missing file is treated as an empty library. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.records.clear();
        return;
      }
      throw err;
    }
    const parsed = JSON.parse(raw) as LibraryFile;
    this.records.clear();
    for (const record of parsed.entries ?? []) {
      this.records.set(slideTranslationKey(record.language, record.sourceText), record);
    }
  }

  private toEntry(record: SlideLibraryRecord): SlideTranslationEntry {
    return {
      text: record.text,
      status: record.status,
      provenance: record.provenance,
      reviewedAt: record.reviewedAt,
    };
  }

  /** Look up the reviewed entry for a concrete language + slide text, if any. */
  lookup(language: string, slideText: string): SlideTranslationEntry | undefined {
    const record = this.records.get(slideTranslationKey(language, slideText));
    return record ? this.toEntry(record) : undefined;
  }

  /** A lookup function suitable for `resolveSlideTranslation`. */
  toLookup(): SlideTranslationLookup {
    return (language, slideText) => this.lookup(language, slideText);
  }

  /** All stored records (reviewed entries), sorted by language then source text. */
  list(): SlideLibraryRecord[] {
    return [...this.records.values()].sort(
      (a, b) =>
        a.language.localeCompare(b.language) || a.sourceText.localeCompare(b.sourceText),
    );
  }

  /**
   * Create or replace a reviewed translation, then persist. The source text is
   * normalized so keys are stable regardless of incidental whitespace.
   */
  async upsert(input: UpsertInput): Promise<SlideLibraryRecord> {
    const sourceText = normalizeSlideText(input.sourceText);
    const record: SlideLibraryRecord = {
      language: input.language,
      sourceText,
      text: input.text,
      status: 'reviewed',
      provenance: input.provenance ?? 'human',
      reviewedAt: Date.now(),
    };
    this.records.set(slideTranslationKey(input.language, sourceText), record);
    await this.persist();
    return record;
  }

  private persist(): Promise<void> {
    const snapshot: LibraryFile = { version: 1, entries: this.list() };
    const serialized = JSON.stringify(snapshot, null, 2);
    // Chain writes so the file is never written by two upserts at once.
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, serialized, 'utf-8');
      await fs.rename(tmp, this.filePath);
    });
    return this.writeChain;
  }
}
