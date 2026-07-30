// Languages offered by the "listen" (live speech-to-speech) picker, and — because the
// two are the same question — which realtime backend can actually produce each one.
// This is a much larger set than the project's curated text-translation languages
// (configAtoms.ts), so it lives separately.
//
// We store only BCP-47 codes here; display names are localized at render time via
// `Intl.DisplayNames([locale])` (the pattern already used elsewhere in App.tsx),
// so we don't hard-code English names or flags.
//
// This module is the single source of truth for the backend routing too: the server
// imports these lists in live-audio/provider-selection.ts to decide which provider a
// requested language gets. Keeping one list means the picker can never offer a language
// no bridge can serve, and no bridge has to guess about a language the picker offers.
// (Same reason transcriptKeys.ts is shared between the client and sessionExport.ts.)
// Kept dependency-free so importing it from either side costs nothing.

// Languages the Gemini Live Translate API can output. Notably absent: Haitian Creole.
// Source: gemini-live-api-examples/.../lib/languages.ts.
export const GEMINI_LISTEN_LANGUAGE_CODES: string[] = [
  "af", "ak", "sq", "am", "ar", "hy", "as", "az", "eu", "be", "bn", "bs", "bg",
  "my", "yue", "ca", "ceb", "zh", "hr", "cs", "da", "nl", "en", "et", "fo", "fil",
  "fi", "fr", "gl", "ka", "de", "el", "gu", "ha", "iw", "hi", "hu", "is", "id",
  "ga", "it", "ja", "kn", "kk", "km", "rw", "ko", "ku", "ky", "lo", "lv", "lt",
  "mk", "ms", "ml", "mt", "mi", "mr", "mn", "ne", "nb", "or", "om", "ps", "fa",
  "pl", "pt", "pa", "qu", "ro", "rm", "ru", "sr", "sd", "si", "sk", "sl", "so",
  "st", "es", "sw", "sv", "tg", "ta", "te", "th", "tn", "tr", "tk", "uk", "ur",
  "uz", "vi", "cy", "fy", "wo", "yo", "zu",
];

// Languages served by the OpenAI Realtime provider instead, because Gemini Live
// Translate has no voice for them at all.
//
// Only Haitian Creole is here, and it is the reason that provider exists. Note this is
// *not* OpenAI's full capability list — OpenAI's own live-translation model can't output
// Creole either, so this route goes through the general speech-to-speech model with an
// interpreter prompt (see live-audio/openai-provider.ts). Adding a language here is a
// claim that a prompted conversational model speaks it acceptably, which is worth
// verifying by listening before you make it.
export const OPENAI_LISTEN_LANGUAGE_CODES: string[] = ["ht"];

/** Everything the picker offers, whichever backend ends up serving it. */
export const LISTEN_LANGUAGE_CODES: string[] = [
  ...GEMINI_LISTEN_LANGUAGE_CODES,
  ...OPENAI_LISTEN_LANGUAGE_CODES.filter((c) => !GEMINI_LISTEN_LANGUAGE_CODES.includes(c)),
];

// Pinned to the top of the picker for quick access — the languages this project's
// services actually run in.
export const LISTEN_FAVORITES: string[] = ["fr", "ht", "es"];

// "Original / English": play the speaker's raw audio and show the English source
// transcript (produced for free via input transcription on the default bridge).
export const LISTEN_ORIGINAL_CODE = "en";

// Default language for the listen pane when none is specified in the URL.
export const DEFAULT_LISTEN_CODE = "fr";

export function isListenLanguage(code: string): boolean {
  return LISTEN_LANGUAGE_CODES.includes(code);
}
