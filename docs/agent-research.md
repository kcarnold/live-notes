# Slide Translation Agent: Technical Reference

Dense reference for AI agents implementing the plan in
`PLAN_slide_translation_agent.md`. Contains findings from prior research,
gotchas discovered during prototyping, and ready-to-use code fragments.

---

## 1. Proclaim Data Model (as of main)

### ServiceItemWithSlides dataclass (`proclaim_lib.py:24-28`)

```python
@dataclass
class ServiceItemWithSlides:
    itemId: str
    title: str
    slides: List[str]
    itemKind: str
```

Phase 2 adds: `sourceSlides: Optional[List[str]] = None`,
`storedTranslation: Optional[List[str]] = None`.

### Yjs data written by proclaim_service.py

```python
# proclaimPresentations Y.Map — keyed by item_id
presentations_map[item_id] = {
    'title': str,
    'itemId': str,
    'slides': list[str],  # currently = translation-screen content
}

# proclaimStatus Y.Map
status_map['itemId'] = str
status_map['slideIndex'] = int
```

Phase 2 adds `sourceSlides`, `storedTranslation`, `itemKind` to the
presentations_map entry. Phase 3 adds `proclaimServiceOrder` Y.Array.

### CurrentSlideViewer reads from Yjs (`CurrentSlideViewer.tsx:89-124`)

```typescript
const statusMap = useMap('proclaimStatus');
const presentationsMap = useMap('proclaimPresentations');
// reads: presentation.title, presentation.slides (cast as {title: string; slides: string[]})
```

---

## 2. Proclaim DB Content Format — Critical Gotchas

### VirtualScreens is double-encoded JSON

The `presentation_row.content` is a parsed dict, but its `VirtualScreens`
value is a **JSON string** that must be parsed again:

```python
content = presentation_row['content']  # already a dict
virtual_screens = json.loads(content.get('VirtualScreens', '[]'))  # parse string → list
```

Example raw value:
```json
"[{\"outputKind\": \"Slides\", \"name\": \"Main Screen\"}, {\"outputKind\": \"SlidesAlternateContent\", \"name\": \"French or Haitian\"}]"
```

**Gotcha**: Test fixtures must store VirtualScreens as a JSON string, not a
parsed list. The synthetic fixture was broken until this was corrected.

### Service item IDs: dashed vs undashed

The API returns dashed IDs (`item-song-001`), but the DB strips dashes
(`itemsong001`). `parse_item_translation()` does
`item_id.replace('-', '')` before DB lookup.

**Gotcha**: MockProclaimDB must index both forms:
```python
for key, row in snapshot['service_items'].items():
    self._items[key] = row
    self._items[key.replace('-', '')] = row
```

### Translation screen index is 1-indexed in detection, 0-indexed in keys

`get_translation_screen_idx()` returns 1-based index among slide screens.
But the content key uses `idx-1`:

```python
translation_key = f'slideOutput:{translation_screen_idx-1}:RichTextXml'
```

For a presentation with screens [Main, French, Green], the French screen is
at index 1 among slide screens, and the key is `slideOutput:0:RichTextXml`.

### Rich text XML format

```xml
<Paragraph Language="fr-FR" Margin="0,0,0,0">
    <Run Text="Grâce infinie" />
</Paragraph>
<Paragraph Language="fr-FR" Margin="0,0,0,0">
    <Run Text="Qui m'a sauvé" />
</Paragraph>
```

Decoded by `decode_richtext_xml()` using lxml. The XML is NOT a complete
document — it's wrapped in `<Song>...</Song>` before parsing.

### Content keys by item kind

```python
MAIN_CONTENT_KEYS = {
    'SongLyrics': '_richtextfield:Lyrics',
    'Content': '_richtextfield:Main Content',
    'BiblePassage': '_richtextfield:Passage',
}
```

Translation-screen content uses: `slideOutput:{idx-1}:RichTextXml`

### Song section parsing

Songs have sections (Verse, Chorus, Bridge, etc.) parsed by
`split_into_song_sections()`. The `CustomOrderSequence` field (e.g.,
`"V1, C1"`) controls slide ordering via `get_slides_in_order()`.

`SongDisplayTitle` provides the display title (e.g.,
"Amazing Grace (My Chains Are Gone)"), inserted as the first slide.

### Blank/skip items

These produce `slides=['']`:
- `itemKind == 'ImageSlideshow'`
- `title.lower() in ('blank', 'ncf slide', 'offering slide')`

### Content slide splitting

Non-song content splits on `--` delimiter via `split_into_slides()`.

### Translation screen interleaving

The single "French or Haitian" screen interleaves both languages. Songs
might have French translation while spoken content has Haitian Creole.
The `storedTranslation` field captures whatever is on that screen without
language tagging.

---

## 3. Gemini Function Calling Format

### Request format (server-side)

```typescript
const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  tools: [{
    functionDeclarations: [
      {
        name: 'get_service_order',
        description: 'Get the current presentation service order with all items',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'write_item_translation',
        description: 'Write translated slides for a service item',
        parameters: {
          type: 'object',
          properties: {
            itemId: { type: 'string' },
            language: { type: 'string' },
            slides: { type: 'array', items: { type: 'string' } },
            sourceHash: { type: 'string' }
          },
          required: ['itemId', 'language', 'slides']
        }
      }
    ]
  }]
});
```

### Response structure

Gemini response `candidate.content.parts` contains mixed parts:
- `{ text: "I'll translate..." }` — text response
- `{ functionCall: { name: "write_item_translation", args: {...} } }` — tool call

Multiple function calls can appear in a single response.

### Tool result format (sent back as user message)

```typescript
{
  role: 'user',
  parts: [{
    functionResponse: {
      name: 'write_item_translation',
      response: { success: true }
    }
  }]
}
```

**Gotcha**: Gemini requires tool results as role `user`, not a separate
`tool` role like OpenAI.

---

## 4. Client-Side Agent Architecture

### Agent loop (useSlideAgent.ts)

```
User message → POST /api/chat → Gemini response
  ↓
Has function calls? → Execute tools (read/write Yjs) → Send results back → Loop
  ↓ (no)
Done — display assistant text
```

Max 20 iterations. AbortController for cancellation.

### Tool: get_service_order

Reads `proclaimServiceOrder` Y.Array and `proclaimPresentations` Y.Map.
Returns:
```json
{
  "items": [
    {
      "id": "item-song-001",
      "title": "Amazing Grace",
      "kind": "SongLyrics",
      "sourceSlides": ["Amazing Grace (My Chains Are Gone)", "Amazing grace..."],
      "storedTranslation": ["Grâce infinie", "Grâce infinie si douce..."],
      "sourceHash": "a1b2c3d4"
    }
  ]
}
```

### Tool: write_item_translation

Writes to `slideTranslations` Y.Map:
```typescript
const key = `${itemId}:${language}`;
slideTranslationsMap.set(key, { slides, sourceHash, updatedAt });
```

### sourceHash for staleness

djb2 hash of `sourceSlides.join('|')`. If Proclaim source changes, hash
changes, and cached translations are stale.

```typescript
function createHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16);
}
```

---

## 5. Existing Server Endpoints (server.ts)

```
GET  /api/config              — PostHog config {posthogKey, posthogHost}
POST /api/ys-auth             — Y-Sweet auth tokens
POST /api/requestTranslatedBlocks — Gemini translation (existing, for notes)
POST /api/tts                 — ElevenLabs TTS
GET  *                        — Static file serving
```

Phase 5 adds `POST /api/chat`.

---

## 6. Layout System (App.tsx)

URL path encodes layout: rows separated by `|`, columns by `,`.

Examples:
- `/currentSlide` — single slide viewer
- `/slideAgent,currentSlide-French` — agent chat + French slide viewer
- `/translatedText-French,currentSlide` — text translation + slides

Components registered via a map. Phase 4 adds `currentSlide-{language}`,
Phase 7 adds `slideAgent`.

---

## 7. Test Infrastructure (Phase 1 as built)

### Snapshot format (actual)

```json
{
  "date": "2026-05-02",
  "note": "Captured from live Proclaim session",
  "current_status": { "itemId": "cadcccaa-...", "slideIndex": 3, ... },
  "presentation_content": {
    "VirtualScreens": "[{...JSON string...}]"
  },
  "service_items": [
    {
      "ServiceItemId": "cadcccaa301848bcb0738e239fc264b7",
      "Title": "Revelation Song",
      "ServiceItemKind": "SongLyrics",
      "content_dict": {
        "_richtextfield:Lyrics": "<Paragraph ...>...",
        "slideOutput:1:RichTextXml": "<Paragraph ...>...",
        "CustomOrderSequence": "v1,c,v2",
        "SongDisplayTitle": "Revelation Song"
      }
    }
  ]
}
```

Differences from the design sketch:
- `service_items` is a **list** (preserves service order), not a dict
- `content_dict` stores item content as a **parsed dict**, not a JSON string — `MockProclaimDB` serializes it back to `Content` on access
- `presentation_content` is a flat dict (just the content, not the full row); `VirtualScreens` is still a JSON string inside it
- `current_status` is the raw status object from the API (includes extra fields like `mediaState`)
- No `onair_response` or `captured_at` fields

### Expected output files

Each snapshot has a companion `*.expected.json` with the full parse output:

```json
{
  "status": { "itemId": "...", "slideIndex": 3, ... },
  "presentations": [
    { "itemId": "...", "title": "Revelation Song", "itemKind": "SongLyrics", "slides": [...] }
  ]
}
```

Regenerate with: `uv run tests/update_expected.py [stem] [--force]`

### MockProclaimDB (`tests/conftest.py`)

```python
class MockProclaimDB:
    def __init__(self, data):
        self._items = {
            item["ServiceItemId"].replace("-", ""): item
            for item in data["service_items"]
        }

    def get_service_item(self, item_id):
        item = self._items.get(item_id.replace("-", ""))
        if item is None:
            return None
        result = dict(item)
        if "content_dict" in result:
            result["Content"] = json.dumps(result.pop("content_dict"))
        return result
```

### Parametrized fixtures

```python
@pytest.fixture(
    params=sorted(p for p in SNAPSHOTS_DIR.glob("*.json") if not p.stem.endswith(".expected")),
    ids=lambda p: p.stem,
)
def snapshot(request): ...

@pytest.fixture
def expected(request, snapshot): ...  # loads *.expected.json alongside snapshot, or None
```

### Capture tool (`proclaim_capture.py`)

Standalone script, not embedded in `proclaim_service.py`. Calls
`/onair/session` → `/presentations/onair` → `/onair/statusChanged`, fetches
`presentation_content` from DB via `presentationId` in status response.

Run: `uv run proclaim_capture.py [--output PATH]`

### pyproject.toml additions

```toml
[tool.pytest]
testpaths = ["tests"]
pythonpath = ["."]
```

Uses `[tool.pytest]` (pytest 9 native TOML), not `[tool.pytest.ini_options]`.

### Things from the design sketch worth considering

- **Hash-based dedup in capture**: the sketch proposed not overwriting a snapshot if content matches. Useful once passive capture is running.
- **Passive capture via env var in `proclaim_service.py`**: embedding `PROCLAIM_CAPTURE_DIR` in the service so snapshots accumulate automatically during live use — good for building a test corpus without manual effort.

---

## 8. parse_item_slides Implementation Notes (Phase 2)

The new function extracts both main and translation content. Key logic:

```python
def parse_item_slides(db, item_id, translation_idx=None):
    service_item = db.get_service_item(item_id.replace('-', ''))
    content = json.loads(service_item['Content'])
    item_kind = service_item['ServiceItemKind']

    # Blank items
    if item_kind in ["ImageSlideshow"] or title.lower() in BLANK_TITLES:
        return ServiceItemWithSlides(slides=[''], sourceSlides=[''], ...)

    # Main-screen content (always)
    main_key = MAIN_CONTENT_KEYS.get(item_kind)
    main_xml = content.get(main_key)
    source_slides = _xml_to_slides(main_xml, item_kind, content)

    # Translation-screen content (optional)
    stored_translation = None
    if translation_idx is not None:
        trans_key = f'slideOutput:{translation_idx-1}:RichTextXml'
        if trans_key in content:
            trans_xml = content[trans_key]
            stored_translation = _xml_to_slides(trans_xml, item_kind, content)

    # Backward compat: slides = translation if available, else source
    slides = stored_translation if stored_translation else source_slides

    return ServiceItemWithSlides(
        itemId=item_id, title=title, slides=slides,
        sourceSlides=source_slides, storedTranslation=stored_translation,
        itemKind=item_kind,
    )
```

`_xml_to_slides()` handles the item-kind-specific parsing:
- SongLyrics: decode XML → split sections → order by CustomOrderSequence →
  prepend SongDisplayTitle
- Content: decode XML → split on `--` delimiter
- BiblePassage: decode XML → single slide (or split on `--`)

---

## 9. Proclaim API Endpoints (local, port 52195)

```
GET /api/presentations/current          — current presentation ID
GET /api/presentations/{id}/onair       — service order with item metadata
GET /api/presentations/{id}/status      — current item and slide index
```

The Python service polls these every ~1 second.

---

## 10. Key File Locations on main

```
proclaim_lib.py              — Parsing library (ServiceItemWithSlides, parse_item_translation, etc.)
proclaim_service.py          — Proclaim→Yjs sync service (ProclaimYjsService)
src/CurrentSlideViewer.tsx   — Slide viewer (pure component + Yjs container)
src/App.tsx                  — Layout system, component registry
server.ts                    — Express backend
src/translationUtils.ts      — Notes translation pipeline (separate from slide translation)
src/useTTS.ts                — TTS hook
src/strings.ts               — UI localization strings
src/useLocale.ts             — Locale resolution
```
