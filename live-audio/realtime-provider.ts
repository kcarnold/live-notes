/**
 * The seam between the translation bridge and whichever realtime speech-translation
 * API is behind it.
 *
 * `TranslationBridge` is almost entirely *not* about any particular vendor: it is about
 * keeping organizer audio flowing through a websocket that periodically dies, into a
 * LiveKit room that periodically rebuilds itself, without ever going "active but deaf"
 * (see docs/live-audio-resilience.md). Only six things are actually vendor-specific:
 *
 *   1. where to connect and how to authenticate,
 *   2. what to send to configure the session,
 *   3. how to read an inbound message,
 *   4. how to wrap one PCM16 input frame,
 *   5. the input/output sample rates,
 *   6. whether it can produce the target language at all.
 *
 * Those are this interface. Everything else — reconnects, the gap buffer, the epoch
 * guard, silence gating, subscription reconcile, the stall watchdog — is written once
 * and shared, so a second provider inherits the whole incident history rather than
 * re-earning it.
 *
 * A provider is constructed per bridge (it knows its target language), is stateless
 * with respect to the socket, and never touches the socket itself: it returns messages
 * for the bridge to send and interprets messages the bridge received. That keeps it
 * trivially unit-testable — see realtime-provider.test.ts, which is the whole test
 * story for "do we speak this vendor's protocol correctly".
 */

import type WebSocket from "ws";

/** Which realtime backend a bridge is running against. */
export type ProviderName = "gemini" | "openai";

/**
 * What the bridge does with an inbound message, once the provider has read it. This
 * is deliberately the *bridge's* vocabulary, not any vendor's — it is the list of
 * things the bridge knows how to react to, and a provider that has no equivalent for
 * one simply never emits it.
 */
export type ProviderEvent =
  /** Session configured and ready for audio. Promotes the socket to active. */
  | { kind: "ready" }
  /** A chunk of translated output audio, base64 PCM16 at `outputSampleRate`. */
  | { kind: "audio"; base64: string }
  /** Translated (target-language) transcript text. */
  | { kind: "targetTranscript"; text: string }
  /** Source-language (input) transcript text; only if `transcribeInput` was asked for. */
  | { kind: "sourceTranscript"; text: string }
  /**
   * The server warned it is about to terminate this session. The bridge reconnects
   * make-before-break. `timeLeftMs` is informational (null when unknown).
   */
  | { kind: "goAway"; timeLeftMs: number | null; raw: unknown }
  /** Session-resumption metadata. Recorded only; the bridge does not resume yet. */
  | { kind: "resumable"; resumable: boolean; hasHandle: boolean }
  /**
   * The server reported an error on this session. `fatal` means the session is done
   * and the bridge should stop trusting the socket; a non-fatal error is recorded and
   * otherwise ignored (the socket keeps working).
   */
  | { kind: "error"; message: string; code: string | null; fatal: boolean };

/** Everything a provider needs to know at construction time. */
export interface ProviderConfig {
  apiKey: string;
  /** BCP-47 code of the language this bridge translates *into*. */
  targetLanguage: string;
  /** Whether this bridge also needs the source-language transcript. */
  transcribeInput: boolean;
}

export interface RealtimeProvider {
  readonly name: ProviderName;
  /** The model id in use, for logs and telemetry. */
  readonly model: string;
  /** Sample rate the provider wants input frames in (LiveKit resamples for us). */
  readonly inputSampleRate: number;
  /** Sample rate the provider's output audio arrives in. */
  readonly outputSampleRate: number;
  /** Where to connect, plus any per-request options (e.g. auth headers). */
  socket(): { url: string; options?: WebSocket.ClientOptions };
  /**
   * Messages to send, in order, as soon as the socket opens. The bridge waits for a
   * `ready` event before it will send any audio.
   */
  setupMessages(): unknown[];
  /**
   * Read one parsed inbound message. Returning an empty array means "nothing the
   * bridge acts on" — normal for the majority of a chatty protocol's traffic.
   */
  interpret(message: Record<string, unknown>): ProviderEvent[];
  /** Wire message carrying one base64-encoded PCM16 input frame. */
  inputFrameMessage(base64Audio: string): unknown;
}

/**
 * A human-readable name for a BCP-47 code, for prompts and logs. Uses `Intl` rather
 * than a hand-kept table so we don't maintain a second language list (the same choice
 * the listen picker makes), and falls back to the raw code if the runtime's ICU data
 * doesn't know it.
 */
export function languageDisplayName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
