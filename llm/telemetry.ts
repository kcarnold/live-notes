/**
 * LLM tracing, as OpenTelemetry.
 *
 * AI SDK 7 emits OpenTelemetry spans for every `generateText` call once a telemetry
 * integration is registered — it is opt-*out*, not opt-in. So instrumentation is a one-line
 * startup concern and, importantly, contains nothing vendor-specific: no PostHog types touch
 * the call sites, and changing where traces go is a change to this file alone.
 *
 * That matters because the alternative — `@posthog/ai`'s `withTracing` wrapper — is
 * version-gated on the AI SDK's language-model spec (v2/v3 as of @posthog/ai 8.6.0, while AI
 * SDK 7's providers are v4). Wrapping every model would have coupled our ability to upgrade
 * the AI SDK to PostHog's release cadence, for no benefit: PostHog's own supported path for
 * current AI SDK versions is this one.
 *
 * PostHog stays the destination. `PostHogSpanProcessor` is an ordinary OTel `SpanProcessor`
 * that batches to PostHog's OTLP endpoint, where AI spans become `$ai_generation` events —
 * landing in the same project as `bible_lookup`, the live-audio lifecycle events, and server
 * exceptions, which is the whole reason to keep it (see
 * [docs/OBSERVABILITY.md](../docs/OBSERVABILITY.md)).
 *
 * ## The open question: conversation and person grouping
 *
 * On the Gemini path, `@posthog/ai` takes `posthogTraceId` (the conversation id) and
 * `posthogDistinctId` (the day's docId) as first-class arguments, and every generation from a
 * conversation groups under one trace and one "person".
 *
 * This path has no such argument. Custom values reach spans through `runtimeContext`, and
 * `@ai-sdk/otel` writes them **namespaced**, as `ai.settings.context.<key>` — so we cannot
 * emit a bare `$ai_trace_id` attribute even if we wanted to. Whether PostHog's OTLP ingestion
 * reads those namespaced attributes back into a trace id and a distinct id is server-side
 * behaviour that cannot be determined from the client package.
 *
 * This is consequential, not cosmetic: a conversation spans several `generateText` calls
 * (the initial draft, then each reviewer follow-up, sometimes days apart), and each of those
 * is a **separate OTel trace**. OTel's own trace id therefore does *not* group a conversation
 * — only an attribute can. If PostHog ignores these attributes, we get per-call generations
 * with no conversation thread and no per-service person, which is a real regression from what
 * the Gemini path does today.
 *
 * So: unproven until measured. `docs/llm-providers.md` has the exact procedure, and
 * `TRACE_ATTRIBUTE_KEYS` below is the single place to change if the test says PostHog wants
 * different names.
 */
import { registerTelemetry } from 'ai';
import { OpenTelemetry } from '@ai-sdk/otel';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ConsoleSpanExporter, SimpleSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { PostHogSpanProcessor } from '@posthog/ai/otel';

/**
 * The `runtimeContext` keys carrying our grouping ids.
 *
 * They arrive at the backend prefixed — `ai.settings.context.$ai_trace_id` and so on. Both
 * the PostHog-conventional spelling and the OpenTelemetry-conventional one are sent for each
 * id: they cost a few bytes, we do not yet know which (if either) PostHog honours, and a
 * future non-PostHog backend finds the standard names it expects. Narrow this once the
 * procedure in docs/llm-providers.md has established what actually works.
 */
export const TRACE_ATTRIBUTE_KEYS = {
  /** PostHog's own conventional name for the conversation/trace id. */
  posthogTraceId: '$ai_trace_id',
  /** PostHog's own conventional name for the person id. */
  posthogDistinctId: 'distinct_id',
  /** OpenTelemetry semantic-convention equivalents. */
  otelSessionId: 'session.id',
  otelUserId: 'user.id',
} as const;

/**
 * Grouping facts for one conversation — the same three the Gemini path passes to
 * `@posthog/ai` (`AgentObservability` in nlp.ts).
 */
export interface TraceAttributes {
  /** Stable id for whoever is driving the conversation — we use the day's docId. */
  distinctId?: string;
  /** Groups every generation of one conversation (the conversation id). */
  traceId?: string;
  properties?: Record<string, unknown>;
}

/** What to spread into a `generateText` call to tag it. */
export interface TelemetryCallOptions {
  runtimeContext: Record<string, string>;
  telemetry: { functionId: string; includeRuntimeContext: Record<string, true> };
}

/**
 * Build the `runtimeContext` + `telemetry` options that tag one AI SDK call.
 *
 * `includeRuntimeContext` is required and explicit: the AI SDK excludes runtime context from
 * telemetry unless each key is opted in, precisely so that credentials and user identifiers
 * living in the same object do not leak to a telemetry vendor by default. Everything we put
 * in here is intended for the vendor, so every key is opted in — but the mechanism is worth
 * respecting if anything sensitive is ever added to this object.
 */
export function telemetryFor(functionId: string, attributes: TraceAttributes): TelemetryCallOptions {
  const runtimeContext: Record<string, string> = {};

  if (attributes.traceId) {
    runtimeContext[TRACE_ATTRIBUTE_KEYS.posthogTraceId] = attributes.traceId;
    runtimeContext[TRACE_ATTRIBUTE_KEYS.otelSessionId] = attributes.traceId;
  }
  if (attributes.distinctId) {
    runtimeContext[TRACE_ATTRIBUTE_KEYS.posthogDistinctId] = attributes.distinctId;
    runtimeContext[TRACE_ATTRIBUTE_KEYS.otelUserId] = attributes.distinctId;
  }
  for (const [key, value] of Object.entries(attributes.properties ?? {})) {
    if (value != null) runtimeContext[key] = String(value);
  }

  const includeRuntimeContext = Object.fromEntries(
    Object.keys(runtimeContext).map((key) => [key, true as const]),
  );

  return { runtimeContext, telemetry: { functionId, includeRuntimeContext } };
}

let registered = false;

export interface RegisterTelemetryOptions {
  /** PostHog project token (`phc_…`). Without one, nothing is registered. */
  projectToken?: string;
  /** PostHog host; defaults to PostHog's US cloud. */
  host?: string;
  /** Service name on the tracer. */
  serviceName?: string;
  /**
   * Also print every span to stdout.
   *
   * This is what separates "we never sent the attribute" from "PostHog dropped it" when the
   * grouping check in docs/llm-providers.md fails — without it, a missing distinct id in
   * PostHog is unattributable and the investigation stalls.
   */
  debug?: boolean;
}

/**
 * Register LLM tracing once per process. Safe to call repeatedly; only the first call acts.
 *
 * Returns whether tracing is actually on, so a caller can say so rather than leaving someone
 * to wonder why their PostHog project is empty. With no project token this is a no-op — the
 * right behaviour for tests, and for a bench run where nobody wants the noise.
 */
export function registerLlmTelemetry(options: RegisterTelemetryOptions = {}): boolean {
  if (registered) return true;

  const projectToken = options.projectToken ?? process.env.VITE_PUBLIC_POSTHOG_KEY;
  if (!projectToken) return false;

  const spanProcessors: SpanProcessor[] = [
    new PostHogSpanProcessor({
      projectToken,
      host: options.host ?? process.env.VITE_PUBLIC_POSTHOG_HOST,
    }),
  ];
  if (options.debug) spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));

  const provider = new NodeTracerProvider({ spanProcessors });
  provider.register();
  registerTelemetry(new OpenTelemetry({ tracer: provider.getTracer(options.serviceName ?? 'live-notes-llm') }));

  registered = true;
  return true;
}
