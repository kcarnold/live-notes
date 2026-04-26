# Plan: In-App Slide Translation Agent

Replace the current workflow (storing translations in Proclaim) with an in-app
conversational agent that translates presentation slides. Each phase is a
mergeable, demoable increment.

## Current State (main)

- `proclaim_lib.py`: `parse_item_translation()` extracts **translation-screen**
  content into `ServiceItemWithSlides.slides`
- `proclaim_service.py`: writes `{title, itemId, slides}` to Yjs
  `proclaimPresentations` map (slides = translation-screen text)
- `CurrentSlideViewer.tsx`: reads `{title, slides}` from Yjs and displays them
- No test infrastructure for Proclaim parsing
- No agent, no chat UI

## Naming Strategy

Existing `slides` field = translation-screen content. To avoid breaking
`CurrentSlideViewer`, we **add new fields** rather than rename:

| Field              | Meaning                                     | Source            |
|--------------------|---------------------------------------------|-------------------|
| `slides`           | (legacy) translation-screen content         | Proclaim DB       |
| `sourceSlides`     | Main-screen untranslated content            | Proclaim DB       |
| `storedTranslation`| Existing Proclaim translation (draft quality)| Proclaim DB      |
| `itemKind`         | Item type (SongLyrics, Content, etc.)       | Proclaim DB       |

The agent writes translations to a **separate** Yjs Y.Map
(`slideTranslations`) keyed by `{itemId}:{language}`, keeping Proclaim data
and agent output cleanly separated.

Later, once the agent is working, we can deprecate `slides` in favor of
`sourceSlides` + agent translations.

---

## Phase 1: Capture & Test Infrastructure

**Goal**: Record real Proclaim data for offline testing. Purely additive — no
behavior changes.

**Files**:
- `proclaim_capture.py` — snapshot capture tool (reads API + DB, writes JSON)
- `tests/conftest.py` — `MockProclaimDB`, `snapshot` fixture
- `tests/proclaim_snapshots/2026-01-05_synthetic.json` — synthetic fixture
- `tests/test_proclaim_pipeline.py` — integration tests
- `pyproject.toml` — add pytest config (`testpaths`, `pythonpath`)

**Synthetic fixture covers**: SongLyrics (with custom order + translation
screen), Content (with `--` delimiter + translation), BiblePassage (no
translation), ImageSlideshow (blank), Blank content item.

**Tests verify**:
- All items parse without error
- Blank items → `slides=['']`
- Non-blank items have content
- Yjs dict has correct keys and types
- Translation screen detection
- Song-specific: title as first slide, custom order, English main / French translation
- Content-specific: delimiter splitting, translation pairing

**Demo**: `uv run pytest tests/ -v` passes.

**Decision points for user**:
- Does the synthetic fixture cover the real-world cases you see?
- Want to capture a real session snapshot before moving on?

---

## Phase 2: Extract Source Slides from Proclaim

**Goal**: Parse **both** main-screen and translation-screen content from
Proclaim, sync both to Yjs. Existing viewer keeps working.

**Changes to `proclaim_lib.py`**:
- Add `sourceSlides: Optional[List[str]]` and
  `storedTranslation: Optional[List[str]]` to `ServiceItemWithSlides`
- Create `parse_item_slides(db, item_id, translation_idx)`:
  - Always extracts main-screen content → `sourceSlides`
  - Extracts translation-screen content → `storedTranslation` (if screen exists)
  - For backward compat: `slides` = `storedTranslation` if available, else
    `sourceSlides` (so CurrentSlideViewer still shows what it shows today)
- `translation_idx` is now `Optional[int]` (None when no translation screen)
- Keep `parse_item_translation()` as a thin wrapper or alias

**Changes to `proclaim_service.py`**:
- `update_presentation_item_in_yjs()` writes `sourceSlides`, `itemKind`,
  and optionally `storedTranslation` alongside existing `slides`
- `_handle_item_change()` works when `translation_idx is None`

**Update tests**: synthetic fixture tests verify both `sourceSlides` and
`storedTranslation` extraction.

**Demo**: Yjs inspector shows new fields; existing `CurrentSlideViewer` still
works unchanged.

**Decision points for user**:
- Confirm the `sourceSlides` / `storedTranslation` naming
- The French/Haitian interleaving: is `storedTranslation` always the same
  language, or do some items have French and others Haitian on the same screen?
  (Affects whether we need per-slide language tagging)

---

## Phase 3: Service Order in Yjs

**Goal**: Sync the full service order (list of all items) to Yjs so the
client-side agent can enumerate what needs translating.

**Changes to `proclaim_service.py`**:
- Add `proclaimServiceOrder` Y.Array
- `update_service_order_in_yjs()`: writes `[{id, title, kind}, ...]` from API
- Called from `poll_once()` when service order changes

**Frontend**: Add a React hook or helper to read service order — but no UI yet.

**Demo**: Yjs inspector shows `proclaimServiceOrder` array updating as
Proclaim service order changes.

**Decision points for user**:
- Should service order include all items or filter out blanks/images?
- Any metadata beyond `{id, title, kind}` that the agent will need?

---

## Phase 4: Language-Aware Slide Viewer

**Goal**: `CurrentSlideViewer` can show either source or translated slides,
selected by language.

**Changes to `CurrentSlideViewer.tsx`**:
- Accept optional `language` prop
- When `language` is set, use fallback chain:
  1. `slideTranslations[itemId:language]` (agent-written, not yet populated)
  2. `storedTranslation` (from Proclaim)
  3. `sourceSlides` (untranslated fallback)
- When no `language`, show `sourceSlides` (or `slides` as final fallback)

**Changes to `App.tsx`**:
- Register `currentSlide-{language}` layout component

**Demo**: URL `/currentSlide-French` shows Proclaim translations for songs
(from `storedTranslation`), English fallback for items without translation.
`/currentSlide` shows untranslated source.

**Decision points for user**:
- Should the viewer visually indicate when it's showing a fallback?
  (e.g., dimmed text or "(untranslated)" label)
- Layout: `/slideAgent,currentSlide-French` or different arrangement?

---

## Phase 5: Server Chat Endpoint

**Goal**: Stateless server endpoint that proxies chat messages to Gemini with
function-calling support.

**Changes to `server.ts`**:
- `POST /api/chat` — accepts `{messages, tools}`, calls Gemini, returns
  `{content, functionCalls, text}`
- Uses `gemini-2.5-flash` with function declarations
- No server-side state; client owns conversation history

**Demo**: `curl` test showing Gemini responding to "translate this to French"
with a `write_item_translation` function call.

**Decision points for user**:
- Gemini model choice (flash vs pro) — flash is faster/cheaper, pro may
  translate better
- Should there be a system prompt baked in, or fully client-controlled?
- Rate limiting / auth on the endpoint?

---

## Phase 6: Agent Loop & Tools

**Goal**: Client-side agent loop that reads Yjs, calls Gemini, and writes
translations back to Yjs.

**New files**:
- `src/agentTypes.ts` — Gemini API types (Content, Part, FunctionCall, etc.)
- `src/useSlideAgent.ts` — agent hook with:
  - Tool definitions: `get_service_order`, `write_item_translation`
  - `get_service_order`: reads `proclaimServiceOrder` + `proclaimPresentations`
    from Yjs, returns items with `sourceSlides`, `storedTranslation`, `itemKind`
  - `write_item_translation`: writes to `slideTranslations` Y.Map
  - `runAgentLoop()`: send messages → get response → execute tool calls → loop
  - Max iterations (20), AbortController for cancellation
  - `sourceHash` (djb2 of `sourceSlides.join('|')`) for staleness detection

**Demo**: Call `runAgentLoop()` from browser console with "translate the
service to French" → watch translations appear in `slideTranslations` Y.Map →
`currentSlide-French` updates live.

**Decision points for user**:
- Should the agent translate everything at once, or item-by-item with
  confirmation?
- For Bible passages: should the agent ask the user to paste authoritative
  text, or attempt AI translation with a disclaimer?
- How to handle the French/Haitian interleaving — translate to one language
  per run, or both?

---

## Phase 7: Chat UI

**Goal**: Visible chat panel for interacting with the agent.

**New file**: `src/SlideAgentChat.tsx`
- Message bubbles (user / assistant / tool results)
- "Start Translation" button for one-click full-service translation
- Tool calls shown as collapsible `<details>` elements
- Loading state, cancel button
- Text input for follow-up instructions

**Changes to `App.tsx`**:
- Register `slideAgent` layout component

**Demo**: `/slideAgent,currentSlide-French` — click "Start Translation",
watch the agent work through each item, see translations appear in the
slide viewer in real time.

---

## Future (not phased yet)

- **Approval workflow**: mark translations as reviewed/approved
- **Caching**: skip re-translating items whose `sourceHash` hasn't changed
- **Multi-language**: run agent for French then Haitian Creole
- **TTS for slides**: auto-speak translated slides
- **Deprecate `slides` field**: once agent is primary, remove legacy field
- **Offline mode**: pre-translate before service starts
