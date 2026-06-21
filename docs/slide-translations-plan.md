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
- **Review UI** is a *projection* over this store (item's slides × languages), not a
  separate source of truth — pre-translation and live fallback read/write the same
  store, so there is no reconciliation problem.

**Two tiers:**
1. **Persistent library** (server-side, survives the per-day doc): canonical +
   reviewed entries, reused across all services. Source of truth for `reviewed`.
2. **Per-day Y.Doc `slideTranslations` Y.Map**: live working copy for the current
   service (reviewed entries pulled from the library + `auto` fallbacks). Viewers
   read only this, exactly like they read `proclaimPresentations`/`proclaimStatus`
   today.

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
- **Single writer** populates the per-day `slideTranslations` Y.Map: the Python
  service, after pushing an item, calls `/api/translateItem` and writes per-slide
  results (reviewed-from-library or `auto`). This keeps web clients pure readers,
  consistent with current Proclaim data flow. (Interim option if Python wiring is
  deferred: the live container calls `/api/translateItem` and writes the map —
  writes are idempotent.)
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

## Status
Phases A, B, C, and C-import are all implemented and pushed on
`claude/slide-translation-architecture-lv8x3u`. (Phase B note: the live writer
translates the active item lazily rather than pre-translating the whole order;
`proclaimServiceOrder` is a plain list value, not a `Y.Array`, since the service
is the sole writer.)
