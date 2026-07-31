# Provider bench

A one-off, offline comparison of how different models handle **our** LLM workloads — not a
generic leaderboard. It exists to answer one question before we commit to a provider: *which
models can actually run this app's slide-translation agent and notes pipeline, and what do
they cost?*

It is not part of the running app. Nothing here is imported by `server.ts`.

## Running it

You need an API key for whichever providers you want to compare. One OpenRouter key covers
every vendor it routes to, which is the easy way to get a wide sweep:

```bash
export OPENROUTER_API_KEY=sk-or-...     # or put it in .env
node bench/run.ts --models openrouter:google/gemini-3-pro,openrouter:anthropic/claude-sonnet-4.5,openrouter:openai/gpt-5.2
node bench/report.ts --in bench/results/<the-file-it-printed>.json
```

Then open the generated `.html` next to the results file.

Model specs are `provider:model` (see [llm/modelSpec.ts](../llm/modelSpec.ts)); `google:` goes
straight to the Gemini API with `GEMINI_API_KEY`, which is worth including so the comparison
covers *the same model direct vs routed* and not only model-against-model.

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--tasks draft,follow-up` | subset of tasks; `draft` selects every draft task |
| `--repeat 3` | run each pair N times — models are non-deterministic |
| `--concurrency 4` | runs in flight at once (default 2) |
| `--max-steps 12` | cap on agent rounds, so one confused model can't spend the budget |
| `--out path.json` | where to write results |

Running and reporting are separate programs on purpose: a run costs money and takes minutes,
so the raw results are written once and can be re-reported as often as you like. Keep the
results files — they are the evidence behind whatever we choose.

## The tasks

Each task runs the *production* code path with only the model swapped: the real tool
declarations, the real prompt builders, the real `translateItem` orchestration. Anything else
would be measuring the bench instead of the models.

| Task | What it probes |
| --- | --- |
| `draft:bench-hymn` | Line discipline on verse: a hymn's line structure is content, and must survive translation line for line. |
| `draft:bench-prose` | The opposite: a prose reading's hard wraps exist only to fit the English slide, and must **not** survive. Also tests that reviewed library entries are used as context and not re-translated. |
| `draft:bench-scripture` | Grounding. The citation is in the item *title*, never in the slide text, so getting the published wording depends on the model noticing and calling `lookup_bible_passage`. |
| `follow-up` | Blast radius. Asked to change one word, does it make a targeted `revise_translation` edit or re-send whole slides — silently reworking text the reviewer already approved? |
| `notes-block` | The hot path: one structured-output call, no tools. Return exactly the segments marked `T`, skip the `C` context segments, keep the ids. Latency matters here. |

Fixture text is public domain (pre-1900 hymnody, the KJV) or written for the fixture, so this
is all committable and re-runnable.

## What the scores do and don't tell you

[`scoring.ts`](./scoring.ts) only measures things that are facts about the output:

- **Used tool / Coverage** — did the translations reach the reviewer at all, and for every
  slide that was asked for? A model that answers in prose fails silently in production.
- **Verse lines kept / Prose reflowed** — line-break discipline, per slide, against what that
  slide is.
- **Literal `\n`** — the two characters `\n` where a newline belongs. Counted from the *raw*
  tool arguments, because `unescapeLiteralEscapes` repairs them before storage and the
  repaired text can't show the failure.
- **Bible lookups** — which references were actually fetched.
- **Slides touched** (follow-up) — should be 1.
- **Time and cost** — cost only when the provider reports it. OpenRouter does, with usage
  accounting on; direct providers show `—` rather than a number invented from a price table
  that would be stale within the month.

None of that says whether the French is any good. That is a human judgement, and it is why
the HTML report puts every model's rendering of the same slide in one row: the tables narrow
the field, then you read.

## Trusting the harness

[`pipeline.test.ts`](./pipeline.test.ts) runs the whole thing — tasks, scoring, report —
against scripted fake models, including deliberately badly-behaved ones, and asserts the
report tells them apart. A scoring bug that quietly marks a bad model good would be worse
than having no bench, and it is exactly the sort of bug that hides when the only way to run
something is to pay for it.

```bash
npm test -- bench --run
```
