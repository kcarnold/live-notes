/**
 * Compare what the translation agent wrote against the canonical text it looked up.
 *
 * The agent grounds some slides in published human translations — Scripture today, creeds
 * and confessions later — by calling a lookup tool. The tool's response is already in the
 * conversation history, so the canonical wording is sitting client-side next to the agent's
 * drafts: no server round-trip is needed to show a reviewer where the agent drifted.
 *
 * Nothing here is Bible-specific. A tool is plugged in by registering an *adapter* that maps
 * its `functionResponse` payload onto a `CanonicalLookup`; the extraction, diffing, and
 * gating below never look at the tool name again. `lookup_bible_passage` is the first
 * registered adapter, not a special case.
 *
 * Pure and framework-free — no Yjs, no React, no network.
 */
import { diffWords, type Change } from 'diff';

import { normalizeSlideText, unescapeLiteralEscapes } from './slideTranslation';
import type { Content } from './slideTranslationApi';

/** A canonical text the agent looked up, normalized across tools. */
export interface CanonicalLookup {
  /** What was looked up, as shown to the reviewer: a Bible reference, a creed title, … */
  label: string;
  /** language → the published wording in that language. */
  texts: Record<string, string>;
}

/**
 * Maps one tool's `functionResponse.response` payload onto a `CanonicalLookup`, or null when
 * the call carried no canonical text (an error response, a missing passage, a wrong shape).
 */
export type LookupAdapter = (response: Record<string, unknown>) => CanonicalLookup | null;

function stringRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim() !== '') out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Registered lookup tools, keyed by the tool name in the conversation.
 *
 * Adding a creed/confession lookup later is one more entry here — the panel, the diff, and
 * the overlap gate are unchanged.
 */
export const LOOKUP_ADAPTERS: Record<string, LookupAdapter> = {
  // nlp.ts answers a successful lookup with { reference, passages }, and a failed one with
  // { reference, error } — the latter has no `passages` and so drops out here.
  lookup_bible_passage: (response) => {
    const label = typeof response.reference === 'string' ? response.reference.trim() : '';
    const texts = stringRecord(response.passages);
    if (!label || !texts) return null;
    return { label, texts };
  },
};

/**
 * Pull every canonical lookup out of a conversation, in the order the agent made them.
 *
 * Repeated lookups of the same label are merged rather than duplicated: a later call fills in
 * languages an earlier one missed, and re-supplies wins for languages both carry.
 */
export function extractLookups(messages: Content[]): CanonicalLookup[] {
  const byLabel = new Map<string, CanonicalLookup>();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const response = part.functionResponse;
      if (!response?.name) continue;
      const adapter = LOOKUP_ADAPTERS[response.name];
      if (!adapter) continue;
      const lookup = adapter(response.response ?? {});
      if (!lookup) continue;
      const existing = byLabel.get(lookup.label);
      if (existing) {
        Object.assign(existing.texts, lookup.texts);
      } else {
        byLabel.set(lookup.label, { label: lookup.label, texts: { ...lookup.texts } });
      }
    }
  }
  return [...byLabel.values()];
}

/** One canonical text vs. the agent's drafts, in one language. */
export interface LookupDiff {
  label: string;
  language: string;
  /** Share of characters common to both texts, 0–1. Also the gate: see `computeLookupDiffs`. */
  similarity: number;
  /** Word-level diff parts: canonical is the base, so `removed` = canonical-only. */
  parts: Change[];
}

/** Canonicalize either side for comparison; stored drafts may carry literal `\n` escapes. */
function comparable(text: string): string {
  return normalizeSlideText(unescapeLiteralEscapes(text));
}

/**
 * Diff each lookup against the agent's drafts, keeping only the pairs that plausibly describe
 * the same text.
 *
 * The gate matters because a lookup does not imply the item *is* that passage: a song may
 * quote one verse, and diffing a whole hymn against that verse is noise, not review material.
 * Overlap is measured as common characters over total characters; pairs below `threshold`
 * are dropped entirely rather than shown with a caveat.
 */
export function computeLookupDiffs(
  lookups: CanonicalLookup[],
  drafts: Record<string, string[]>,
  languages: string[],
  threshold = 0.4,
): LookupDiff[] {
  const diffs: LookupDiff[] = [];
  for (const lookup of lookups) {
    for (const language of languages) {
      const canonical = comparable(lookup.texts[language] ?? '');
      const agent = comparable((drafts[language] ?? []).filter((text) => text.trim() !== '').join('\n'));
      if (!canonical || !agent) continue;

      const parts = diffWords(canonical, agent);
      let common = 0;
      let changed = 0;
      for (const part of parts) {
        if (part.added || part.removed) changed += part.value.length;
        else common += part.value.length;
      }
      const total = common + changed;
      if (total === 0) continue;
      const similarity = common / total;
      if (similarity < threshold) continue;
      diffs.push({ label: lookup.label, language, similarity, parts });
    }
  }
  return diffs;
}
