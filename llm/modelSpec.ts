/**
 * Resolving a `"<provider>:<model>"` string into an AI SDK language model.
 *
 * The point of routing text/agent work through the AI SDK is that the model becomes a
 * configuration value rather than a code path: one string in an env var or a bench config
 * selects Gemini-direct, or the same Gemini through OpenRouter, or Claude, or GPT, with no
 * change to the agent loop. This module is the only place that knows about provider SDKs.
 *
 * Realtime speech translation ([live-audio/](../live-audio/)) is deliberately NOT covered —
 * it uses the Gemini Live bidirectional websocket API, which has no AI SDK equivalent and no
 * OpenRouter equivalent. See [docs/llm-providers.md](../docs/llm-providers.md).
 */
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { withTracing } from '@posthog/ai/vercel';
import type { LanguageModel } from 'ai';
import type { PostHog } from 'posthog-node';

/** Providers this app can dispatch to. `openrouter` is the multi-provider router. */
export type ProviderId = 'openrouter' | 'google';

export const PROVIDER_IDS: ProviderId[] = ['openrouter', 'google'];

/** A parsed model spec: which provider, and the model id as that provider names it. */
export interface ModelSpec {
  provider: ProviderId;
  /** Provider-native model id, e.g. `google/gemini-3-pro` (OpenRouter) or `gemini-3.5-flash`. */
  modelId: string;
  /** The original string, kept for labelling bench results and log lines. */
  spec: string;
}

/**
 * Provider used when a spec has no `provider:` prefix. Bare model ids are convenient in
 * `.env` and on the bench command line, and OpenRouter is the one provider that can name
 * models from every vendor, so it is the sane default for an unprefixed id.
 */
const DEFAULT_PROVIDER: ProviderId = 'openrouter';

/**
 * Parse `"openrouter:google/gemini-3-pro"` → `{ provider, modelId }`.
 *
 * Only the first colon separates; OpenRouter model ids contain colons of their own
 * (`anthropic/claude-sonnet-4:thinking`), and splitting on all of them would silently
 * truncate the variant suffix.
 */
export function parseModelSpec(spec: string): ModelSpec {
  const trimmed = spec.trim();
  const separator = trimmed.indexOf(':');
  if (separator === -1) {
    return { provider: DEFAULT_PROVIDER, modelId: trimmed, spec: trimmed };
  }
  const prefix = trimmed.slice(0, separator);
  if (!(PROVIDER_IDS as string[]).includes(prefix)) {
    // Not one of our prefixes — the whole string is a model id that happens to contain a
    // colon, e.g. a bare `anthropic/claude-sonnet-4:thinking`.
    return { provider: DEFAULT_PROVIDER, modelId: trimmed, spec: trimmed };
  }
  return { provider: prefix as ProviderId, modelId: trimmed.slice(separator + 1), spec: trimmed };
}

/** Env var holding the API key for each provider, in the order we look. */
const API_KEY_ENV: Record<ProviderId, string[]> = {
  openrouter: ['OPENROUTER_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
};

/** First set value among a provider's candidate env vars, or undefined. */
export function apiKeyFor(provider: ProviderId, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of API_KEY_ENV[provider]) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

/** Human-readable list of the env vars that would satisfy a provider (for error messages). */
export function apiKeyEnvNames(provider: ProviderId): string[] {
  return [...API_KEY_ENV[provider]];
}

export interface ResolveOptions {
  /** Overrides `process.env`, so the bench and tests can resolve without touching globals. */
  env?: NodeJS.ProcessEnv;
  /** When given (with `observability`), the model is wrapped with PostHog LLM tracing. */
  posthog?: PostHog;
  observability?: PostHogTags;
}

/** PostHog LLM-observability tags — the same fields `nlp.ts` passes on the Gemini path. */
export interface PostHogTags {
  distinctId?: string;
  traceId?: string;
  properties?: Record<string, unknown>;
}

/**
 * Build the language model for a spec.
 *
 * Providers are constructed per call rather than kept in a module-level registry: the bench
 * runs several specs in one process and a cached provider would pin whichever key/settings
 * the first one happened to use. Construction is cheap — it allocates a config object, not a
 * connection.
 */
export function resolveModel(spec: string | ModelSpec, options: ResolveOptions = {}): LanguageModel {
  const parsed = typeof spec === 'string' ? parseModelSpec(spec) : spec;
  const env = options.env ?? process.env;
  const apiKey = apiKeyFor(parsed.provider, env);
  if (!apiKey) {
    throw new Error(
      `No API key for provider "${parsed.provider}" (set one of: ${apiKeyEnvNames(parsed.provider).join(', ')})`,
    );
  }

  let model: LanguageModel;
  switch (parsed.provider) {
    case 'openrouter': {
      const openrouter = createOpenRouter({ apiKey });
      model = openrouter.chat(parsed.modelId, {
        // Usage accounting is what makes OpenRouter report `cost` and cached-token counts
        // per call. Without it the bench can only compare token counts, and token counts
        // across vendors with different tokenizers and prices are not comparable.
        usage: { include: true },
      });
      break;
    }
    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey });
      model = google(parsed.modelId);
      break;
    }
  }

  if (options.posthog && options.observability) {
    model = wrapWithPostHog(model, options.posthog, options.observability);
  }
  return model;
}

/** Warn at most once per process, so a bench sweep doesn't print the same line per call. */
let warnedAboutTracing = false;

/**
 * Wrap a model with PostHog LLM tracing, when the installed `@posthog/ai` supports it.
 *
 * `@posthog/ai`'s Vercel integration (through 8.6.0) is typed and version-gated for AI SDK
 * language models at spec `v2`/`v3`. AI SDK 7's providers are `v4`, so the wrapper would be
 * handed a model it does not claim to understand. Rather than cast and hope, we check the
 * spec version and pass the model through untraced when it is newer, warning once.
 *
 * The supported route for v4 is the AI SDK's own OpenTelemetry output
 * (`experimental_telemetry`) fed to `PostHogSpanProcessor` from `@posthog/ai/otel`; that
 * needs the OpenTelemetry packages added, which is a bigger decision than this module should
 * take on its own. Tracked in [docs/llm-providers.md](../docs/llm-providers.md).
 */
export function wrapWithPostHog(model: LanguageModel, posthog: PostHog, tags: PostHogTags): LanguageModel {
  if (typeof model === 'string') return model;
  const specificationVersion = (model as { specificationVersion?: string }).specificationVersion;
  if (specificationVersion !== 'v2' && specificationVersion !== 'v3') {
    if (!warnedAboutTracing) {
      warnedAboutTracing = true;
      console.warn(
        `[llm] PostHog LLM tracing skipped: @posthog/ai supports AI SDK model spec v2/v3, ` +
          `this model reports "${specificationVersion}". See docs/llm-providers.md.`,
      );
    }
    return model;
  }
  // The cast is safe behind the version check above: `withTracing` is generic over
  // `LanguageModelV2 | LanguageModelV3` and we've just established the model is one of those,
  // but TypeScript can't narrow the wider `LanguageModel` union from a runtime string compare.
  return withTracing(model as Parameters<typeof withTracing>[0], posthog, {
    posthogDistinctId: tags.distinctId,
    posthogTraceId: tags.traceId,
    posthogProperties: tags.properties,
  });
}
