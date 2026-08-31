// The session's *spoken* language: which language comes out of the speaker's mouth,
// as opposed to the languages the room listens in.
//
// This used to be a constant — `en` — spelled out in half a dozen places: the code the
// input transcript is filed under, the "Original" entry in the listen picker, the
// broadcaster's own transcript pane, the "(source)" marker in an export. That made
// English structurally different from every other language in the system rather than
// merely the usual answer, and a service where the speaker isn't speaking English had
// no way to say so. It is now one value, declared once per session and read everywhere
// those places used to assume.
//
// It lives in the shared Yjs doc because it has to outlive the broadcast: an export
// read months later still needs to know which transcript was the source, and a listener
// who joins late needs it to label the picker. The live-audio server learns it by a
// different route (a LiveKit participant attribute on the broadcaster's token — see
// live-audio/translation-session-manager.ts), because the supervisor decides which
// bridges to run from room presence and can't wait on a doc sync to do it. The
// broadcaster writes both, from the one place where the fact is known.
//
// Kept free of any runtime dependency (the Y import is type-only, and there is no React
// here — the hook lives in useSourceLanguage.ts) so both the browser and the Node server
// can import it.
import type * as Y from 'yjs';

/** Root-type key of the live-audio settings map. */
export const LIVE_AUDIO_CONFIG_KEY = 'liveAudioConfig';

/** Field within that map holding the spoken language's BCP-47 code. */
export const SOURCE_LANGUAGE_FIELD = 'sourceLanguage';

/**
 * What a session is assumed to be spoken in when it never says. Every session
 * recorded before this setting existed is one of those, and was English — so this
 * is not merely a default, it's what keeps old docs reading correctly.
 */
export const DEFAULT_SOURCE_LANGUAGE = 'en';

/** The BCP-47 code this session is being spoken in. */
export function readSourceLanguage(doc: Y.Doc): string {
  return normalizeSourceLanguage(doc.getMap(LIVE_AUDIO_CONFIG_KEY).get(SOURCE_LANGUAGE_FIELD));
}

/**
 * Record the spoken language. A no-op when unchanged, so a broadcaster re-declaring
 * the same language on every reconnect doesn't churn the doc.
 */
export function writeSourceLanguage(doc: Y.Doc, code: string): void {
  const map = doc.getMap(LIVE_AUDIO_CONFIG_KEY);
  const next = normalizeSourceLanguage(code);
  if (map.get(SOURCE_LANGUAGE_FIELD) === next) return;
  map.set(SOURCE_LANGUAGE_FIELD, next);
}

/** Coerce anything that reaches us — an unset field, a stale shape — to a usable code. */
export function normalizeSourceLanguage(value: unknown): string {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : DEFAULT_SOURCE_LANGUAGE;
}
