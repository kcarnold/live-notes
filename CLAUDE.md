# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **live translation application** for presentations/talks. It provides real-time speech transcription and AI-powered translation into multiple languages, displayed in configurable layouts. The system uses:

- **Real-time collaboration**: Y-Sweet/Yjs for shared state across viewers
- **Speech transcription**: Web Speech API (browser-native) for live speech-to-text
- **Translation**: Google Gemini for AI-powered translation
- **Text-to-Speech**: ElevenLabs for audio playback of translations
- **Proclaim integration**: Python service syncing Proclaim presentation slides to Yjs
- **Rich text editing**: ProseMirror for collaborative markdown editing
- **Frontend**: React + TypeScript + Vite + Tailwind CSS
- **Backend**: Express server

## Development Commands

### Setup
```bash
# Copy environment template and fill in API keys
cp template-.env .env

# Install dependencies
npm install
```

Required environment variables (`.env`):
- `YSWEET_CONNECTION_STRING` - Y-Sweet connection string from jamsocket.com
- `GEMINI_API_KEY` - Google Gemini API key
- `ELEVENLABS_API_KEY` - ElevenLabs API key for text-to-speech

Optional environment variables:
- `TTS_MAX_CONCURRENT` - Max concurrent TTS requests (default: 2)
- `VITE_PUBLIC_POSTHOG_KEY` - PostHog analytics key (for usage tracking)
- `VITE_PUBLIC_POSTHOG_HOST` - PostHog host URL (default: https://us.i.posthog.com)
- `POSTHOG_CLI_TOKEN` - PostHog CLI token (for sourcemap uploads during Docker build)
- `POSTHOG_CLI_ENV_ID` - PostHog environment ID (for sourcemap uploads)
- `POSTHOG_CLI_HOST` - PostHog CLI host (for sourcemap uploads)

### Development
```bash
# Run backend server (port 8000 by default)
npm run dev:server

# Run frontend dev server (in separate terminal)
npm run dev

# OPTIONAL: Run Proclaim integration service (in separate terminal, requires Proclaim running)
# See PROCLAIM_INTEGRATION.md for full setup instructions
uv run proclaim_service.py
```

### Testing & Building
```bash
# Run tests
npm test

# Run tests without ANSI color codes (useful for agents/CI)
npm test -- --no-color

# Run Python tests (Proclaim parsing pipeline)
uv run pytest tests/ -v

# Regenerate Proclaim expected output files after intentional parse changes
uv run tests/update_expected.py [--force]

# Run specific test file
npm test -- path/to/test.ts --run

# Lint code
npm run lint

# Build for production (requires npm install first)
npm run build

# Start production server (serves built files)
npm start
```

**Important**:
- Always run `npm install` before building or testing, especially in fresh environments. The build will fail with module resolution errors if dependencies aren't installed.
- When running tests via tools/agents, use `--no-color` flag to disable ANSI color codes in output.

### Deployment
```bash
# Build and run with Docker Compose
docker compose build
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

**Docker Notes**:
- Environment variables are loaded from `.env` file automatically (see `compose.yaml`)
- Audio cache is persisted in `./audio-cache` directory
- PostHog sourcemaps are uploaded during build if `POSTHOG_CLI_TOKEN` is provided

## Architecture

### Core Collaboration Flow

The app uses **Yjs** for real-time collaborative state management:

1. **Y-Sweet authentication** ([server.ts:90-101](server.ts#L90-L101)): Backend issues read-only or full access tokens based on editor status
2. **Shared Y.Doc** per session: Each session (identified by `?doc=doc-YYYY-MM-DD`) has a shared Yjs document
3. **Key shared data structures**:
   - `transcriptDoc` (XmlFragment): Live transcription from speech
   - `prosemirror` (XmlFragment): User-edited source text for translation
   - `translatedText-{language}` (Y.Text): Translated output for each language
   - `meta` (Y.Map): Metadata (unused currently)
   - `notesTranslationCache` (Y.Map): Translation cache to avoid re-translating unchanged text
   - `proclaimServiceItems` (Y.Map): Maps itemId → presentation data (title, slides)
   - `proclaimStatus` (Y.Map): Current Proclaim status (itemId, slideIndex)

### Translation Pipeline

The translation system is sophisticated with caching and incremental updates:

1. **Chunking** ([translationUtils.ts:53-90](translationUtils.ts#L53-L90)): Source text is split into chunks (lines), with whitespace handling
2. **Decomposition** ([translationUtils.ts:30-42](translationUtils.ts#L30-L42)): Each chunk is decomposed into `format` (markdown syntax), `content`, and `trailingWhitespace`
3. **Cache lookup** ([translationUtils.ts:112-164](translationUtils.ts#L112-L164)): Check which chunks need translation using `translationCache`
4. **Context provision**: Untranslated chunks get 3 lines of context from already-translated chunks
5. **Batch translation** ([server.ts:104-118](server.ts#L104-L118)): Server endpoint processes batches via Gemini
6. **Cache update** ([translationUtils.ts:166-185](translationUtils.ts#L166-L185)): New translations are cached in the shared Y.Map
7. **Reconstruction** ([translationUtils.ts:187-204](translationUtils.ts#L187-L204)): Final text is reassembled from cached translations with original formatting

### Text-to-Speech (TTS) System

The TTS system provides both manual and automatic text-to-speech playback with a clean separation of concerns:

#### Architecture

The TTS system uses a two-layer architecture that separates "how to speak" from "what to read":

**Layer 1: Low-level audio playback** ([useTTS.ts](src/useTTS.ts))
- Simple hook that manages audio fetching and playback lifecycle
- Handles race conditions (cancel, superseded requests)
- Provides callbacks for completion and errors
- No knowledge of which line to play next - just plays what it's told

**Layer 2: Playback logic** ([TranslatedTextViewer.tsx](src/TranslatedTextViewer.tsx))
- Decides which lines to play and when
- Manages playhead cursor and auto-play mode
- Responds to user interactions (clicks, auto-mode toggle)
- Pure component (accepts `lines[]` prop), Yjs integration in container

**Backend** ([server.ts](server.ts))
- ElevenLabs API integration
- Audio file caching in `/audio-cache` (MD5 hash keys)
- Concurrency limiting (2 concurrent requests by default)
- Exponential backoff on rate limit errors (429)
- In-flight request deduplication

#### Playhead-Based Auto-Play

The auto-play system uses a simple **playhead cursor** approach:

**State**:
- `playhead`: Index of last line that finished playing (starts at -1)
- `autoSpeakEnabled`: Whether auto-play mode is active
- `tts.status`: Current playback status (idle | loading | playing | error)

**Logic**:
1. When auto-play is enabled and TTS is idle:
   - Play `lines[playhead + 1]` if it exists
2. When a line finishes playing:
   - Update playhead to that line's index
   - Trigger step 1 again (via useEffect)

**Example**: Starting with 5 lines and playhead = -1:
- Auto-mode enabled → plays line 0
- Line 0 finishes → playhead = 0 → plays line 1
- Line 1 finishes → playhead = 1 → plays line 2
- User adds 2 more lines (now 7 total)
- Line 2 finishes → playhead = 2 → plays line 3
- Continues sequentially through all lines

#### Dual Modes

**Manual mode** (default):
- Click any line to speak it
- Click again to cancel
- Playhead still advances when lines finish (for potential auto-mode switch)

**Auto mode**:
- Toggle with "Auto-Speak" button
- Automatically plays from playhead + 1
- Stops when disabled (can resume later from same position)
- No complex catchup logic - just plays sequentially

#### Race Condition Handling

The `useTTS` hook carefully prevents race conditions:

```typescript
// Each request is tracked with an identity object
const request = { text, language };
currentRequestRef.current = request;

// Event listeners check if request is still current
audio.addEventListener('ended', () => {
  if (currentRequestRef.current === request) {
    // Only call callback if not cancelled/superseded
    onFinished(text);
  }
});
```

This ensures:
- Callbacks don't fire after `cancel()`
- Callbacks don't fire when a new `speak()` supersedes the request
- Clean state even after errors or rapid interactions

### Block-Based Editor

The app includes a **block-based collaborative editor** ([BlockEditor.tsx](src/BlockEditor.tsx)) as an alternative to ProseMirror:

#### Architecture
- **Yjs-backed blocks**: Each block stored as `Y.Map` in a `Y.Array`
- **Fractional indexing**: Blocks use fractional-index positions for stable ordering
- **Auto-sizing textareas**: Textareas grow/shrink to fit content
- **Parent-child structure**: `BlockEditor` manages state, `BlockItem` components handle individual blocks

#### Block Structure
Each block is a `Y.Map` with:
- `id`: UUID for stable identity
- `type`: 'paragraph' | 'heading' | 'listItem'
- `position`: Fractional-index string for ordering
- `indent`: 0-3 (max indent level)
- `text`: Y.Text for collaborative editing

#### Features
- **Live collaboration**: Multiple users can edit different blocks simultaneously via Yjs
- **Markdown serialization**: Blocks convert to markdown (headings, lists with indentation)
- **Keyboard shortcuts**:
  - `Enter`: Create new block below
  - `Backspace` at start: Delete empty block or merge with previous
  - `Tab/Shift-Tab`: Indent/dedent (for lists)
- **Empty block filtering**: Empty blocks aren't serialized to markdown

#### Textarea Auto-sizing
The editor uses a custom auto-sizing solution:
```typescript
// Reset height to measure scrollHeight accurately
textarea.style.height = '0px';
// Set height to content height
textarea.style.height = textarea.scrollHeight + 'px';
```
This ensures textareas are exactly the right height without extra lines.

### ProseMirror Integration

The app also uses ProseMirror for collaborative rich text editing:

- **Yjs binding**: [y-prosemirror](https://github.com/yjs/y-prosemirror) synchronizes ProseMirror state with Y.XmlFragment
- **Markdown serialization** ([ProseMirrorEditor.tsx:74-83](ProseMirrorEditor.tsx#L74-L83)): Content is converted to markdown on every change
- **Custom keybindings** ([ProseMirrorEditor.tsx:54-68](ProseMirrorEditor.tsx#L54-L68)):
  - `Mod-z/y`: Undo/redo (Yjs-aware)
  - `Tab/Shift-Tab`: List item indent/outdent
  - `Mod-Enter`: Trigger translation

### Proclaim Integration

The app integrates with **Proclaim** (church presentation software) to display current slide content in real-time. See [PROCLAIM_INTEGRATION.md](PROCLAIM_INTEGRATION.md) for full documentation.

#### Architecture

The integration uses a **Python service** ([proclaim_service.py](proclaim_service.py)) that:

1. **Polls Proclaim API** (every 1 second) for current presentation and slide status
2. **Parses presentation content** from Proclaim's SQLite database
3. **Extracts translated slides** from rich text XML (supports songs, Bible passages, content slides)
4. **Updates Yjs** via Y-Sweet WebSocket connection with presentation data and current status

#### Data Flow

```
Proclaim API/DB → Python Service → Y-Sweet → React Components
```

The Python service syncs to two Yjs data structures:
- `proclaimServiceItems` (Y.Map): Maps itemId → `{title, itemId, slides, sourceSlides, storedTranslation, itemKind}` — `slides`: legacy translation-screen content; `sourceSlides`: main-screen source text; `storedTranslation`: existing Proclaim translation; `itemKind`: item type
- `proclaimStatus` (Y.Map): Current status `{itemId, slideIndex}`

#### React Components

- **CurrentSlideViewer** ([CurrentSlideViewer.tsx:18-95](CurrentSlideViewer.tsx#L18-L95)): Pure component displaying current slide with optional context (previous/next slides)
- **CurrentSlideViewerContainer** ([CurrentSlideViewer.tsx:100-146](CurrentSlideViewer.tsx#L100-L146)): Yjs connector that reads presentation data and passes to pure component

The viewer shows:
- Header with presentation title and progress (slide X of Y)
- Current slide (large text, blue border highlight)
- Optional context slides (dimmed, smaller)
- Smooth CSS transitions when slides change

#### Key Features

- **Real-time updates**: No browser polling needed - updates instantly via Yjs
- **Intelligent parsing**: Handles song sections, custom order sequences, Bible passages
- **Translation support**: Extracts slides from translation screens (French, Haitian)
- **Skipped items**: Shows blank for image slideshows and certain slide types
- **Error reporting**: PostHog exception capture via env vars injected at install time

#### Installation as macOS LaunchAgent

```bash
bash install_proclaim_service.sh --server-url=https://dev8.kenarnold.org
```

The install script:
1. Fetches PostHog config from `{server-url}/api/config` and injects `POSTHOG_API_KEY` + `POSTHOG_HOST`
2. Sets `YSWEET_URL` from `--server-url` (defaults to `https://dev8.kenarnold.org`)
3. Generates `~/Library/LaunchAgents/org.kenarnold.proclaim-service.plist` from the template
4. Loads the service as a LaunchAgent (auto-restarts, survives reboots)

#### PostHog Config Endpoint

`GET /api/config` on the Express server returns `{ posthogKey, posthogHost }` — used by the install script and any other service that needs to report to the same PostHog project without separately managing the key.

### Layout System

The UI uses a **URL-based layout system** ([App.tsx:262-395](App.tsx#L262-L395)):

- Layouts are encoded in the URL path: `/transcript,sourceText|translatedText-French,currentSlide`
- Format: rows separated by `|`, columns separated by `,`
- Components: `transcript`, `sourceText`, `translatedText-{language}`, `bilingual-{language}`, `currentSlide`
- Language selection in translated views updates the URL dynamically
- Editor mode is triggered by `#editor` hash in URL
- Example with Proclaim: `/translatedText-French,currentSlide` shows translation and current slide side-by-side

### Editor vs Viewer Mode

The app has two modes determined by URL hash (`#editor`):

- **Editor mode** (`#editor`):
  - Can transcribe speech
  - Can edit source text
  - Can trigger translations
  - Has full Y-Sweet write access

- **Viewer mode** (default):
  - Read-only access to all content
  - Receives real-time updates from editors
  - Read-only Y-Sweet token
  - Can use TTS (auto or manual mode)

## Proclaim Test Infrastructure

Python tests in `tests/` cover the Proclaim parsing pipeline. Two files per snapshot in `tests/proclaim_snapshots/`:
- `*.json` — input: raw Proclaim DB + API data (captured with `uv run proclaim_capture.py`)
- `*.expected.json` — approved parse output used for exact-match comparison

`Grouping` service item kind has no slide content and returns `None` from `parse_item_translation` — skip it in tests.

**When starting work on Proclaim parsing or the slide translation agent, read [`docs/agent-research.md`](docs/agent-research.md) first** — it documents gotchas (VirtualScreens double-encoding, ID hyphen stripping, translation screen index math) that are not obvious from the code.

**The phased implementation plan is in [`PLAN_slide_translation_agent.md`](PLAN_slide_translation_agent.md)** — start here when continuing slide translation agent work.

## Key Files

### Backend
- [server.ts](server.ts) - Express backend with Y-Sweet auth, translation API, and TTS endpoint
- [nlp.ts](nlp.ts) - Gemini API integration for translation
- [proclaim_service.py](proclaim_service.py) - Python service that syncs Proclaim presentation data to Yjs
- [proclaim_lib.py](proclaim_lib.py) - Core Proclaim parsing library (SQLite DB reading, XML parsing, slide extraction)

### Frontend Core
- [App.tsx](src/App.tsx) - Main React app with routing and layout system
- [ProseMirrorEditor.tsx](src/ProseMirrorEditor.tsx) - Collaborative rich text editor
- [translationUtils.ts](src/translationUtils.ts) - Translation pipeline logic (chunking, caching, reconstruction)
- [yjsUtils.ts](src/yjsUtils.ts) - Yjs utility functions and React hooks

### Components
- [BlockEditor.tsx](src/BlockEditor.tsx) - Block-based collaborative editor with Yjs backing
- [blockTypes.ts](src/blockTypes.ts) - Block data structures and utilities
- [SourceTextTranslationManager.tsx](src/SourceTextTranslationManager.tsx) - Source text editor with translation controls
- [SpeechTranscriber.tsx](src/SpeechTranscriber.tsx) - Web Speech API integration for live transcription
- [TranslatedTextViewer.tsx](src/TranslatedTextViewer.tsx) - Markdown renderer with TTS controls and auto-play logic
- [TranslatedTextViewerContainer.tsx](src/TranslatedTextViewerContainer.tsx) - Yjs connector for TranslatedTextViewer
- [BilingualBlockViewer.tsx](src/BilingualBlockViewer.tsx) - Shows blocks with original text and translation side-by-side
- [BilingualBlockViewerContainer.tsx](src/BilingualBlockViewerContainer.tsx) - Yjs connector for BilingualBlockViewer
- [CurrentSlideViewer.tsx](src/CurrentSlideViewer.tsx) - Proclaim slide viewer with pure component and Yjs container

### TTS System
- [useTTS.ts](src/useTTS.ts) - Low-level TTS hook managing audio playback lifecycle
- [useTTS.test.ts](src/useTTS.test.ts) - Comprehensive tests for useTTS hook (12 tests)
- [TranslatedTextViewer.test.tsx](src/TranslatedTextViewer.test.tsx) - Component tests for playhead and auto-play (15 tests)

## Important Patterns

### Yjs State Updates

Always use Yjs methods to update shared state:

```typescript
// Y.Text
const yText = ydoc.getText('key');
yText.delete(0, yText.length);  // Clear
yText.insert(0, 'new content');  // Insert

// Y.Map
const yMap = ydoc.getMap('key');
yMap.set('field', 'value');
yMap.get('field');

// Y.XmlFragment (for ProseMirror)
const fragment = ydoc.getXmlFragment('prosemirror');
// Modified via y-prosemirror plugin
```

### UI Localization

UI strings are localized via [src/strings.ts](src/strings.ts) and [src/useLocale.ts](src/useLocale.ts):

- **Supported locales**: `en`, `fr`, `ht`, `es` — defined in `SupportedLocale` and `SUPPORTED_LOCALES`
- **Adding strings**: Add to `AppStrings` interface, then add values for all four locales in the `strings` record
- **Using strings in components**: Call `useStrings()` directly inside the component — do not pass strings as props
- **Locale resolution**: URL `?locale=` param takes priority, then `navigator.languages`, then defaults to `en`
- **`LANGUAGE_BCP47`**: Maps translation language names (e.g. `'French'`) to BCP 47 codes — separate from UI locale

### Translation Cache Keys

Translation cache keys combine language and content ([translationUtils.ts:106-110](translationUtils.ts#L106-L110)):
```typescript
translationCacheKey(language, chunkText) // Returns "{language}:{chunkText}"
```

### Component Testing Pattern

The codebase favors **separating pure components from Yjs concerns** to enable comprehensive testing:

**Pattern**:
1. **Pure component**: Accepts plain props (`lines: string[]`), no Yjs dependencies
2. **Container component**: Connects to Yjs and passes props to pure component
3. **Tests**: Focus on pure component with mock data

**Benefits**:
- Components testable without Yjs setup
- Clear separation of concerns
- Easy to reason about component behavior
- Fast test execution

**Example**: `TranslatedTextViewer` (pure) + `TranslatedTextViewerContainer` (Yjs connector)

```typescript
// Pure component - easy to test
function TranslatedTextViewer({ lines, language }: Props) {
  // All logic works with plain arrays
}

// Container - handles Yjs
function TranslatedTextViewerContainer({ language }: ContainerProps) {
  const lines = useYText(...); // Get data from Yjs
  return <TranslatedTextViewer lines={lines} language={language} />;
}
```

### Testing Philosophy

- **Unit tests for pure logic**: Test utility functions and pure components in isolation
- **Component tests with React Testing Library**: Test user interactions and state changes
- **Keep tests simple**: Each test should verify one clear behavior
- **Test edge cases**: Empty arrays, null values, boundary conditions
- **Use descriptive test names**: "should play next line when current line finishes" not "test case 5"
- **Mock external dependencies**: Use fake Audio API, mock fetch calls

**Examples**:
- [useTTS.test.ts](src/useTTS.test.ts) - Low-level hook tests (race conditions, callbacks, error handling)
- [TranslatedTextViewer.test.tsx](src/TranslatedTextViewer.test.tsx) - Component tests (playhead, auto-play, user interactions)
- [blockTypes.test.ts](src/blockTypes.test.ts) - Pure utility function tests

**Test Infrastructure**:
- Vitest for test runner
- @testing-library/react for component testing
- Global Audio mock in [test/setup.ts](src/test/setup.ts)