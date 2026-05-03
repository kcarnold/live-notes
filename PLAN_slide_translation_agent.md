# Plan: In-App Slide Translation Agent

Replace the current workflow (storing translations in Proclaim) with an in-app
conversational agent that translates presentation slides. Each phase is a
mergeable, demoable increment. See `docs/agent-research.md` for technical
findings and implementation reference.

## Current State (main)

- `proclaim_lib.py`: `parse_item_translation()` extracts **translation-screen**
  content into `ServiceItemWithSlides.slides`
- `proclaim_service.py`: writes `{title, itemId, slides}` to Yjs
  `proclaimPresentations` map — where `slides` = translation-screen text
- `CurrentSlideViewer.tsx`: reads `{title, slides}` from Yjs and displays them
- No test infrastructure for Proclaim parsing
- No agent, no chat endpoint, no chat UI

## Design Decisions

### Naming: non-breaking field additions

Existing `slides` field = translation-screen content. To avoid breaking
`CurrentSlideViewer`, we **add new fields** rather than rename:

| Field              | Meaning                                      | Written by  |
|--------------------|----------------------------------------------|-------------|
| `slides`           | (legacy) translation-screen content          | Proclaim svc|
| `sourceSlides`     | Main-screen untranslated content             | Proclaim svc|
| `storedTranslation`| Existing Proclaim translation (draft quality)| Proclaim svc|
| `itemKind`         | Item type (SongLyrics, Content, etc.)        | Proclaim svc|

Agent-produced translations live in a **separate** Yjs Y.Map
(`slideTranslations`) keyed by `{itemId}:{language}`. This keeps Proclaim
data and agent output cleanly separated.

Later, once the agent is working, we can deprecate `slides` in favor of
`sourceSlides` + agent translations.

### Architecture: client-side agent, stateless server

- Client owns conversation history and executes tools (reads/writes Yjs)
- Server only proxies LLM API calls (`POST /api/chat`)
- Gemini function calling for structured tool use
- Agent translates directly in its response text — no separate translate tool

### Translation approach

- Songs with existing Proclaim translations: use `storedTranslation` as draft,
  agent can revise
- Bible passages, creeds: agent asks user to paste authoritative text via
  normal chat (no special tools)
- Other content: agent AI-translates directly
- The translation screen interleaves French and Haitian Creole — a single
  `storedTranslation` field holds whatever's on that screen

---

## Phase 1: Capture & Test Infrastructure ✅ DONE

**Goal**: Record real Proclaim data for offline testing. Purely additive — no
behavior changes, no existing code modified.

**New files**:
- `proclaim_capture.py` — snapshot capture tool (reads API + DB, writes JSON)
- `tests/conftest.py` — `MockProclaimDB`, `snapshot` parametrized fixture
- `tests/proclaim_snapshots/2026-01-05_synthetic.json` — synthetic fixture
- `tests/test_proclaim_pipeline.py` — integration tests
- `pyproject.toml` changes: add `[tool.pytest.ini_options]` with `testpaths`
  and `pythonpath`

**What the synthetic fixture covers**: SongLyrics (custom order + translation
screen), Content (`--` delimiter + translation), BiblePassage (no translation),
ImageSlideshow (blank), Blank content item.

**What the tests verify**:
- All items parse without error
- Blank items produce `slides=['']`
- Non-blank items have at least one non-empty slide
- Yjs dict has correct required/optional keys and types
- Translation screen detection (positive and negative)
- Song parsing: title as first slide, custom order, English/French content
- Content parsing: delimiter splitting, translation pairing

**Demo**: `uv run pytest tests/ -v` all green.

**Before moving on, decide**:
- Does the synthetic fixture cover the real-world cases you see?
- Want to capture a real session snapshot?

---

## Phase 2: Extract Source Slides ✅ DONE (2026-05-02)

**Goal**: Parse **both** main-screen and translation-screen content from
Proclaim, sync both to Yjs. Existing viewer unaffected.

**What was built**:
- `ServiceItemWithSlides` gains `sourceSlides` and `storedTranslation`
- `_parse_screen(content, item_kind, screen_idx)` shared helper — None = main
  content, int = translation screen; `parse_item_translation` now calls it twice
- `item_to_yjs_dict(item)` pure function used by service and tests
- `parse_item_translation` signature: `translation_screen_idx: Optional[int]`
- `_handle_item_change` no longer bails when translation screen is absent
- `slides` field kept as `storedTranslation ?? sourceSlides` for backward compat
  (documented in `ServiceItemWithSlides` and `item_to_yjs_dict`)
- Fixed pre-existing bug: `update_expected.py` was globbing `.expected.json` as snapshots

**Decisions made**:
- `storedTranslation` is one field — it's whatever is on the translation screen
  (can be French, Haitian, or mixed depending on the item/service). The agent
  will treat it as a draft regardless.
- `slides` backward-compat field is documented as legacy; deprecate once Phase 4
  updates `CurrentSlideViewer`.

---

## Phase 3: Service Order in Yjs

**Goal**: Sync the full ordered list of service items to Yjs so the agent can
enumerate what needs translating.

**`proclaim_service.py` changes**:
- New `proclaimServiceOrder` Y.Array
- `update_service_order_in_yjs()`: writes `[{id, title, kind}, ...]`
- Called from `poll_once()` when service order changes

**Frontend**: hook or helper to read service order (no UI yet).

**Demo**: Yjs inspector shows `proclaimServiceOrder` updating.

**Before moving on, decide**:
- Include all items or filter blanks/images?
- Any metadata beyond `{id, title, kind}`?

---

## Phase 4: Language-Aware Slide Viewer

**Goal**: `CurrentSlideViewer` shows source or translated slides by language.

**`CurrentSlideViewer.tsx` changes**:
- Accept optional `language` prop
- Fallback chain when `language` set:
  1. `slideTranslations[itemId:language]` (agent output — empty until Phase 6)
  2. `storedTranslation` (Proclaim draft)
  3. `sourceSlides` (untranslated)
- Without `language`: show `sourceSlides` (fallback to `slides`)

**`App.tsx`**: register `currentSlide-{language}` layout component.

**Demo**: `/currentSlide-French` shows Proclaim translations for songs,
English fallback for others. `/currentSlide` shows source text.

**Before moving on, decide**:
- Visual indicator for fallback? (dimmed, "(untranslated)" label)
- Preferred layout for agent + viewer?

---

## Phase 5: Server Chat Endpoint

**Goal**: Stateless endpoint proxying to Gemini with function calling.

**`server.ts` changes**:
- `POST /api/chat` — accepts `{messages, tools}`, returns
  `{content, functionCalls, text}`
- Gemini `gemini-2.5-flash` with `functionDeclarations`

**Demo**: curl showing Gemini returning function calls.

**Before moving on, decide**:
- Model choice (flash vs pro)
- System prompt: baked in or client-controlled?
- Auth/rate limiting?

---

## Phase 6: Agent Loop & Tools

**Goal**: Client-side loop that reads Yjs, calls Gemini, writes translations.

**New files**:
- `src/agentTypes.ts` — Gemini Content/Part/FunctionCall types
- `src/useSlideAgent.ts`:
  - Tools: `get_service_order` (reads Yjs), `write_item_translation` (writes
    `slideTranslations` Y.Map)
  - `runAgentLoop()`: send → response → execute tools → repeat
  - Max 20 iterations, AbortController, `sourceHash` for staleness

**Demo**: browser console call → translations appear in Yjs →
`currentSlide-French` updates live.

**Before moving on, decide**:
- Translate all at once or item-by-item with confirmation?
- Bible passages: ask user to paste, or AI-translate with disclaimer?
- One language per run or both French + Haitian?

---

## Phase 7: Chat UI

**Goal**: Visible chat panel.

**New file**: `src/SlideAgentChat.tsx`
- Message bubbles, "Start Translation" button, collapsible tool calls,
  loading/cancel, text input for follow-ups

**`App.tsx`**: register `slideAgent` layout component.

**Demo**: `/slideAgent,currentSlide-French` — click "Start Translation",
watch translations appear live.

---

## Future (not phased yet)

- Approval workflow for reviewed translations
- Skip re-translating unchanged items (sourceHash caching)
- Multi-language support (French then Haitian)
- TTS for translated slides
- Deprecate legacy `slides` field
- Offline pre-translation before service starts
