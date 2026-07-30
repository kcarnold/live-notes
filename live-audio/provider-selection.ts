/**
 * Which realtime backend serves a requested listen language.
 *
 * The rule is "whoever can actually speak it", and it has exactly one interesting case:
 * Haitian Creole, which Gemini Live Translate cannot produce and OpenAI's Realtime API
 * can be prompted into. Everything else Gemini already covers, and Gemini stays the
 * default for it — this is an *addition*, not a migration, so a Sunday that used to run
 * on Gemini still runs on Gemini, byte for byte.
 *
 * The decision is a pure function over (language, which keys are configured, operator
 * override) so it can be unit-tested without constructing a provider, and so the answer
 * "nobody can serve this" is a value the supervisor can act on rather than an exception
 * thrown from inside a bridge.
 */

import {
  GEMINI_LISTEN_LANGUAGE_CODES,
  OPENAI_LISTEN_LANGUAGE_CODES,
} from "../src/listenLanguages.ts";
import { GeminiProvider } from "./gemini-provider.ts";
import { OpenAIProvider } from "./openai-provider.ts";
import type { ProviderConfig, ProviderName, RealtimeProvider } from "./realtime-provider.ts";

/** Which providers this deployment has credentials for. */
export interface ProviderKeys {
  gemini: string | undefined;
  openai: string | undefined;
}

/**
 * Parse a comma-separated list of BCP-47 codes from an env var into a set. Used by
 * `LIVE_AUDIO_OPENAI_LANGUAGES` so an operator can move a language onto OpenAI (to
 * compare the two on a language both support, say) without a deploy.
 */
export function parseLanguageList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((code) => code.trim())
      .filter((code) => code.length > 0)
  );
}

/**
 * Pick the provider for a language, or null if this deployment cannot serve it.
 *
 * Order matters:
 *   1. An explicit operator override wins, so an experiment doesn't need a code change.
 *   2. Otherwise Gemini gets everything it supports — the incumbent keeps its languages.
 *   3. Otherwise OpenAI gets the languages we've decided it can carry (Haitian Creole).
 *   4. Otherwise null: an unknown or unserveable code. Deliberately *not* "send it to
 *      OpenAI and hope" — a typo'd `listen=` attribute would then start a paid session
 *      translating into nothing, and the listener would hear confident gibberish rather
 *      than an obvious failure.
 */
export function chooseProviderName(params: {
  language: string;
  keys: ProviderKeys;
  openaiLanguages?: ReadonlySet<string>;
}): ProviderName | null {
  const { language, keys } = params;
  const overrides = params.openaiLanguages ?? new Set<string>();

  if (overrides.has(language) && keys.openai) return "openai";
  if (GEMINI_LISTEN_LANGUAGE_CODES.includes(language) && keys.gemini) return "gemini";
  if (OPENAI_LISTEN_LANGUAGE_CODES.includes(language) && keys.openai) return "openai";
  return null;
}

/** Construct the named provider. Throws if its key is missing — check first. */
export function createProvider(
  name: ProviderName,
  keys: ProviderKeys,
  config: Omit<ProviderConfig, "apiKey">
): RealtimeProvider {
  if (name === "openai") {
    if (!keys.openai) throw new Error("OPENAI_API_KEY is not set");
    return new OpenAIProvider({ ...config, apiKey: keys.openai });
  }
  if (!keys.gemini) throw new Error("GEMINI_API_KEY is not set");
  return new GeminiProvider({ ...config, apiKey: keys.gemini });
}

/**
 * The one call site's whole decision: name the provider for this language and build it,
 * or return null because nothing here can speak it.
 */
export function providerForLanguage(params: {
  language: string;
  keys: ProviderKeys;
  openaiLanguages?: ReadonlySet<string>;
  transcribeInput: boolean;
}): RealtimeProvider | null {
  const name = chooseProviderName(params);
  if (!name) return null;
  return createProvider(name, params.keys, {
    targetLanguage: params.language,
    transcribeInput: params.transcribeInput,
  });
}
