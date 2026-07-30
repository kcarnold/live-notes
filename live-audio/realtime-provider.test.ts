import { describe, expect, it } from "vitest";

import { GeminiProvider, parseGoAwayTimeLeftMs } from "./gemini-provider.ts";
import { interpreterInstructions, OpenAIProvider } from "./openai-provider.ts";
import type { ProviderEvent, RealtimeProvider } from "./realtime-provider.ts";

/**
 * Provider tests: "do we speak this vendor's protocol correctly."
 *
 * This is the whole reason the provider seam is shaped the way it is. A provider takes a
 * parsed message and returns events; it never touches a socket. So the questions that
 * used to require a live session and a pair of headphones — does a `setupComplete`
 * actually read as ready, does an audio delta actually reach the bridge, does the model
 * get told to translate rather than converse — are now plain assertions.
 *
 * What these tests deliberately do *not* prove is that the vendor agrees with us. If
 * OpenAI renames an event, this file stays green and the bridge goes silent — which is
 * exactly the failure this subsystem exists to prevent, so it is handled two other ways:
 * the interpreters accept both spellings of the events that have already been renamed
 * once, and docs/SMOKE_TEST.md §4 requires a human to hear real Creole audio before a
 * service. Tests pin our side of the contract; only listening pins theirs.
 */

const geminiProvider = (over: Partial<{ targetLanguage: string; transcribeInput: boolean }> = {}) =>
  new GeminiProvider({
    apiKey: "test-key",
    targetLanguage: over.targetLanguage ?? "fr",
    transcribeInput: over.transcribeInput ?? false,
  });

const openaiProvider = (over: Partial<{ targetLanguage: string; transcribeInput: boolean }> = {}) =>
  new OpenAIProvider(
    {
      apiKey: "test-key",
      targetLanguage: over.targetLanguage ?? "ht",
      transcribeInput: over.transcribeInput ?? false,
    },
    {} // don't read env in tests
  );

/**
 * The one setup message a provider sends — every provider we have sends exactly one.
 * Typed loosely on purpose: these are foreign vendor payloads whose shape is the thing
 * under test, so re-declaring it here would only assert that our copy matches our copy.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VendorPayload = Record<string, any>;

function setup(provider: RealtimeProvider): VendorPayload {
  const messages = provider.setupMessages();
  expect(messages).toHaveLength(1);
  return messages[0] as VendorPayload;
}

const kinds = (events: ProviderEvent[]) => events.map((e) => e.kind);

describe("GeminiProvider", () => {
  it("connects to the Gemini Live endpoint with the key in the URL", () => {
    const { url } = geminiProvider().socket();
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("key=test-key");
  });

  it("configures the translate model for audio out in the target language", () => {
    const { setup: s } = setup(geminiProvider({ targetLanguage: "es" }));
    expect(s.model).toBe("models/gemini-3.5-live-translate-preview");
    expect(s.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(s.generationConfig.translationConfig).toEqual({
      targetLanguageCode: "es",
      echoTargetLanguage: true,
    });
  });

  it("asks for input transcription only when this bridge writes the source transcript", () => {
    // The English transcript must be written once per session, not once per language,
    // so every non-primary bridge has to leave this off.
    expect(setup(geminiProvider({ transcribeInput: false })).setup).not.toHaveProperty(
      "inputAudioTranscription"
    );
    expect(setup(geminiProvider({ transcribeInput: true })).setup).toHaveProperty(
      "inputAudioTranscription"
    );
  });

  it("wraps an input frame as realtimeInput at 16 kHz", () => {
    const provider = geminiProvider();
    expect(provider.inputSampleRate).toBe(16_000);
    expect(provider.inputFrameMessage("QUJD")).toEqual({
      realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: "QUJD" } },
    });
  });

  it("reads setupComplete as ready", () => {
    expect(kinds(geminiProvider().interpret({ setupComplete: {} }))).toEqual(["ready"]);
  });

  it("reads audio and transcript out of serverContent", () => {
    const events = geminiProvider().interpret({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: "QUJD" } }, { inlineData: { data: "REVG" } }] },
        outputTranscription: { text: "bonjour" },
      },
    });
    expect(events).toEqual([
      { kind: "audio", base64: "QUJD" },
      { kind: "audio", base64: "REVG" },
      { kind: "targetTranscript", text: "bonjour" },
    ]);
  });

  it("drops input transcription unless this bridge asked for it", () => {
    const content = { serverContent: { inputTranscription: { text: "hello" } } };
    expect(geminiProvider({ transcribeInput: false }).interpret(content)).toEqual([]);
    expect(geminiProvider({ transcribeInput: true }).interpret(content)).toEqual([
      { kind: "sourceTranscript", text: "hello" },
    ]);
  });

  it("reads goAway (either casing) so the bridge can swap make-before-break", () => {
    expect(geminiProvider().interpret({ goAway: { timeLeft: "10s" } })).toEqual([
      { kind: "goAway", timeLeftMs: 10_000, raw: "10s" },
    ]);
    expect(geminiProvider().interpret({ go_away: { time_left: "2s" } })).toEqual([
      { kind: "goAway", timeLeftMs: 2_000, raw: "2s" },
    ]);
  });

  it("reports session-resumption offers without acting on them", () => {
    expect(
      geminiProvider().interpret({ sessionResumptionUpdate: { resumable: true, newHandle: "h" } })
    ).toEqual([{ kind: "resumable", resumable: true, hasHandle: true }]);
  });

  it("ignores messages it has no meaning for", () => {
    expect(geminiProvider().interpret({ usageMetadata: { totalTokenCount: 12 } })).toEqual([]);
  });
});

// The wire shape here is the part of this change that cannot be verified from a test
// suite alone (see the file header), so these tests pin every field the bridge depends
// on — a silent typo in one of them is a bridge that connects and plays nothing.
describe("OpenAIProvider", () => {
  it("connects to the Realtime endpoint with the key in a header, not the URL", () => {
    // Gemini puts its key in the query string; this one must not, so the URL stays safe
    // to log.
    const { url, options } = openaiProvider().socket();
    expect(url).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1");
    expect(url).not.toContain("test-key");
    expect(options.headers).toEqual({ Authorization: "Bearer test-key" });
  });

  it("honors a model override, so a new model id needs no code change", () => {
    const provider = new OpenAIProvider(
      { apiKey: "k", targetLanguage: "ht", transcribeInput: false },
      { model: "gpt-realtime-9" }
    );
    expect(provider.model).toBe("gpt-realtime-9");
    expect(provider.socket().url).toContain("model=gpt-realtime-9");
  });

  it("configures audio-only output with server-driven turns at 24 kHz both ways", () => {
    const provider = openaiProvider();
    expect(provider.inputSampleRate).toBe(24_000);
    expect(provider.outputSampleRate).toBe(24_000);

    const message = setup(provider);
    expect(message.type).toBe("session.update");
    expect(message.session.type).toBe("realtime");
    expect(message.session.output_modalities).toEqual(["audio"]);
    expect(message.session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24_000 });
    expect(message.session.audio.output.format).toEqual({ type: "audio/pcm", rate: 24_000 });
    // The server decides when a translation starts; the bridge never sends
    // response.create, so there is exactly one thing deciding turn boundaries.
    expect(message.session.audio.input.turn_detection.create_response).toBe(true);
  });

  it("does not let new speech cut off a translation in progress", () => {
    // A speaker at a podium talks continuously, so interruption-on-speech would truncate
    // most translations — the model would be interrupted by the very audio it is
    // translating. Latency is the accepted cost; see OpenAIProviderOptions.
    expect(setup(openaiProvider()).session.audio.input.turn_detection.interrupt_response).toBe(
      false
    );
  });

  it("instructs the model to interpret rather than converse", () => {
    const instructions = setup(openaiProvider({ targetLanguage: "ht" })).session.instructions;
    // Unlike Gemini's translate model, "only translate" here is a prompt — so the prompt
    // is part of the contract, and naming the language is the load-bearing half of it.
    expect(instructions).toContain("Haitian Creole");
    expect(instructions).toContain("ht");
    expect(instructions.toLowerCase()).toContain("interpreter");
    expect(instructions).toMatch(/do not answer it/i);
  });

  it("names the target language in the prompt for any code, not just Creole", () => {
    expect(interpreterInstructions("es")).toContain("Spanish");
    // An unknown code still produces a usable prompt rather than throwing.
    expect(interpreterInstructions("zz")).toContain("zz");
  });

  it("asks for input transcription only when this bridge writes the source transcript", () => {
    expect(setup(openaiProvider({ transcribeInput: false })).session.audio.input).not.toHaveProperty(
      "transcription"
    );
    expect(setup(openaiProvider({ transcribeInput: true })).session.audio.input).toHaveProperty(
      "transcription"
    );
  });

  it("appends input frames to the audio buffer", () => {
    expect(openaiProvider().inputFrameMessage("QUJD")).toEqual({
      type: "input_audio_buffer.append",
      audio: "QUJD",
    });
  });

  it("waits for session.updated — not session.created — before sending audio", () => {
    // session.created lands before our session.update is even sent, so the session is
    // not yet an interpreter. Treating it as ready would stream the first words of the
    // talk into a plain chatbot.
    const provider = openaiProvider();
    expect(provider.interpret({ type: "session.created", session: {} })).toEqual([]);
    expect(kinds(provider.interpret({ type: "session.updated", session: {} }))).toEqual(["ready"]);
  });

  it("reads output audio and transcript deltas, under GA or beta event names", () => {
    const provider = openaiProvider();
    expect(provider.interpret({ type: "response.output_audio.delta", delta: "QUJD" })).toEqual([
      { kind: "audio", base64: "QUJD" },
    ]);
    expect(provider.interpret({ type: "response.audio.delta", delta: "QUJD" })).toEqual([
      { kind: "audio", base64: "QUJD" },
    ]);
    expect(
      provider.interpret({ type: "response.output_audio_transcript.delta", delta: "bonjou" })
    ).toEqual([{ kind: "targetTranscript", text: "bonjou" }]);
    expect(provider.interpret({ type: "response.audio_transcript.delta", delta: "bonjou" })).toEqual(
      [{ kind: "targetTranscript", text: "bonjou" }]
    );
  });

  it("reads input transcription deltas only when asked for them", () => {
    const message = {
      type: "conversation.item.input_audio_transcription.delta",
      delta: "hello",
    };
    expect(openaiProvider({ transcribeInput: false }).interpret(message)).toEqual([]);
    expect(openaiProvider({ transcribeInput: true }).interpret(message)).toEqual([
      { kind: "sourceTranscript", text: "hello" },
    ]);
  });

  it("ignores empty deltas rather than writing blank transcript", () => {
    const provider = openaiProvider();
    expect(provider.interpret({ type: "response.output_audio.delta", delta: "" })).toEqual([]);
    expect(provider.interpret({ type: "response.output_audio_transcript.delta" })).toEqual([]);
  });

  it("treats a session expiry as fatal and everything else as noise", () => {
    const provider = openaiProvider();
    expect(
      provider.interpret({ type: "error", error: { code: "session_expired", message: "bye" } })
    ).toEqual([{ kind: "error", message: "bye", code: "session_expired", fatal: true }]);

    // A response rejected because one is still speaking is per-response, not
    // per-session: throwing away a working socket over it would be the worse outcome.
    expect(
      provider.interpret({
        type: "error",
        error: { code: "conversation_already_has_active_response", message: "busy" },
      })
    ).toEqual([
      {
        kind: "error",
        message: "busy",
        code: "conversation_already_has_active_response",
        fatal: false,
      },
    ]);
  });

  it("ignores the rest of a chatty protocol", () => {
    const provider = openaiProvider();
    for (const type of [
      "response.created",
      "response.done",
      "input_audio_buffer.speech_started",
      "rate_limits.updated",
      "conversation.item.created",
    ]) {
      expect(provider.interpret({ type })).toEqual([]);
    }
    expect(provider.interpret({})).toEqual([]);
  });
});

// Kept from the bridge's own suite when goAway parsing moved into the Gemini provider:
// the wire shape is unconfirmed for the translate model, so it tolerates every plausible
// encoding rather than guessing one.
describe("parseGoAwayTimeLeftMs", () => {
  it("parses protobuf Duration strings (seconds)", () => {
    expect(parseGoAwayTimeLeftMs("10s")).toBe(10_000);
    expect(parseGoAwayTimeLeftMs("10.5s")).toBe(10_500);
    expect(parseGoAwayTimeLeftMs(" 2s ")).toBe(2_000);
  });

  it("parses a bare numeric string as seconds", () => {
    expect(parseGoAwayTimeLeftMs("10")).toBe(10_000);
  });

  it("parses a number as seconds", () => {
    expect(parseGoAwayTimeLeftMs(7)).toBe(7_000);
  });

  it("parses an expanded { seconds, nanos } Duration object", () => {
    expect(parseGoAwayTimeLeftMs({ seconds: 8 })).toBe(8_000);
    expect(parseGoAwayTimeLeftMs({ seconds: "8", nanos: 500_000_000 })).toBe(8_500);
  });

  it("returns null for missing or unparseable values", () => {
    expect(parseGoAwayTimeLeftMs(null)).toBeNull();
    expect(parseGoAwayTimeLeftMs(undefined)).toBeNull();
    expect(parseGoAwayTimeLeftMs("soon")).toBeNull();
    expect(parseGoAwayTimeLeftMs({})).toBeNull();
  });
});
