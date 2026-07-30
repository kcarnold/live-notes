/**
 * Gemini Live Translate, as a `RealtimeProvider`.
 *
 * This is a straight lift of what `translation-bridge.ts` used to do inline, so its
 * behavior on the wire is unchanged: same model, same setup message, same
 * `realtimeInput` frame shape, same 16 kHz in / 24 kHz out. Nothing here is new — the
 * only new thing is that it is now nameable, so a second provider can sit beside it.
 *
 * Gemini's purpose-built translate model does the interpreting for us (`translationConfig`
 * with `echoTargetLanguage`), which is why this provider carries no prompt: the model is
 * already a simultaneous interpreter and cannot be talked into being a chatbot. That is
 * the main thing the OpenAI provider has to reproduce by other means.
 *
 * Note it does **not** cover every language: Gemini Live Translate has no Haitian Creole,
 * which is the whole reason a second provider exists (see provider-selection.ts).
 */

import type { ProviderConfig, ProviderEvent, RealtimeProvider } from "./realtime-provider.ts";

const GEMINI_MODEL = "gemini-3.5-live-translate-preview";
/** Gemini Live expects 16 kHz PCM16 input and returns 24 kHz PCM16 output. */
const INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;

/**
 * Parse the `timeLeft` from a Gemini `goAway` message into milliseconds. The wire
 * shape is unconfirmed for the translate model (the raw value is logged), so this
 * tolerates a protobuf Duration string ("10s", "10.5s"), a bare number of seconds,
 * or an expanded `{ seconds, nanos }` object. Returns null if it can't be parsed.
 */
export function parseGoAwayTimeLeftMs(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return isFinite(raw) ? Math.round(raw * 1000) : null;
  if (typeof raw === "string") {
    const m = raw.trim().match(/^([\d.]+)\s*s?$/);
    return m ? Math.round(parseFloat(m[1]) * 1000) : null;
  }
  if (typeof raw === "object") {
    const o = raw as { seconds?: number | string; nanos?: number | string };
    const secs = o.seconds != null ? Number(o.seconds) : NaN;
    if (isNaN(secs)) return null;
    return Math.round(secs * 1000 + Number(o.nanos ?? 0) / 1e6);
  }
  return null;
}

/** The subset of Gemini's serverContent the bridge reads. */
interface GeminiServerContent {
  modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
  outputTranscription?: { text?: string };
  inputTranscription?: { text?: string };
}

export class GeminiProvider implements RealtimeProvider {
  readonly name = "gemini" as const;
  readonly model = GEMINI_MODEL;
  readonly inputSampleRate = INPUT_SAMPLE_RATE;
  readonly outputSampleRate = OUTPUT_SAMPLE_RATE;

  private readonly apiKey: string;
  private readonly targetLanguage: string;
  private readonly transcribeInput: boolean;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.targetLanguage = config.targetLanguage;
    this.transcribeInput = config.transcribeInput;
  }

  socket(): { url: string } {
    return {
      url: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.apiKey}`,
    };
  }

  setupMessages(): unknown[] {
    return [
      {
        setup: {
          model: `models/${this.model}`,
          outputAudioTranscription: {},
          // Only the primary bridge transcribes the source audio (English), so the
          // English transcript is produced once regardless of how many languages run.
          ...(this.transcribeInput ? { inputAudioTranscription: {} } : {}),
          generationConfig: {
            responseModalities: ["AUDIO"],
            translationConfig: {
              targetLanguageCode: this.targetLanguage,
              echoTargetLanguage: true,
            },
          },
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
            },
          },
        },
      },
    ];
  }

  inputFrameMessage(base64Audio: string): unknown {
    return {
      realtimeInput: {
        audio: {
          mimeType: `audio/pcm;rate=${this.inputSampleRate}`,
          data: base64Audio,
        },
      },
    };
  }

  interpret(message: Record<string, unknown>): ProviderEvent[] {
    if (message.setupComplete) return [{ kind: "ready" }];

    const events: ProviderEvent[] = [];

    // goAway: the server warns before terminating, so the bridge can reconnect
    // make-before-break rather than after the fact.
    const goAway = (message.goAway ?? message.go_away) as
      | { timeLeft?: unknown; time_left?: unknown }
      | undefined;
    if (goAway) {
      const raw = goAway.timeLeft ?? goAway.time_left;
      return [{ kind: "goAway", timeLeftMs: parseGoAwayTimeLeftMs(raw), raw }];
    }

    // sessionResumptionUpdate: we don't resume yet, but record whether the translate
    // model even offers a handle — informs whether session resumption is worth adding.
    const sru = message.sessionResumptionUpdate ?? message.session_resumption_update;
    if (sru) {
      const o = sru as { resumable?: boolean; newHandle?: string; new_handle?: string };
      events.push({
        kind: "resumable",
        resumable: !!o.resumable,
        hasHandle: !!(o.newHandle ?? o.new_handle),
      });
    }

    const serverContent = (message as { serverContent?: GeminiServerContent }).serverContent;
    for (const part of serverContent?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) events.push({ kind: "audio", base64: part.inlineData.data });
    }

    // Gemini Live Translate streams a continuous flow of transcript deltas with no
    // turnComplete, so every delta is persisted as it arrives.
    if (serverContent?.outputTranscription?.text) {
      events.push({ kind: "targetTranscript", text: serverContent.outputTranscription.text });
    }
    if (this.transcribeInput && serverContent?.inputTranscription?.text) {
      events.push({ kind: "sourceTranscript", text: serverContent.inputTranscription.text });
    }

    return events;
  }
}
