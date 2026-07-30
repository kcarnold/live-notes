import { describe, expect, it } from "vitest";

import {
  chooseProviderName,
  createProvider,
  parseLanguageList,
  providerForLanguage,
} from "./provider-selection.ts";

/**
 * Routing tests. The interesting property is not "ht goes to OpenAI" on its own — it is
 * that adding a second provider changed *nothing* about the languages the first one
 * already served. A Sunday that ran on Gemini must still run on Gemini, so most of these
 * assert the absence of a change.
 */

const bothKeys = { gemini: "g", openai: "o" };
const geminiOnly = { gemini: "g", openai: undefined };
const openaiOnly = { gemini: undefined, openai: "o" };

const choose = (language: string, keys = bothKeys, openaiLanguages?: Set<string>) =>
  chooseProviderName({ language, keys, openaiLanguages });

describe("chooseProviderName", () => {
  it("routes Haitian Creole to OpenAI — the reason the second provider exists", () => {
    expect(choose("ht")).toBe("openai");
  });

  it("leaves every language Gemini supports on Gemini", () => {
    // Including the two this project actually runs, and the source language.
    for (const code of ["fr", "es", "en", "sw", "zh"]) {
      expect(choose(code)).toBe("gemini");
    }
  });

  it("serves nothing it cannot speak, rather than guessing", () => {
    // A typo'd `listen=` attribute must fail visibly at bridge start. Falling back to
    // OpenAI here would spend money translating into a language that doesn't exist and
    // hand the listener confident nonsense.
    expect(choose("xx")).toBeNull();
    expect(choose("")).toBeNull();
  });

  it("cannot serve Creole without an OpenAI key, and says so", () => {
    // The honest failure for a deployment that hasn't added the key: null, not a Gemini
    // bridge that would quietly translate into some other language.
    expect(choose("ht", geminiOnly)).toBeNull();
    expect(choose("fr", geminiOnly)).toBe("gemini");
  });

  it("falls back to nothing (not OpenAI) for Gemini languages when Gemini is unkeyed", () => {
    // OpenAI *could* be prompted to speak French, but silently moving a language between
    // backends on a missing env var is how a service ends up sounding different for
    // reasons nobody can trace.
    expect(choose("fr", openaiOnly)).toBeNull();
    expect(choose("ht", openaiOnly)).toBe("openai");
  });

  it("lets an operator move a language onto OpenAI without a deploy", () => {
    // For comparing the two backends on a language both can serve.
    expect(choose("fr", bothKeys, new Set(["fr"]))).toBe("openai");
    expect(choose("es", bothKeys, new Set(["fr"]))).toBe("gemini");
  });

  it("ignores an override it has no key for", () => {
    expect(choose("fr", geminiOnly, new Set(["fr"]))).toBe("gemini");
  });
});

describe("parseLanguageList", () => {
  it("reads a comma-separated list, tolerating spacing", () => {
    expect(parseLanguageList(" fr , ht ,es ")).toEqual(new Set(["fr", "ht", "es"]));
  });

  it("is empty when unset or blank", () => {
    expect(parseLanguageList(undefined)).toEqual(new Set());
    expect(parseLanguageList("")).toEqual(new Set());
    expect(parseLanguageList(" , ")).toEqual(new Set());
  });
});

describe("createProvider / providerForLanguage", () => {
  it("builds a provider carrying the bridge's language and transcript role", () => {
    const provider = providerForLanguage({
      language: "ht",
      keys: bothKeys,
      transcribeInput: false,
    });
    expect(provider?.name).toBe("openai");
    // The prompt is where the target language lands for this provider, so this is the
    // check that the language actually reached it.
    expect(JSON.stringify(provider?.setupMessages())).toContain("Haitian Creole");
  });

  it("returns null (not a broken provider) for a language nothing can serve", () => {
    expect(providerForLanguage({ language: "xx", keys: bothKeys, transcribeInput: false })).toBeNull();
  });

  it("refuses to build a provider whose key is missing", () => {
    expect(() =>
      createProvider("openai", geminiOnly, { targetLanguage: "ht", transcribeInput: false })
    ).toThrow(/OPENAI_API_KEY/);
    expect(() =>
      createProvider("gemini", openaiOnly, { targetLanguage: "fr", transcribeInput: false })
    ).toThrow(/GEMINI_API_KEY/);
  });
});
