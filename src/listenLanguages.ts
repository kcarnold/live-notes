// Languages supported by the Gemini Live Translate API, used by the "listen"
// (live speech-to-speech) picker. This is a much larger set than the project's
// curated text-translation languages (configAtoms.ts), so it lives separately.
//
// The picker's "Original" entry is not in this list: it is whatever language the
// session is being spoken in (see liveAudioConfig.ts), which is a per-session fact
// rather than a constant — choosing it means hearing the speaker's own voice and
// reading the transcript of what they actually said.
//
// We store only BCP-47 codes here; display names are localized at render time via
// `Intl.DisplayNames([locale])` (the pattern already used elsewhere in App.tsx),
// so we don't hard-code English names or flags.
//
// Source: gemini-live-api-examples/.../lib/languages.ts (Haitian Creole is not in
// that list — Gemini Live Translate doesn't support it — so it's absent here too).

export const LISTEN_LANGUAGE_CODES: string[] = [
  "af", "ak", "sq", "am", "ar", "hy", "as", "az", "eu", "be", "bn", "bs", "bg",
  "my", "yue", "ca", "ceb", "zh", "hr", "cs", "da", "nl", "en", "et", "fo", "fil",
  "fi", "fr", "gl", "ka", "de", "el", "gu", "ha", "iw", "hi", "hu", "is", "id",
  "ga", "it", "ja", "kn", "kk", "km", "rw", "ko", "ku", "ky", "lo", "lv", "lt",
  "mk", "ms", "ml", "mt", "mi", "mr", "mn", "ne", "nb", "or", "om", "ps", "fa",
  "pl", "pt", "pa", "qu", "ro", "rm", "ru", "sr", "sd", "si", "sk", "sl", "so",
  "st", "es", "sw", "sv", "tg", "ta", "te", "th", "tn", "tr", "tk", "uk", "ur",
  "uz", "vi", "cy", "fy", "wo", "yo", "zu",
];

// Pinned to the top of the picker for quick access. (Gemini Live Translate does
// not support Haitian Creole, so only French and Spanish are favorited.)
export const LISTEN_FAVORITES: string[] = ["fr", "es"];

// Default language for the listen pane when none is specified in the URL.
export const DEFAULT_LISTEN_CODE = "fr";

// Which language the listen pane opens on. Normally the deployment's default, but
// never the language being spoken — landing a listener on "Original" by accident
// would silently give them untranslated audio and look like the feature is broken.
// English is the fallback for the same reason it is the fallback everywhere else:
// it's what a room with no other shared language reaches for.
export function defaultListenCode(sourceLanguage: string): string {
  return sourceLanguage === DEFAULT_LISTEN_CODE ? "en" : DEFAULT_LISTEN_CODE;
}

export function isListenLanguage(code: string): boolean {
  return LISTEN_LANGUAGE_CODES.includes(code);
}
