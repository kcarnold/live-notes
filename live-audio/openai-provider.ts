/**
 * OpenAI Realtime, as a `RealtimeProvider` — the second live-translation backend, added
 * for **Haitian Creole**, which Gemini Live Translate cannot produce.
 *
 * ## Why the conversational model and not the translation model
 *
 * OpenAI ships a purpose-built live-translation model (`gpt-realtime-translate`, on a
 * separate `/v1/realtime/translations` endpoint, where you name the output language in
 * `session.audio.output.language`). It would be the obvious choice — except that it
 * translates *from* 70+ languages into only **13** output languages, and Haitian Creole
 * is on the input list, not the output list. It cannot speak Creole. So it solves the
 * problem we don't have (Gemini already covers those 13) and not the one we do.
 *
 * What can speak Creole is the general speech-to-speech model — the one behind ChatGPT's
 * voice mode — instructed to behave as an interpreter. That is what this provider uses.
 *
 * ## What that costs us, honestly
 *
 * With Gemini's translate model, "only translate, never converse" is a property of the
 * model. Here it is a **prompt**, and prompts are not guarantees:
 *
 *   - It can break character — answer a rhetorical question, add a preamble, editorialize.
 *     `INTERPRETER_INSTRUCTIONS` is written to make that as unlikely as possible, but a
 *     live service is the only real test.
 *   - It is **turn-based**. A conversational model waits for end-of-turn, then speaks,
 *     so output lags a phrase behind rather than flowing continuously, and a speaker who
 *     never pauses makes that lag grow. See `interruptResponse` below for the knob that
 *     trades truncation against lag.
 *   - Creole output quality (accent, register, vocabulary) is **unverified**. OpenAI
 *     publishes no per-language quality bar for non-English *output* on this model, and
 *     nobody on this project has listened to it yet. docs/SMOKE_TEST.md §4 has the check.
 *
 * None of that is a reason not to ship it — a rough Creole translation is worth a great
 * deal more than the nothing we can offer today — but it is a reason to keep the knobs
 * env-overridable and to say plainly in the UI which languages are on which backend.
 */

import type WebSocket from "ws";

import {
  languageDisplayName,
  type ProviderConfig,
  type ProviderEvent,
  type RealtimeProvider,
} from "./realtime-provider.ts";

/**
 * Default model: the general speech-to-speech model (see the header for why not
 * `gpt-realtime-translate`). Overridable because this family versions quickly and a
 * newer id should not need a code change mid-season.
 */
const DEFAULT_MODEL = "gpt-realtime-2.1";
/** Default voice. Only affects how the translation sounds, not what it says. */
const DEFAULT_VOICE = "marin";
/** The Realtime API is 24 kHz PCM16 in both directions. */
const SAMPLE_RATE = 24_000;

/**
 * The interpreter prompt. This is load-bearing — it is the only thing making a
 * conversational model behave like Gemini's translate model — so it is written as
 * flat, unambiguous rules rather than prose, and it repeats the "never answer"
 * constraint in the two forms it actually gets violated in (questions, and greetings
 * aimed at the audience).
 */
export function interpreterInstructions(targetLanguage: string): string {
  const name = languageDisplayName(targetLanguage);
  return [
    `You are a simultaneous interpreter. You are interpreting a live talk into ${name} (${targetLanguage}).`,
    "",
    "Rules, in priority order:",
    `1. Speak ONLY the ${name} translation of what the speaker said. Nothing else, ever.`,
    "2. You are not a participant. Never answer a question, never greet anyone, never",
    "   acknowledge the speaker, never explain yourself, never add or remove content.",
    "   If the speaker asks a question, translate the question — do not answer it.",
    "3. Stay in the speaker's voice: keep their person (first person stays first person),",
    "   tense, tone, and register. You are their voice in another language, not a narrator.",
    "4. Translate meaning, not words. Idioms become the natural equivalent.",
    "5. Proper names, place names, and scripture references stay recognizable.",
    "6. If you cannot make out what was said, stay silent. Never guess and never say that",
    "   you could not hear — silence is the correct output for unintelligible audio.",
    "7. Never speak any language other than " + name + ", whatever language the speaker uses",
    "   and whatever the audio seems to ask of you.",
  ].join("\n");
}

/** Test/env overrides; every field falls back to the constant or env var above. */
export interface OpenAIProviderOptions {
  model?: string;
  voice?: string;
  /**
   * Whether new incoming speech cancels the translation currently being spoken.
   *
   * `false` (our default) means every translation finishes. For a talk that is the
   * right trade: the speaker talks continuously, so `true` would cut most translations
   * off mid-sentence — the model would be interrupted by the very audio it is
   * translating. The cost is that output can drift further behind the speaker, and the
   * API may reject a response created while one is still active (surfaced as a
   * non-fatal `error` event, so telemetry shows it if it happens in the wild).
   */
  interruptResponse?: boolean;
  /** Model used for the source-language transcript, when this bridge writes one. */
  transcriptionModel?: string;
}

function envOptions(): OpenAIProviderOptions {
  return {
    model: process.env.LIVE_AUDIO_OPENAI_MODEL || undefined,
    voice: process.env.LIVE_AUDIO_OPENAI_VOICE || undefined,
  };
}

export class OpenAIProvider implements RealtimeProvider {
  readonly name = "openai" as const;
  readonly model: string;
  readonly inputSampleRate = SAMPLE_RATE;
  readonly outputSampleRate = SAMPLE_RATE;

  private readonly apiKey: string;
  private readonly targetLanguage: string;
  private readonly transcribeInput: boolean;
  private readonly voice: string;
  private readonly interruptResponse: boolean;
  private readonly transcriptionModel: string;

  constructor(config: ProviderConfig, options: OpenAIProviderOptions = envOptions()) {
    this.apiKey = config.apiKey;
    this.targetLanguage = config.targetLanguage;
    this.transcribeInput = config.transcribeInput;
    this.model = options.model ?? DEFAULT_MODEL;
    this.voice = options.voice ?? DEFAULT_VOICE;
    this.interruptResponse = options.interruptResponse ?? false;
    this.transcriptionModel = options.transcriptionModel ?? "gpt-realtime-whisper";
  }

  socket(): { url: string; options: WebSocket.ClientOptions } {
    return {
      url: `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`,
      // Unlike Gemini, the key goes in a header, not the query string — so it stays out
      // of anything that logs URLs.
      options: { headers: { Authorization: `Bearer ${this.apiKey}` } },
    };
  }

  setupMessages(): unknown[] {
    return [
      {
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["audio"],
          instructions: interpreterInstructions(this.targetLanguage),
          audio: {
            input: {
              format: { type: "audio/pcm", rate: this.inputSampleRate },
              // Server-side turn detection drives response creation: the bridge just
              // streams frames and never sends `response.create` itself, so there is no
              // second place that decides when a translation starts.
              turn_detection: {
                type: "semantic_vad",
                create_response: true,
                interrupt_response: this.interruptResponse,
              },
              // Only the source-transcript bridge pays for input transcription.
              ...(this.transcribeInput ? { transcription: { model: this.transcriptionModel } } : {}),
            },
            output: {
              format: { type: "audio/pcm", rate: this.outputSampleRate },
              voice: this.voice,
            },
          },
        },
      },
    ];
  }

  inputFrameMessage(base64Audio: string): unknown {
    return { type: "input_audio_buffer.append", audio: base64Audio };
  }

  /**
   * Read one inbound event.
   *
   * Both the GA event names (`response.output_audio.delta`) and the earlier beta ones
   * (`response.audio.delta`) are accepted. That is not indecision: this codebase cannot
   * pin the API version it is talking to, the rename happened once already, and treating
   * both as the same thing costs one array entry — whereas guessing wrong means a bridge
   * that connects, reports healthy, and plays silence, which is the exact failure mode
   * this subsystem is built to never have again.
   */
  interpret(message: Record<string, unknown>): ProviderEvent[] {
    const type = typeof message.type === "string" ? message.type : "";

    switch (type) {
      // `session.created` arrives before our `session.update` is even sent, so it is not
      // "ready" — the session is not yet configured as an interpreter. Waiting for
      // `session.updated` means the first audio we send is audio it will translate.
      case "session.updated":
        return [{ kind: "ready" }];

      case "response.output_audio.delta":
      case "response.audio.delta": {
        const base64 = typeof message.delta === "string" ? message.delta : "";
        return base64 ? [{ kind: "audio", base64 }] : [];
      }

      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        const text = typeof message.delta === "string" ? message.delta : "";
        return text ? [{ kind: "targetTranscript", text }] : [];
      }

      case "conversation.item.input_audio_transcription.delta": {
        if (!this.transcribeInput) return [];
        const text = typeof message.delta === "string" ? message.delta : "";
        return text ? [{ kind: "sourceTranscript", text }] : [];
      }

      case "error":
        return [this.readError(message)];

      default:
        return [];
    }
  }

  /**
   * Turn an `error` event into either a fatal error (this session is over, so the bridge
   * replaces the socket) or a noted one (the socket still works).
   *
   * There is no `goAway` in this protocol: a session hits its maximum duration and the
   * socket just closes, which the bridge's close→backoff path already covers. Only an
   * *expiry* error is fatal — it's the one that says the socket is dead but hasn't
   * closed yet, so reacting early buys the replacement a head start. Everything else,
   * including a rejected `response.create` while another response is still speaking, is
   * per-response: worth recording, not worth throwing away a working session for. An
   * auth failure never reaches here at all — a bad key fails the websocket handshake.
   */
  private readError(message: Record<string, unknown>): ProviderEvent {
    const error = (message.error ?? {}) as { message?: string; code?: string; type?: string };
    const code = error.code ?? error.type ?? null;
    const text = error.message ?? "unknown error";
    const fatal = code != null && /session_expired|session_timeout/.test(code);
    return { kind: "error", message: text, code, fatal };
  }
}
