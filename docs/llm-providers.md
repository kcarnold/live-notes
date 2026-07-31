# Which LLM provider for the text and agent work

## The short version

**OpenRouter and the AI SDK are not alternatives to each other.** OpenRouter is a routing
*API* — one key, one endpoint, ~300 models from every vendor, with cost accounting and
fallbacks. The AI SDK (`ai`) is a client *library* that abstracts over provider SDKs,
including OpenRouter's. Picking one does not settle the other.

The recommendation is **both**: the AI SDK as the interface, OpenRouter as the default route,
direct providers kept available for the two places where routing measurably loses something.
That is what this branch implements, alongside a bench to check the "measurably" part rather
than assert it.

Nothing in the running app has been switched over yet. The provider layer, the ported agent,
and the bench all exist; `server.ts` still calls the Gemini path in `nlp.ts`. See
[Migration](#migration) for why that order, and the one blocker.

## What we actually need it to do

Four workloads, and they want different things:

| Workload | Where | Shape | What matters |
| --- | --- | --- | --- |
| Notes translation | `translateBlock`, `/api/requestTranslatedBlocks` | one call, strict JSON out | latency (someone is watching the screen), price per call, id fidelity |
| Whole-item slide draft | `draftItemTranslations`, `/api/translateItem` | agent loop, 3 tools, 2–4 languages at once | tool-calling reliability, translation quality, Scripture grounding |
| Reviewer follow-up | `runSlideTranslationAgent`, `/api/slideConversation/message` | resumed conversation, long re-sent prefix | *targeted* edits, prompt caching (we re-send the whole history every round) |
| Live speech translation | [live-audio/](../live-audio/) | bidirectional audio streaming | **not portable — see below** |

Two constraints cut across all of them, and both come from decisions already made:

- **The conversation is stored, not just used.** Slide-translation conversations live in the
  per-day Y-Sweet doc as raw Gemini `Content[]` (`slideConversationStore.ts`) and are rendered
  part-by-part by the review screen (`SlideConversationPanel.tsx`, which reads
  `part.functionCall` / `part.functionResponse` directly). Conversations from past services
  are already sitting in those docs. A provider swap must not be a storage format change.
- **Generations are traced.** Every model call goes through `@posthog/ai`, tagged with the
  conversation id as `traceId`, so a day's review work groups into one trace in PostHog. That
  is how the agent gets debugged. Losing it is not a cosmetic regression.

### Live speech translation stays where it is

`live-audio/` uses the Gemini Live bidirectional websocket API: mic audio in, translated audio
and transcripts out, continuously. Neither the AI SDK's text/streaming surface nor OpenRouter
has an equivalent — this is a different API family, not a different model. It stays on
`@google/genai` regardless of what happens to the text paths, and none of the work here
touches it.

## The options

### 1. Stay on `@google/genai` direct (status quo)

Works today, tightly integrated: implicit context caching without asking, thought signatures
replayed faithfully on resume, `@posthog/ai/gemini` tracing that already works.

The cost is that "which model" is not a question we can answer, only assert. There is no way
to try Claude on the slide agent, or to fall back when Gemini has a bad afternoon, without
writing a second client. And Gemini's schema dialect leaks into our tool definitions.

### 2. Raw OpenRouter over HTTP (or the OpenAI SDK pointed at it)

One key, every model, cost accounting, fallbacks. But we would hand-roll the agent loop, the
tool-call plumbing, and the structured-output parsing — all of which exist and work — and we
would tie the message format to OpenAI's chat-completions shape, which is no more neutral
than Gemini's, just differently non-neutral. And `@posthog/ai` has no integration for it
beyond pretending to be OpenAI.

### 3. AI SDK with direct providers

Provider-neutral message and tool types, a loop we don't maintain (`stopWhen`, automatic tool
execution), `Output.object` for structured output, and one usage shape across vendors
including `cacheReadTokens`. Costs one dependency per vendor and one key per vendor, and gives
no cross-vendor price comparison.

### 4. AI SDK with OpenRouter — **recommended**

Everything in (3), plus: one key covers every vendor; `usage.cost` in USD makes models
*actually* comparable (token counts across different tokenizers and price sheets are not);
`models: [...]` gives an automatic fallback list; provider routing can pin, exclude, or sort
upstream providers by price/latency/throughput.

And because the AI SDK is the interface rather than OpenRouter itself, dropping to a direct
provider is a change to one string — which matters for the two things below.

## What routing costs us, concretely

These are the findings from actually building it, not predictions.

### Prompt caching on resumed conversations

Follow-up rounds re-send the whole conversation. On the Gemini API that prefix is served by
implicit context caching with no work from us; `cachedContentTokenCount` is already surfaced
in the review UI for exactly this reason. Through OpenRouter, caching is whatever the upstream
provider does — Anthropic, for instance, needs explicit `cache_control` breakpoints, which the
OpenRouter provider supports but which nobody sets by default.

So a routed follow-up may quietly cost several times what a direct one does. This is a real
line item, not a footnote, and it is measurable: the bench reports `cacheReadTokens` per model
per task. **Check that column before switching the follow-up path.**

### Reasoning continuity across a resume

Gemini "thought" parts carry opaque signatures that let a resumed conversation replay the
model's reasoning. They are meaningless to any other provider, so
[`llm/messages.ts`](../llm/messages.ts) drops them when converting. A conversation resumed
through the neutral layer therefore starts its reasoning fresh each round. The review screen
already hides thought parts, so nothing visible changes — but it is a real difference in what
the model has to work with, and the honest place to record it is here rather than in a
comment nobody reads.

### PostHog tracing — the one actual blocker

`@posthog/ai`'s Vercel integration (`withTracing`, up to and including 8.6.0 as of this
writing) accepts AI SDK language models at spec version **v2 or v3**. AI SDK 7's providers —
OpenRouter's and Google's alike — are **v4**. So `withTracing` cannot be used as-is:

```
$ node -e "..."   # @posthog/ai 8.6.0
declare const wrapVercelLanguageModel: <T extends LanguageModelV2 | LanguageModelV3>(...)
```

[`llm/modelSpec.ts`](../llm/modelSpec.ts) checks `specificationVersion` and passes the model
through untraced with a one-time warning rather than casting and hoping — a wrapper handed a
model shape it doesn't claim to understand produces *wrong* telemetry, which is worse than
none.

The supported route for v4 is the AI SDK's own OpenTelemetry output
(`experimental_telemetry`) fed to `PostHogSpanProcessor` from `@posthog/ai/otel`, which
converts `gen_ai.*` spans into `$ai_generation` events server-side. That needs the
OpenTelemetry packages added and the trace/distinct-id tagging re-expressed as span
attributes. It is a contained piece of work, but it is work, and it is a prerequisite for
moving the slide agent — that agent is debugged through its traces.

The notes path has no such dependency and can move first.

## Recommendation

1. **Interface: the AI SDK.** Its message and tool types are the closest thing to neutral on
   offer, the loop and structured-output plumbing are maintained by someone else, and it makes
   the provider a config value instead of a code path.
2. **Default route: OpenRouter.** One key, comparable costs, fallbacks, and the freedom to
   change our mind about a model without changing code.
3. **Keep direct Gemini available** for anything where the bench shows routing losing on
   caching, and permanently for live audio.
4. **Decide the models from the bench, not from vibes.** That is what it is for.

## Migration

Staged, so nothing rides on an unverified assumption:

1. ~~Provider layer, ported agent, bench~~ — done on this branch, behind no feature flag
   because nothing calls it yet. 75 new tests, all offline.
2. **Run the bench** with a real key and read the report. Pick a model for the notes path and
   a model for the slide agent; they need not be the same one, and the cheap/fast tradeoff is
   genuinely different.
3. **Move the notes path** (`/api/requestTranslatedBlocks`) to `llm/notesBlock.ts` behind an
   env var. Lowest risk: one call, no stored conversation, no tools, and a bad result is one
   stale line in the viewer.
4. **Resolve PostHog tracing** for AI SDK v4 via the OTel path.
5. **Move the slide agent**, keeping `Content[]` as the stored format via
   [`llm/messages.ts`](../llm/messages.ts) so old conversations and the review screen are
   untouched. Watch the cached-token figures in the review UI for a service or two.
6. Retire whichever of the two `nlp.ts` paths ends up unused.

## Running the comparison

See [bench/README.md](../bench/README.md).

```bash
export OPENROUTER_API_KEY=sk-or-...
node bench/run.ts --models openrouter:google/gemini-3-pro,openrouter:anthropic/claude-sonnet-4.5,google:gemini-3.5-flash
node bench/report.ts --in bench/results/<file>.json
```

The tables are mechanical checks — did it use the tools, cover every slide, keep verse lines,
reflow prose, write literal `\n`, look up the psalm, touch only one slide on a follow-up. They
narrow the field. The HTML report then puts every model's translation of the same slide in one
row, because whether the French reads well in a Haitian Creole congregation is not something a
score can tell you.
