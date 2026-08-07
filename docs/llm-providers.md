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
[Migration](#migration) for why that order, and the one thing that needs measuring first
([does conversation and person grouping survive?](#open-question-does-conversation-and-person-grouping-survive)).

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

### Tracing: OpenTelemetry, with PostHog as the exporter

Not a blocker, and not a PostHog-vs-OTel choice — PostHog's own supported path for current AI
SDK versions *is* OpenTelemetry. `PostHogSpanProcessor` (`@posthog/ai/otel`) is an ordinary
OTel `SpanProcessor` that batches to PostHog's OTLP endpoint, where AI spans become
`$ai_generation` events.

So we instrument vendor-neutrally. AI SDK 7 emits spans for every call once an integration is
registered (opt-*out*, not opt-in), which makes this a startup concern:

```ts
registerLlmTelemetry();   // llm/telemetry.ts — the only file that names PostHog
```

No PostHog types touch any call site. Changing where traces go is a change to that one file.

The alternative — `@posthog/ai`'s `withTracing` wrapper — is version-gated on the AI SDK's
language-model spec (v2/v3 as of @posthog/ai 8.6.0; AI SDK 7's providers are v4). Wrapping
every model would have tied our ability to upgrade the AI SDK to PostHog's release cadence for
no benefit, so that wrapper is not used.

**PostHog stays the destination**, and the reasons are about co-location rather than
instrumentation: `$ai_generation` events land in the same project as `bible_lookup` (tagged
with the same conversation id in `server.ts`), the live-audio lifecycle events that all of
[OBSERVABILITY.md](OBSERVABILITY.md) is built on, server exceptions, frontend analytics, and
Proclaim service errors. PostHog also computes cost from model + tokens server-side, and needs
no collector or tracing backend to run — which matters for something deployed with
`docker compose` onto one box.

#### Open question: does conversation and person grouping survive?

**This is unproven and needs the check below before the slide agent moves.**

On the Gemini path, `@posthog/ai` takes `posthogTraceId` (the conversation id) and
`posthogDistinctId` (the day's docId) as first-class arguments. Every generation from one
conversation groups into one trace, under one "person".

The OTel path has no such argument. Custom values reach spans via `runtimeContext`, and
`@ai-sdk/otel` writes them **namespaced** — `ai.settings.context.<key>`, e.g.
`ai.settings.context.$ai_trace_id`. We cannot emit a bare `$ai_trace_id` attribute even if we
wanted to. Whether PostHog's ingestion reads those namespaced attributes back into a trace id
and a distinct id is server-side behaviour, not determinable from the client package.

It matters because a conversation spans several `generateText` calls — the initial draft, then
each reviewer follow-up, sometimes days apart — and **each is a separate OTel trace**. OTel's
own trace id does not group a conversation; only an attribute can. If PostHog ignores these,
we get orphaned per-call generations with no conversation thread and no per-service person.
That is a real regression from today, not a cosmetic one.

`llm/telemetry.ts` currently sends both spellings of each id (`$ai_trace_id` + `session.id`,
`distinct_id` + `user.id`) so the test has the best chance of passing on one of them.
`TRACE_ATTRIBUTE_KEYS` is the single place to change afterwards.

#### The check — exact steps

Roughly ten minutes and a few cents. Do it against a **throwaway or dev PostHog project** if
you have one; the events are tagged distinctly enough to be harmless in production, but a
scratch project makes the "did anything arrive at all" question unambiguous.

**1. Set up.** In `.env`:

```bash
VITE_PUBLIC_POSTHOG_KEY=phc_...          # the project you'll inspect
VITE_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
OPENROUTER_API_KEY=sk-or-...             # or GEMINI_API_KEY for google:
```

**2. Emit a known conversation.** One model, one cheap task, one label you can search for:

```bash
LABEL="tracecheck-$(date +%s)"
echo "$LABEL"
node bench/run.ts   --models openrouter:google/gemini-3-flash   --tasks notes-block,follow-up   --telemetry --trace-label "$LABEL"
```

Two tasks, deliberately: `notes-block` is a single call and `follow-up` is a multi-step agent
run, so you can tell "several spans in one trace" apart from "several traces that should be
one conversation". The run prints the label again at the end and waits 5s for the exporter to
flush.

The ids emitted are:
- distinct id — `<LABEL>` (one per sweep; stands in for the day's docId)
- trace id — `<LABEL>:<model>:<task>` (one per task; stands in for the conversation id)

**3. Confirm we sent what we think we sent.** Re-run with `--telemetry-debug` and read the
spans on stdout:

```bash
node bench/run.ts --models openrouter:google/gemini-3-flash --tasks notes-block   --telemetry --telemetry-debug --trace-label "$LABEL-debug" 2>&1 | grep -A2 'ai.settings.context'
```

Expect `ai.settings.context.$ai_trace_id`, `ai.settings.context.distinct_id`,
`ai.settings.context.session.id`, `ai.settings.context.user.id` on the `ai.generateText` spans.
If they are absent, the problem is ours (`telemetryFor` / `includeRuntimeContext`), not
PostHog's — stop here and fix that first.

**4. Did anything arrive?** PostHog → **Activity** (or Data management → Events). Filter
`Event = $ai_generation`, last 1 hour.

- ✅ Events appear → ingestion works.
- ❌ Nothing after ~2 minutes → check the project token is for the project you're looking at,
  and that `VITE_PUBLIC_POSTHOG_HOST` matches the region (`us.` vs `eu.`). PostHog's OTLP
  endpoint silently drops spans that are not `gen_ai.*` / `ai.*` / `llm.*`; step 3 having
  passed rules that out.

**5. Person grouping — the actual question.** Open one of those events and read its
**distinct ID** column, then go to PostHog → **People** and search `<LABEL>`.

- ✅ **Pass** — a person exists whose distinct id is exactly `<LABEL>`, and all the sweep's
  generations sit under it. Grouping survives; use whichever key worked and drop the other
  from `TRACE_ATTRIBUTE_KEYS`.
- ❌ **Fail** — the events carry a random/anonymous distinct id and no such person exists.
  Then person-level grouping does not survive the OTel path. Before accepting that, open one
  event's properties and look for the attributes from step 3: if `distinct_id` or `user.id`
  is present *as a property* but not used as the distinct id, it is a mapping question, and
  worth one support question to PostHog before designing around it.

**6. Conversation grouping.** Filter `$ai_generation` where `$ai_trace_id = <LABEL>:<model>:follow-up`.

- ✅ **Pass** — every generation from the follow-up run comes back under that one trace id, and
  PostHog's **LLM analytics → Traces** view shows them as one conversation.
- ❌ **Fail** — each call sits in its own trace keyed by an OTel trace id. Check whether
  `ai.settings.context.$ai_trace_id` survived as a plain event property; if it did, the review
  workflow is still recoverable with a PostHog insight grouped on that property, just not with
  the built-in trace view.

**7. Record the answer.** Write the outcome into this section and narrow
`TRACE_ATTRIBUTE_KEYS` to what actually worked. If both 5 and 6 fail, the fallback is a small
custom `Telemetry` integration (AI SDK supports `telemetry.integrations`) that calls
`phClient.capture()` with `$ai_trace_id`/`distinctId` directly — the same shape the Gemini path
produces today, without the version-gated wrapper.

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
   env var, calling `registerLlmTelemetry()` at startup. Lowest risk: one call, no stored
   conversation, no tools, and a bad result is one stale line in the viewer.
4. **Run the grouping check above** and record the answer. Tracing itself already works via
   OTel; what is unproven is per-conversation and per-person grouping, and that is what the
   review workflow depends on.
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
