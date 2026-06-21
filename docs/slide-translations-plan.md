# Slide Translation into Arbitrary Languages (with pre-translation + review)

## Context

Today, presentation slides reach viewers as whatever French/Haitian text a human
typed into **Proclaim's own translation screen** (`parse_item_translation`,
`proclaim_lib.py:296-314`). This caps us at the languages Proclaim is configured
for, offers no review/quality workflow, and the Python service only pushes the
*on-air* item with **no detection of content changing underneath us**
(`localRevision` is exposed by Proclaim but ignored — `proclaim_service.py`
re-pushes only when `itemId` changes).

We want slides translated into **arbitrary** target languages, the same way notes
are — but slides matter more: we want to prefer canonical Bible translations and
human creed/confession translations when we have them, while still using an LLM
because slides adapt those sources (responsive readings, pronoun changes). We want
to **pre-translate a whole service item and review the LLM's output by hand**
before it goes live, and to gracefully fall back when a live slide surprises us
with text we haven't reviewed.

### Decisions locked with the user
- **Persistent translation library** that outlives the per-day doc (Bible/creed
  translations and past reviews are reused every week).
- **Extend the Proclaim service** to push the full service order so items can be
  pre-translated before they are live.
- **Fallback UX:** auto-translate the surprise slide live (reuse the notes LLM
  pipeline) and show it with a small "unreviewed" badge.
- **Unit = whole slide** for caching/review, **but translate the entire item
  together** (slides are one LLM request, joined logically by the existing `--`
  delimiter convention) so the model has full-item context; then split back and
  cache per slide.

## Core design: one content-addressed translation store, two tiers

Reuse the notes insight — translations are keyed by **content, not position**
(`translationCacheKey`, `translationUtils.ts:48`). A slide changing underneath us
then becomes a clean **cache miss on a new key** instead of silent staleness.

**Value shape** (richer than the notes cache):
```
key = `${language}:${normalize(slideText)}`
value = { text, status: 'reviewed' | 'auto', provenance: 'human'|'bible'|'creed'|'llm'|'llm-agent', reviewedAt? }
```
- **Pre-translation** = populate entries and set `status:'reviewed'`. Whether a
  reviewed entry came from hand-typing, pasting a canonical text, a plain LLM call,
  or (later) an LLM agent with tools is just `provenance` — no schema change needed
  for the "by hand first, automate later" path.
- **Fallback / surprise** = no `reviewed` entry for the live slide → translate live,
  store as `status:'auto'`, display with an "unreviewed" badge; one edit promotes it
  to `reviewed`.
- **Review UI** is a *projection* over this store (item's slides × languages).
  Pre-translation and live fallback read/write the same content-addressed keys, so
  there is no positional reconciliation problem.

**Two tiers (and which one is the source of truth):**
1. **Per-day Y.Doc `slideTranslations` Y.Map** — **source of truth for the live
   service.** Viewers read only this, exactly like `proclaimPresentations`/
   `proclaimStatus`. Anyone may write it: the review screen writes `reviewed` edits
   here *immediately* (so the live viewer updates without a round-trip through any
   other store), and the Python service seeds it.
2. **Persistent library** (server-side, file-backed, survives the per-day doc):
   canonical + reviewed entries reused across all services. It is **persistence +
   cross-day cache, not the live source of truth.** Reviewed edits are written
   *back* to it for tomorrow's reuse; a fresh per-day doc is *seeded* from it.

> **Why this orientation (correction to the original plan).** The first build treated
> the library as the source of truth and the Y.Map as a projection rebuilt from it on
> item activation (revision-cached). That put the library→Y.Map sync **on the
> user-visible read path**: a review-screen Save updated only the library, the service
> never re-pushed an unchanged item, and the live viewer showed stale text (observed
> bug). Inverting it — Y.Map is truth, library is write-back persistence — moves the
> only remaining sync (Y.Map→library) **off the visible path**, so its staleness or
> failure degrades to "we re-translate next month" instead of "wrong text on screen
> now." It also makes multiple writers a non-issue: writing a shared CRDT is what Yjs
> is *for*, not a smell. Two physical stores still exist (the library provides the
> cross-day persistence the ephemeral per-day doc cannot); inversion doesn't collapse
> them, it just points truth at the store the consumer actually reads.

**Source text** for translation is the **original-language (Main screen) content**,
not Proclaim's translation screen. Proclaim's translation screen is a **single
alternate language** that all our minority-language viewers understand — we import
its existing text as seed **`French` `reviewed` entries** (provenance `human`).

### Language resolution with a fallback chain
Storage stays strictly per concrete language; fallback lives only in the **read
layer**, so it adds no schema or writer complexity. A small declarative config
(`src/strings.ts` or `configAtoms.ts`):
```
LANGUAGE_FALLBACKS = { 'Haitian Creole': ['Haitian Creole', 'French'] }  // default [self]
```
`resolveSlideTranslation(language, slideText, store)`:
1. **Quality first:** walk the chain, return the first `reviewed` entry → reviewed
   Creole wins, else reviewed French (no "unreviewed" badge — viewers understand it).
2. **Fallback:** no reviewed entry in the chain → the `auto` translation in the
   viewer's *primary* language, with the "unreviewed" badge.

This encodes "prefer a reviewed French text over an unreviewed Creole one." When the
displayed language differs from the requested one, show a small "(French)" tag.

## Reused building blocks (do not rebuild)
- `translateBlock` / `POST /api/requestTranslatedBlocks` (`nlp.ts:33`,
  `server.ts:92`): already translates a JSON array of segments with per-segment
  `status` `'T'`(translate)/`'C'`(context). **Whole-item translation = one call
  where each slide is a `'T'` segment and any already-`reviewed` slides of the item
  are passed as `'C'` context** — gives full-item context and reliable per-slide
  mapping via `segmentId`. Caches per slide on return.
- `translationCacheKey` pattern (`translationUtils.ts:48`) for library + map keys.
- Container/pure split: `BilingualBlockViewerContainer` + `BilingualBlockViewer`,
  and `CurrentSlideViewer`/`CurrentSlideViewerContainer` (`CurrentSlideViewer.tsx`)
  as the model for the live translated-slide view.
- `useMap`, `PagePart` registry (`App.tsx` ~164), `isEditorAtom`
  (`configAtoms.ts:4`), `languages` (`configAtoms.ts:6`), `LANGUAGE_BCP47`
  (`strings.ts:4`), `useStrings`.
- `parse_item_translation`, `split_into_slides`, `get_slides_for_song`
  (`proclaim_lib.py`) — extend to also extract the **original Main-screen** content
  and to enumerate the full service order.

## Implementation phases

### Phase A — Persistent library + by-hand review UI (no live changes yet)
Ships standalone value: lets you pre-translate and review immediately.
- **Server library store** (`server.ts` + new `slideLibrary.ts`): file-backed
  translation memory (JSON in a persisted dir like `audio-cache`; upgrade to SQLite
  later), keyed `${language}:${normalize(text)}`. `normalize` = NFC + trim +
  normalized newlines (keep internal line breaks for responsive readings).
  Endpoints: `POST /api/slideLibrary/lookup` (batch by language+texts),
  `POST /api/slideLibrary` (upsert reviewed entry), `GET /api/slideLibrary` (list).
- **Item translation endpoint** `POST /api/translateItem`: body
  `{ slides: string[], languages: string[] }`. Per language: look up each slide in
  the library; translate the misses via **one `translateBlock` call** (slides as
  `'T'` segments, reviewed slides as `'C'` context); return per-slide
  `{ text, status, provenance }`. Reuses `translateBlock`.
- **Review UI** — new `slideReview` component registered in `PagePart`
  (`App.tsx`). Mirrors `SourceTextTranslationManager` + `BilingualBlockViewer`:
  pick/enter an item, show its slides as rows and configured `languages` as columns,
  each cell = source + editable translation + status badge. "Suggest" button calls
  `/api/translateItem` to pre-fill; editing a cell + Save upserts a `reviewed`
  entry to the library. Editable only when `isEditorAtom`.

### Phase B — Full service order from Proclaim
- Extend `proclaim_service.py` to read `serviceItems[]` from `/presentations/onair`
  and parse **every** item (not just on-air) via `parse_item_translation`, pushing:
  - `proclaimServiceOrder` (Y.Array of itemIds), and
  - `proclaimPresentations[itemId]` extended with the **original-language source
    slides** plus a `slidesHash` for change detection.
- Add a new extractor in `proclaim_lib.py` for the **Main/original screen** content
  (today's logic prefers the translation screen). Import the existing single
  alternate-language translation-screen text as seed **`French` `reviewed`** library
  entries (Creole viewers inherit these via the fallback chain).
- **Change detection:** compute `slidesHash`; on change (same itemId, new content)
  re-push the item and invalidate. This fixes the existing "slides change underneath
  us" bug regardless of translation.

### Phase C — Live translated display + fallback
- **Writers to the per-day `slideTranslations` Y.Map** (the Y.Map is the live source
  of truth — see "Two tiers" above):
  - The **Python service** *seeds* it: after pushing an item it calls
    `/api/translateItem` and writes per-slide results (reviewed-from-library or
    `auto`). The seed is **fill/refresh-but-protect-reviewed** — it writes fresh keys
    and overwrites prior `auto` entries, but **never clobbers a `reviewed` entry**
    (`_store_translations` skips keys whose existing status is `reviewed`), so it can't
    downgrade a live human edit on a later activation.
  - The **review screen** writes `reviewed` edits directly into the map on Save
    (`SlideReviewContainer.handleSaveCell`), keyed by `slideTranslationKey(language,
    sourceText)`, *and* POSTs to `/api/slideLibrary` so the edit persists across days.
    Because keys are content-addressed, the edit lands on any on-screen slide with
    matching text — the live viewer updates with no round-trip through the service.
- **New live view** `slideTranslation-{language}` (container + pure component
  modeled on `CurrentSlideViewer`): reads `proclaimStatus` + `proclaimPresentations`
  (current slide source text) + `slideTranslations` (translation + status), resolves
  via `resolveSlideTranslation` (fallback chain), and renders the current slide's
  translation with a **subtle "unreviewed" badge** when the resolved entry is `auto`
  (plus a "(French)" tag when the displayed language differs from the requested one).
  Register in `PagePart` and the home-page layout list.

### Phase C-import — Proclaim's existing translation as a first draft
**Decision (user):** nothing that comes straight off Proclaim is human-approved — a
lot of it is itself LLM text someone pasted in. So we do **not** seed the reviewed
library and add **no new status tier**. Proclaim's existing translation is just a
*better first draft* for the `auto` entry when one exists; it is stored and displayed
exactly like any other unreviewed suggestion (`status:'auto'`, same badge) and only
becomes `reviewed` when a human Saves it in the review screen. Triggered automatically
in the service.

**Don't index-align — translate with the human text as reference.** Index-matching
Proclaim's translation-screen segments to the Main-screen slides is brittle and often
wrong. Instead the LLM takes the English source (already split into slides) plus the
**full existing translation as reference text** and returns, *per source slide*, the
corresponding portion of that translation, re-segmented to match — alignment falls out
by construction. The same call returns a **detected language** (the XML `Language`
attribute is untrustworthy), mapped to a configured language; if it matches none
(e.g. the reference is English), the reference is ignored.

- **`nlp.ts`** — add `alignReferenceTranslation(provider, {sourceSlides, referenceText})`
  → `{ language, slides: string[] }` (one JSON call: detect language + per-slide aligned
  draft).
- **`src/slideItemTranslation.ts`** — `translateItemSlides` gains an optional
  `firstDraftBySlide` (aligned reference drafts for one language): precedence per slide
  becomes **reviewed library > imported first draft (`auto`, provenance `imported`) >
  from-scratch LLM (`auto`)**. Only slides with neither reviewed nor a first draft hit
  the model. Add `'imported'` to `SlideProvenance` (display is driven by `status`, so
  this is traceability only).
- **`server.ts` `/api/translateItem`** — accept optional `reference` (the existing
  translation text). When present, call `alignReferenceTranslation`; if the detected
  language is one of the requested languages, pass its aligned slides as
  `firstDraftBySlide` for that language; other languages translate normally.
- **`proclaim_service.py`** — for the active item, build `reference` by reusing
  `parse_item_translation` (translation screen) and joining its slides, then pass it to
  `/api/translateItem`. Needs the translation-screen index via
  `get_translation_screen_idx(db.get_presentation(presentation_id)['content'])`, cached
  per presentation. No new status written — results stay `auto`.
- **(Optional) review UI** — seed drafts from the per-day `slideTranslations` `auto`
  entries (not just the reviewed library) so a human confirms the service's first
  drafts (Proclaim- or LLM-derived) into `reviewed` with one Save.

### Phase D — (future) LLM agent with tools
Tools: set reviewed translation for an item's slides; look up a Bible passage in a
target language; look up a human-translated liturgical element. They simply write
`reviewed` entries (provenance `bible`/`creed`/`llm-agent`) into the same library —
no schema change. Out of scope for the first build; the data model already supports
it.

## Working style
- Commit + push after each meaningful unit of work, even if smaller than a phase,
  so the user can test and give feedback incrementally (branch
  `claude/slide-translation-architecture-lv8x3u`).
- Stop and ask when something is genuinely ambiguous rather than guessing; expect to
  refine details during implementation.

## Files to create / modify
- `server.ts` — register library + `translateItem` endpoints.
- `src/slideLibrary.ts` (new, server) — file-backed translation memory + normalize.
- `src/SlideReview*.tsx` (new) — review UI (pure + container), Phase A.
- `src/SlideTranslationViewer*.tsx` (new) — live translated slide (pure + container),
  Phase C.
- `src/App.tsx` — register `slideReview` and `slideTranslation-{language}` in
  `PagePart` (~line 164) and the home layout list (~line 43).
- `proclaim_service.py` / `proclaim_lib.py` — full-order push, original-screen
  extraction, `slidesHash` change detection, optional seed import (Phase B/C).
- `src/strings.ts` — UI strings (e.g., "Unreviewed", "Suggest", "Reviewed").

## Verification
- **Server (Phase A):** `npm install`; unit-test `normalize` + library upsert/lookup
  and `/api/translateItem` (mock Gemini) returning per-slide reviewed/auto with
  reviewed slides used as context. `npm test -- --no-color`.
- **Review UI (Phase A):** run `npm run dev:server` + `npm run dev`, open
  `/slideReview#editor`, enter an item's slides, click Suggest, edit a cell, Save;
  confirm the library file persists across a server restart and a re-Suggest now
  returns it as `reviewed`.
- **Proclaim (Phase B):** `uv run pytest` — extend fakes to assert the full service
  order is pushed and that a `slidesHash` change triggers a re-push.
- **End-to-end (Phase C):** with the fake/real service, set a slide on-air whose
  text matches a `reviewed` entry → viewer shows it with no badge; change the slide
  text to something unreviewed → viewer shows a live `auto` translation with the
  "unreviewed" badge.
- **Phase C-import:** unit-test `translateItemSlides` with `firstDraftBySlide` (drafts
  win over the model, lose to reviewed); unit-test `alignReferenceTranslation` against a
  faked Gemini (detects language, returns per-slide aligned text). `uv run pytest` for
  the service building `reference` from the translation screen and passing it through.
  End-to-end: an item whose Proclaim translation screen has text → the live `auto`
  draft matches that wording (re-segmented), badged unreviewed; Save in the review
  screen promotes it to `reviewed`.

## Open questions / next iteration

These came out of testing the first build; not yet designed or scheduled.

### Rethink the alignment workflow → one strong-model "sort it out" call — DONE
The per-slide `alignReferenceTranslation` step (Phase C-import) didn't feel right in
practice, so it was replaced. The alignment/splitting machinery is gone; in its place a
**single `gemini-3.5-flash` call (`draftItemTranslations` in `nlp.ts`) translates the
whole item into *all* target languages at once** (env-overridable via
`GEMINI_STRONG_MODEL`; higher `maxOutputTokens`). It is given:
- the English source (as numbered slides), and
- an optional free-text **reference dump** — possibly multilingual, arbitrarily
  segmented — that the model adapts where it covers a target language and ignores
  otherwise.

Per-slide reviewed-library precedence still lives in the pure `translateItem`
(`src/slideItemTranslation.ts`); only the misses go to the model, with reviewed slides
fed as per-language context. `translateBlock` (the hot incremental notes path) is
untouched and stays on the cheap default model.

**Dump surface decision (user):** the **review page** — a free-text reference box per
item (local component state), passed to `/api/translateItem`. **Proclaim is out of the
reference loop** for now: the service still auto-translates the active item from scratch,
but no longer reads/forwards its translation-screen text. (The `proclaim_lib` helpers
`get_translation_screen_idx` / `existing_translation_text` remain for if/when Proclaim
re-enters the loop.)

Still open:
- Later: give the model **tool access** to look up Bible passages (and human-translated
  liturgical elements) in the target language — this is the natural home for the
  Phase D agent tools, folded into the first-draft call instead of a separate phase.

### Review the whole presentation, not just the active item
The review screen currently works one item at a time (paste / "load on-air"). The
intended workflow was **whole-service review**: 
- show the **full service order**, let the operator **pick which item to expand**, and
- **summarize each item by review coverage** (e.g. reviewed vs. unreviewed slide counts
  per language) so it's obvious what still needs attention before a service.

The data already exists: `proclaimServiceOrder` + per-item slides are pushed, and
coverage is a library/`slideTranslations` lookup per slide.

## Status
Phases A, B, C, and C-import are all implemented and pushed on
`claude/slide-translation-architecture-lv8x3u`. (Phase B note: the live writer
translates the active item lazily rather than pre-translating the whole order;
`proclaimServiceOrder` is a plain list value, not a `Y.Array`, since the service
is the sole *seeding* writer.)

**Alignment rethink (post-build).** The brittle per-slide `alignReferenceTranslation` +
`firstDraftBySlide` path was removed in favor of one strong-model call that drafts the
whole item into all languages at once, with an optional multilingual reference dump from
a review-page box. See the (now resolved) "Rethink the alignment workflow" note above.

**Source-of-truth inversion (post-build fix).** The live viewer initially showed stale
text after a review-screen edit because the library was treated as truth and the Y.Map
as a rebuilt projection. Fixed by making the **Y.Map the live source of truth**: the
review screen writes `reviewed` edits straight into `slideTranslations` (and still
POSTs to the library for persistence), and the Python service's seed now
**protects existing `reviewed` entries** rather than overwriting them. See "Two tiers"
and Phase C above.
