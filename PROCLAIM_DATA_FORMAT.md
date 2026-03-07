# Proclaim Data Format

This documents the parts of Proclaim's local API and SQLite database format that we use.

## Local API (port 52195)

Faithlife Proclaim exposes a local HTTP API on port 52195.

### Endpoints

- **GET /onair/session** — Returns a session ID string for authentication.
- **GET /presentations/onair** — Returns current on-air presentation data.
  Requires `OnAirSessionId` header. The key data is the `serviceItems` array:
  ```json
  {
    "serviceItems": [
      {
        "id": "39510e4d-b345-4f63-abf1-8c8e6bdff9b3",
        "title": "Call to Worship",
        "notes": "",
        "kind": "Content",
        "slides": [
          { "localRevision": 639060998184592130, "index": 0 },
          { "localRevision": 639060998184592130, "index": 1 }
        ]
      }
    ]
  }
  ```
- **GET /onair/statusChanged** — Returns current on-air status.
  Requires `OnAirSessionId` header. Returns 404 when off air.
  ```json
  {
    "presentationId": "abc123...",
    "status": {
      "itemId": "39510e4d-...",
      "slideIndex": 2
    }
  }
  ```
- **GET /presentations/onair/items/{serviceItemId}/slides/{slideIndex}/image** — Slide image (untested, unused).

## SQLite Database

Proclaim stores presentation data in a SQLite database at:

- **macOS**: `~/Library/Application Support/Proclaim/Data/<id>/PresentationManager/PresentationManager.db`
- **Windows**: `%LOCALAPPDATA%\Proclaim\Data\<id>\PresentationManager\PresentationManager.db`

There may be multiple `<id>` directories; we use the one with the most recently modified database.

### Tables

#### `Presentations`

| Column         | Type | Description                                    |
|---------------|------|------------------------------------------------|
| PresentationId | TEXT | UUID (no hyphens)                              |
| DateGiven      | TEXT | Date string (e.g., `"2025-03-02"`)             |
| Title          | TEXT | Presentation title                             |
| Content        | TEXT | JSON blob with presentation-level settings     |

The `Content` JSON includes:

- **`VirtualScreens`** — JSON string (yes, double-encoded) listing the output screens:
  ```json
  [
    { "name": "Main",         "outputKind": "Slides" },
    { "name": "Green Screen",  "outputKind": "Slides" },
    { "name": "French",        "outputKind": "SlidesAlternateContent" }
  ]
  ```
  We filter to screens with `outputKind` in `["Slides", "SlidesAlternateContent"]` and identify translation screens by name (containing "French" or "Haitian").

#### `ServiceItems`

| Column          | Type | Description                                          |
|----------------|------|------------------------------------------------------|
| ServiceItemId   | TEXT | UUID (no hyphens)                                    |
| PresentationId  | TEXT | FK to Presentations                                  |
| Title           | TEXT | Item title (e.g., "Call to Worship")                 |
| ServiceItemKind | TEXT | One of: `SongLyrics`, `Content`, `BiblePassage`, `ImageSlideshow`, `Grouping` |
| Content         | TEXT | JSON blob with item-specific data                    |

### ServiceItem Content JSON

The `Content` JSON structure varies by `ServiceItemKind`. All text content is stored as rich text XML (see below).

#### Common keys

- **`slideOutput:{N}:RichTextXml`** — The content for screen index N (0-based, but offset by -1 from VirtualScreens index). For example, if the translation screen is at VirtualScreens index 2, the translation content is at `slideOutput:1:RichTextXml`.
- **`slideOutput:{N}:MediaId`** — Media ID for screen N.

#### `SongLyrics`

- **`_richtextfield:Lyrics`** — Main lyrics in rich text XML.
- **`CustomOrderSequence`** — Comma-separated order string (e.g., `"V1, V2, C, V3, C, B, C"`).
- **`CustomOrderSlides`** — `"true"` if custom ordering is enabled.
- **`SongDisplayTitle`** — Optional title slide text.
- **`UseCustomTransition`** — `"true"` if using custom transitions.
- **`CustomTransitionKind`** — e.g., `"LyricScrolling"`.
- **`CustomTransitionDuration`** — e.g., `"0"`.

#### `Content`

- **`_richtextfield:Main Content`** — Main content in rich text XML.

#### `BiblePassage`

- **`_richtextfield:Passage`** — Passage text in rich text XML.
- **`_textfield:BibleReference`** — Reference string (e.g., `"Psalm 23:1-6"`).

## Rich Text XML

Text content in Proclaim is stored as rich text XML fragments. Each paragraph is a `<Paragraph>` element containing one or more `<Run>` elements with a `Text` attribute.

```xml
<Paragraph Language="en-US" Margin="0,0,0,0">
    <Run Text="First line of text" />
</Paragraph>
<Paragraph Language="en-US" Margin="0,0,0,0">
    <Run Text="Second line of text" />
</Paragraph>
<Paragraph Language="en-US" Margin="0,0,0,0" />
<Paragraph Language="en-US" Margin="0,0,0,0">
    <Run Text="After a blank line" />
</Paragraph>
```

- Each `<Paragraph>` becomes one line of text.
- Empty paragraphs (no `<Run>` children) become blank lines.
- Multiple `<Run>` elements within a paragraph are concatenated with spaces.
- The XML fragments are **not** wrapped in a root element; we wrap them in `<Song>...</Song>` for parsing.

## Song Section Format

Song lyrics are divided into labeled sections. A line matching a section type name acts as a section header:

| Section     | Shorthands in CustomOrderSequence |
|------------|-----------------------------------|
| Verse      | `V`, `V1`, `1`                   |
| Chorus     | `C`, `C1`                        |
| Pre-chorus | `P`, `P1`                        |
| Bridge     | `B` (if Bridge exists), `Bridge` |
| Tag        | `T`                              |
| Interlude  | `I`                              |
| Ending     | `Ending`                         |
| Blank      | `B` (if no Bridge section)       |

Lines in `{Braces}` are also treated as section labels (e.g., `{Credits}`, `{Source}`).

### Example lyrics text (after XML decoding)

```
Verse 1
Line one of verse one
Line two of verse one

Verse 2
Line one of verse two
Line two of verse two

Chorus
Line one of chorus
Line two of chorus

Bridge
Line one of bridge
```

With `CustomOrderSequence = "V1, V2, C, V1, C, B, C"`, the slides would be ordered as: Verse 1, Verse 2, Chorus, Verse 1 (again), Chorus, Bridge, Chorus.

## Slide Splitting

Within each section, text is split into individual slides:

- If the text contains `--`, only `--` lines are slide breaks (explicit delimiters). This is the reliable case.
- If there are **no `--` delimiters**, Proclaim automatically breaks text into slides based on how it fits on screen. We approximate this by treating blank lines as slide breaks, but this is fragile — Proclaim may keep text on one slide even across blank lines if it all fits, or break mid-paragraph if it doesn't. There is no way to know the exact breaks without rendering the text at the actual slide dimensions.
- Sections starting with `{Credits}` or `{Source}` are filtered out.

Because of this ambiguity, the validator warns when content items lack explicit `--` delimiters and have multiple slides — the translation may be misaligned with the original.
