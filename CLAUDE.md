# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **live translation application** for presentations/talks. It provides AI-powered translation into multiple languages, displayed in configurable layouts. The system uses:

- **Real-time collaboration**: Y-Sweet/Yjs for shared state across viewers
- **Translation**: Google Gemini for AI-powered translation
- **Text-to-Speech**: ElevenLabs for audio playback of translations
- **Proclaim integration**: Python service syncing Proclaim presentation slides to Yjs
- **Frontend**: React + TypeScript + Vite + Tailwind CSS
- **Backend**: Express server
- **Live speech translation**: LiveKit rooms + Gemini Live ([live-audio/](live-audio/)) — a broadcaster publishes mic audio; per-language translator bots stream it through Gemini Live and publish translated audio + live transcripts
- **macOS Audio Feeder** ([macos-audio-feeder/](macos-audio-feeder/)): a **native Swift/SwiftUI menu-bar app** — the only non-web, non-Python component in the repo. It takes one channel off the sound board and publishes it to the LiveKit room on a schedule, as an unattended alternative to the browser broadcast page. Built and tested with `swift test` / Xcode, **not** `npm test`

**Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the component map (what runs where, who writes what into the shared Yjs doc). [docs/README.md](docs/README.md) is the docs index; [docs/SMOKE_TEST.md](docs/SMOKE_TEST.md) is the manual pre-service smoke checklist — PR descriptions should declare which of its sections they touch.

## Development Commands

### Setup
```bash
# Copy environment template and fill in API keys
cp template-.env .env

# Install dependencies
npm install
```

Required environment variables (`.env`):
- `YSWEET_CONNECTION_STRING` - Y-Sweet connection string
- `GEMINI_API_KEY` - Google Gemini API key
- `ELEVENLABS_API_KEY` - ElevenLabs API key for text-to-speech

Optional environment variables:
- `WRITE_KEYS` - Shared per-device keys authorizing writes (editing, the microphone, the
  model/TTS endpoints). Comma-separated `label:key` or bare `key`. Reading needs no key.
  See [docs/WRITE_KEYS.md](docs/WRITE_KEYS.md).
- `WRITE_AUTH_MODE` - `off` | `observe` | `enforce` (default `observe`; forced to `off` when
  `WRITE_KEYS` is empty). `observe` records every privileged request and allows it anyway —
  the rollout state. `enforce` refuses unauthorized ones.
- `TTS_MAX_CONCURRENT` - Max concurrent TTS requests (default: 2)
- `TTS_RATE_LIMIT_PER_MIN` / `TRANSLATE_RATE_LIMIT_PER_MIN` - Per-caller caps on the two
  endpoints viewers call and a write key can't protect (defaults 600 / 1200; 0 disables).
  Sized to stop a script, not a congregation — see [rateLimit.ts](rateLimit.ts).
- `GEMINI_STRONG_MODEL` - Stronger Gemini model for whole-item slide drafting via `/api/translateItem` (default: `gemini-3.5-flash`)
- `SESSION_TIMEZONE` - IANA zone the congregation keeps (default: the host's zone). The
  server owns "which doc is the current session" for everyone (issue #111), so it reckons
  dates and the 4am pin expiry on this clock — a container's is UTC, which would file a
  Sunday-evening service under Monday. See [docs/CURRENT_SESSION.md](docs/CURRENT_SESSION.md).
- `SESSION_REGISTRY_PATH` - where the pin/proposal state is persisted (default: inside the
  audio-cache dir, so a pin survives a restart mid-service).
- `LIVE_AUDIO_SOURCE_LANGUAGE` - BCP-47 code a session is assumed to be *spoken* in when
  nobody declares one (default `en`). The broadcast pane asks the speaker and publishes their
  answer per session; this is only the fallback, for older clients and the macOS audio feeder.
  However it is resolved, the supervisor mirrors it into the doc's `liveAudioConfig`.
  See [src/liveAudioConfig.ts](src/liveAudioConfig.ts).
- `LIVE_AUDIO_SILENCE_THRESHOLD_DBFS` - dBFS voice bar for the live-audio cost path; a bridge suspends its Gemini session after ~30s below it (`-30` is a guess, never validated against a real room). Unset = off, no suspending. Beware the sign: dBFS is negative, so `0` gates hardest, not least. goaway/reconnect fixes and the always-on default translator are independent of this. See [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).
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

# Run specific test file
npm test -- path/to/test.ts --run

# Lint code
npm run lint

# Type-check without a full production build
npm run typecheck

# Build for production (requires npm install first)
npm run build

# Start production server (serves built files)
npm start
```

**Important**:
- Always run `npm install` before building or testing, especially in fresh environments. The build will fail with module resolution errors if dependencies aren't installed.
- When running tests via tools/agents, use `--no-color` flag to disable ANSI color codes in output.
- The root `tsconfig.json` is a solution-style config (`files: []` + `references`), so plain `tsc --noEmit -p .` silently checks nothing. Use `npm run typecheck` (or `tsc -b`) to actually type-check.

### Swift (macOS Audio Feeder)

[macos-audio-feeder/](macos-audio-feeder/) is a native macOS menu-bar app. **Nothing in the
npm or uv toolchain touches it** — searching only `*.ts`/`*.tsx`/`*.py` will miss it entirely.

```bash
cd macos-audio-feeder
swift test                 # AudioFeederCore: pure logic, fast, no Xcode needed
xcodegen generate          # regenerate AudioFeeder.xcodeproj (source list is captured here,
                           # so re-run after ADDING or REMOVING files)
xcodebuild -project AudioFeeder.xcodeproj -scheme AudioFeederApp build
```

The split is deliberate: `AudioFeederCore` holds pure, dependency-free logic (schedule
decisions, config, level metering, channel extraction, the LiveKit token contract, and the
current-session contract — it asks the server which doc it is in, like everyone else) so it is
covered by `swift test`; `AudioFeederApp` holds everything needing CoreAudio/LiveKit/SwiftUI.
**Put new decision logic in the Core and test it there** — the app half has no test target.
The `.xcodeproj` is generated from `project.yml` and not checked in; that YAML is the
reviewable source of truth.

Read [macos-audio-feeder/NOTEBOOK.md](macos-audio-feeder/NOTEBOOK.md) before touching
packaging, entitlements, or connect/retry logic — it records failures that cost a service
(the App Sandbox blocking WebRTC's UDP sockets, silent disconnects) and the rules they earned.

### Python (Proclaim service)

The Proclaim integration ([proclaim_service.py](proclaim_service.py)) is a standalone Python
program managed with [uv](https://docs.astral.sh/uv/) (see [pyproject.toml](pyproject.toml)).
Always invoke Python through `uv run` so the locked environment (`uv.lock`) is used.

```bash
# Run the service
uv run proclaim_service.py

# Record the live slide-feed snapshot stream for later replay (issue #70)
uv run proclaim_service.py --record recordings/service.jsonl

# Replay a recording against Y-Sweet (fresh doc-test-<epoch> unless a doc id is given)
uv run proclaim_service.py --replay recordings/service.jsonl [--replay-speed 4]

# Run the Python tests (pytest, config in [tool.pytest.ini_options])
uv run pytest

# Run a single test
uv run pytest tests/test_slide_sync_runtime.py::test_reconnects_after_websocket_drop

# Run the `slow` tests too (deselected by default; CI always runs them)
uv run pytest -m slow
```

Tests live in [tests/](tests/), split to match the decoupled modules: `test_slide_feed`,
`test_proclaim_feed`, `test_yjs_publisher`, `test_slide_translator`, `test_slide_sync_runtime`
(connection lifecycle: lazy connect, off-air disconnect, auto-reconnect with backoff, state
re-push), `test_slide_seam` (replayed feed drives the real consumers), `test_slide_replay`
(record → JSONL → replay through the real consumers, driven by the committed synthetic fixture
[tests/fixtures/synthetic_service.jsonl](tests/fixtures/synthetic_service.jsonl); regenerate
with `uv run tests/fixtures/make_synthetic_service.py`), `test_proclaim_lib`,
`test_service_version` (the self-reported version / "update pending" flag),
`test_session_client` (proposing the on-air date and obeying the answer, #111), and
`test_proclaim_launcher` (the auto-update launch wrapper — marked `slow` and deselected
from the default run: it shells out to real git and real subprocess timeouts for ~25s to
cover a file almost no change touches, so run it with `-m slow` when you edit
[proclaim_service_launch.sh](proclaim_service_launch.sh); CI runs it on every push).
The shared fakes for the Proclaim DB, the Y-Sweet websocket, and the Yjs Provider live in
[tests/helpers.py](tests/helpers.py); timing is scaled down by injecting it (constructor args)
so loops run in milliseconds — no real Proclaim or Y-Sweet needed. Async tests run on the
asyncio backend via the `anyio_backend` fixture in [tests/conftest.py](tests/conftest.py),
which also sets `YSWEET_URL` and puts the repo root on `sys.path`. The new library modules are
import-clean (no `YSWEET_URL` needed to import them).

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

### Write Authorization

Shared per-device keys, not user logins ([writeAuth.ts](writeAuth.ts), browser side
[src/writeKey.ts](src/writeKey.ts), Python side [write_key.py](write_key.py)). Viewers need
no key; a key is what buys a *writable* Y-Sweet token, the broadcaster's microphone, and the
endpoints that spend money. Clients present it as `X-Write-Key`. Defaults to `observe` mode,
which records every privileged request and allows it anyway. Full picture:
[docs/WRITE_KEYS.md](docs/WRITE_KEYS.md).

### The Current Session

Which Y-Sweet doc everything reads and writes is a **server-owned fact**, not a formula each
component re-derives ([sessionRegistry.ts](sessionRegistry.ts), routes in
[sessionRoutes.ts](sessionRoutes.ts), browser side [src/getDocId.ts](src/getDocId.ts) +
[src/SessionGate.tsx](src/SessionGate.tsx), Python side [session_client.py](session_client.py)).

Precedence: `?doc=` / explicit `doc_id` override → an operator pin set from `/status` →
the Proclaim service's accepted proposal → the date in `SESSION_TIMEZONE`. The service
*proposes* what is on air and connects to whatever it is told; a show dated before today is
refused (`stale`), which is exactly the failure in #111. Pins lapse at 4am. Nobody keeps a
client-side copy of the date formula — an unreachable server is reported, not guessed
around. Writer sightings (`GET /api/session/writers`, shown on `/status`) make "the service
is down" and "the service is writing to last week's doc" look different.

Full picture: [docs/CURRENT_SESSION.md](docs/CURRENT_SESSION.md).

### Core Collaboration Flow

The app uses **Yjs** for real-time collaborative state management:

1. **Y-Sweet authentication** ([server.ts:90-101](server.ts#L90-L101)): Backend issues read-only or full access tokens based on editor status, gated on a write key (an unauthorized editor request is downgraded to read-only, not refused)
2. **Shared Y.Doc** per session: Each session has a shared Yjs document, identified by the doc
   id the server names (see *The Current Session* above); `?doc=` overrides it
3. **Key shared data structures** (the header comment in [sessionExport.ts](sessionExport.ts) is
   the canonical description — it has to read all of them):
   - `sourceBlocks` (Y.Array of block Y.Maps): the notes being taken
   - `notesTranslationCache` (Y.Map): `${language}:${content}` → translated string, so unchanged
     text is never re-translated
   - `proclaimPresentations` (Y.Map): itemId → `{title, itemId, slides: string[]}`
   - `proclaimServiceOrder` (Y.Map): `order` → itemId[]
   - `proclaimStatus` (Y.Map): current Proclaim status (itemId, slideIndex)
   - `slideTranslations` (Y.Map): `slideTranslationKey(language, text)` → translation entry
   - `liveTranscriptSegments-{code}` (Y.Array): live-speech utterances per language, written by
     the server-side bridge (see [src/transcriptKeys.ts](src/transcriptKeys.ts); older sessions
     have a `liveTranscript-{code}` Y.Text instead)
   - `liveAudioConfig` (Y.Map): `sourceLanguage` — which of those codes is the speaker's own
     words rather than a translation ([src/liveAudioConfig.ts](src/liveAudioConfig.ts))
   - `slideConversations` (Y.Map), `status` (Y.Map): the slide Q&A panel, and per-service status
     reporting (e.g. the Proclaim service's `proclaimService` entry)

   Note the two language namespaces: notes/slides use display names (`French`), live-audio
   transcripts use BCP-47 codes (`fr`).

   **English is not privileged in the live-audio path.** The spoken language is a per-session
   value: the broadcaster declares it in the broadcast pane, which writes it to
   `liveAudioConfig` *and* onto their LiveKit token as the `speaks` attribute (the supervisor
   decides from room presence and can't wait on a doc sync; the doc copy is what viewers and
   exports read later). Everything that used to hard-code `en` follows it — which code the
   input transcript is filed under, what "Original" means in the listen picker, which language
   the always-on bridge translates into (`primaryTargetLanguage`), and which transcript an
   export marks as the source.

### Translation Pipeline

The unit of translation is a **block**, not a line of markdown — everything in
[translationUtils.ts](src/translationUtils.ts) takes `TranslationBlock[]` (`type`, `level`,
`content`), and `fetchAndCacheTranslations` is the entry point ([useTranslationManager.ts](src/useTranslationManager.ts)
drives it). Translation is incremental: only blocks with no cache entry are sent.

1. **Cache lookup** (`getBlockTranslationTodos` / `buildBlockTranslationRequests`): empty blocks are
   dropped, and each block's *trimmed* content is looked up under `${language}:${content}`
2. **Context provision**: up to 3 already-translated blocks before each untranslated run are marked
   as context and sent along, rendered back to markdown (`blockToMarkdownLine`) so the model sees
   the heading/bullet structure
3. **Grouping** (`findContiguousBlocks`): contiguous runs become one `TranslationTodo` per request
4. **Batch translation**: `POST /api/requestTranslatedBlocks` ([server.ts](server.ts)) runs the
   batches through Gemini
5. **Cache update** (`updateTranslationCache`): results are written into the shared
   `notesTranslationCache` Y.Map, so every viewer gets them without re-asking

There is no reassembly step: viewers render per block, looking each one up in the cache
([BilingualBlockViewer.tsx](src/BilingualBlockViewer.tsx)).

### Text-to-Speech (TTS) System

The TTS system provides both manual and automatic text-to-speech playback with a clean separation of concerns:

#### Architecture

The TTS system uses a two-layer architecture that separates "how to speak" from "what to read":

**Layer 1: Low-level audio playback** ([useTTS.ts](src/useTTS.ts))
- Simple hook that manages audio fetching and playback lifecycle
- Handles race conditions (cancel, superseded requests)
- Provides callbacks for completion and errors
- No knowledge of which line to play next - just plays what it's told

**Layer 2: Playback logic** ([BilingualBlockViewer.tsx](src/BilingualBlockViewer.tsx))
- Decides which lines to play and when
- Manages playhead cursor and auto-play mode
- Responds to user interactions (clicks, auto-mode toggle)
- Pure component (accepts `blocks[]` + `translations`), Yjs integration in
  [BilingualBlockViewerContainer.tsx](src/BilingualBlockViewerContainer.tsx)

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

The app includes a **block-based collaborative editor** ([BlockEditor.tsx](src/BlockEditor.tsx)) for managing the source text for the outline:

#### Architecture
- **Yjs-backed blocks**: Each block stored as `Y.Map` in a `Y.Array`
- **Fractional indexing**: Blocks use fractional-index positions for stable ordering
- **Auto-sizing textareas**: Textareas grow/shrink to fit content
- **Parent-child structure**: `BlockEditor` manages state, `BlockItem` components handle individual blocks

#### Block Structure
Blocks live in the `sourceBlocks` Y.Array. Each is a `Y.Map` with ([blockTypes.ts](src/blockTypes.ts)):
- `id`: UUID for stable identity
- `type`: 'heading' | 'bullet' (only two — there is no paragraph type)
- `position`: Fractional-index string for ordering
- `level`: 0-5 (`MAX_INDENT_LEVEL`); on a heading it selects the heading depth, on a bullet the indent
- `content`: Y.Text for collaborative editing (the `Block` interface exposes it as a plain
  string snapshot for rendering)

#### Features
- **Live collaboration**: Multiple users can edit different blocks simultaneously via Yjs
  (each textarea is bound to its Y.Text with `y-textarea`)
- **Markdown serialization**: Blocks convert to markdown — `level + 2` `#`s for headings,
  two-space indentation for bullets
- **Keyboard shortcuts** (all in `handleKeyDown`, [BlockEditor.tsx](src/BlockEditor.tsx)):
  - `Enter`: Split at the cursor into a new block below (a heading splits into a bullet)
  - `Cmd/Ctrl+Enter`: Trigger translation
  - `Backspace` at start: Demote — dedent, then heading→bullet, then delete if empty
  - `#` at start: Promote bullet→heading, or deepen the heading level
  - `Tab` / `Shift-Tab`: Indent / dedent
  - `Cmd/Ctrl+H`: Toggle heading
  - `Cmd/Ctrl+↑` / `Cmd/Ctrl+↓`: Move the block up/down
  - `↑` at start / `↓` at end: Move focus to the previous/next block
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
- `proclaimPresentations` (Y.Map): Maps itemId → `{title, itemId, slides: string[]}`
- `proclaimStatus` (Y.Map): Current status `{itemId, slideIndex}`

#### React Components

- **CurrentSlideViewer** ([src/CurrentSlideViewer.tsx](src/CurrentSlideViewer.tsx)): Pure component displaying current slide with optional context (previous/next slides)
- **CurrentSlideViewerContainer** ([src/CurrentSlideViewer.tsx](src/CurrentSlideViewer.tsx)): Yjs connector that reads presentation data and passes to pure component

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

#### Auto-update on launch

The LaunchAgent runs [proclaim_service_launch.sh](proclaim_service_launch.sh), not `uv run`
directly: each launch fast-forwards the checkout to the release branch (`proclaim-stable`),
`uv sync`s if the SHA moved, then starts the service **unconditionally**. Every update step
is best-effort and timeout-bounded, and a failed dependency sync rolls the checkout back to
the SHA that was running — the invariant is "runs last version", never "doesn't run".
Releasing is `git push origin main:proclaim-stable` (don't move it after Thursday); applying
an update is restarting the service. The service reports its SHA/branch/channel into the
session doc's `status` Y.Map (key `proclaimService`), and the status view flags "update
pending — restart the service" when the channel has moved past it. Install with
`--no-auto-update` (or set `PROCLAIM_AUTO_UPDATE=0` in the plist) to freeze an install.
Details in [PROCLAIM_SERVICE_SETUP.md](PROCLAIM_SERVICE_SETUP.md#automatic-updates).

#### PostHog Config Endpoint

`GET /api/config` on the Express server returns `{ posthogKey, posthogHost }` — used by the install script and any other service that needs to report to the same PostHog project without separately managing the key.

### Layout System

The UI uses a **URL-based layout system** (`PagePart` in [App.tsx](src/App.tsx) resolves each name):

- Layouts are encoded in the URL path: `/sourceText|translatedText-French,currentSlide`
- Format: rows separated by `|`, columns separated by `,`
- Components:
  - `sourceText` — the block editor + translation controls
  - `translatedText-{language}` — translation only
  - `bilingual-{language}` — original + translation
  - `currentSlide`, `slideTranslation-{language}` — the live Proclaim slide, untranslated / translated
  - `slideReview` — pre-service review of slide translations
  - `listen-{bcp47Code}` — live speech translation for a listener (audio + transcript)
  - `broadcast` — the speaker's mic/broadcast pane (editors only)
  - `status` — the service status dashboard
- Note the two namespaces: the text components take a display name (`French`), `listen-` takes a
  BCP-47 code (`fr`) from the larger Gemini Live set ([listenLanguages.ts](src/listenLanguages.ts))
- Language selection in translated views updates the URL dynamically
- Editor mode is triggered by `#editor` hash in URL
- Example with Proclaim: `/translatedText-French,currentSlide` shows translation and current slide side-by-side
- Unknown names render a "Unknown component" card rather than failing the page

### Editor vs Viewer Mode

The app has two modes determined by URL hash (`#editor`):

- **Editor mode** (`#editor`):
  - Can edit source text
  - Can trigger translations
  - Has full Y-Sweet write access

- **Viewer mode** (default):
  - Read-only access to all content
  - Receives real-time updates from editors
  - Read-only Y-Sweet token
  - Can use TTS (auto or manual mode)

## Key Files

### Backend
- [server.ts](server.ts) - Express backend with Y-Sweet auth, translation API, and TTS endpoint
- [sessionRegistry.ts](sessionRegistry.ts) / [sessionRoutes.ts](sessionRoutes.ts) - the
  server-owned current session (#111): pin/proposal/date precedence, 4am expiry, writer sightings
- [nlp.ts](nlp.ts) - Gemini API integration for translation
- Proclaim → Yjs sync (Python), decoupled into a slide feed + consumers:
  - [proclaim_service.py](proclaim_service.py) - thin entrypoint: env/config, telemetry, and wiring
  - [slide_feed.py](slide_feed.py) - the seam: `FeedSnapshot` (serializable), `SlideFeed` Protocol, `SnapshotBus`
  - [proclaim_feed.py](proclaim_feed.py) - `ProclaimClient` + `ProclaimFeed` (the source), emits a snapshot per poll
  - [yjs_publisher.py](yjs_publisher.py) - `YjsSlidePublisher` (client consumer), single-transaction map writes
  - [slide_translator.py](slide_translator.py) - `SlideTranslator` (translation consumer), seeds `slideTranslations`
  - [slide_sync_runtime.py](slide_sync_runtime.py) - `SlideSyncRuntime`: doc lifecycle, connect/reconnect, fan-out
  - [slide_replay.py](slide_replay.py) - record/replay of the `FeedSnapshot` stream (issue #70, Proclaim slice): `RecordingSlideFeed` (`--record`), `ReplaySlideFeed` (`--replay`), `replay_records_through_consumers` (offline replay through the real consumers)
  - [proclaim_lib.py](proclaim_lib.py) - DB access + rich-text/XML slide parsing (unchanged, shared)
  - [session_client.py](session_client.py) - proposes the on-air show's date to the server and
    takes the doc it is given back (#111); the service no longer decides its own doc

### Frontend Core
- [App.tsx](src/App.tsx) - Main React app with routing and layout system
- [translationUtils.ts](src/translationUtils.ts) - Translation pipeline logic (chunking, caching, reconstruction)
- [yjsUtils.ts](src/yjsUtils.ts) - Yjs utility functions and React hooks
- [getDocId.ts](src/getDocId.ts) / [SessionGate.tsx](src/SessionGate.tsx) / [sessionApi.ts](src/sessionApi.ts) -
  resolving the current session before anything mounts, and the `/status` pin controls

### Components
- [BlockEditor.tsx](src/BlockEditor.tsx) - Block-based collaborative editor with Yjs backing
- [blockTypes.ts](src/blockTypes.ts) - Block data structures and utilities
- [SourceTextTranslationManager.tsx](src/SourceTextTranslationManager.tsx) - Source text editor with translation controls
- [BilingualBlockViewer.tsx](src/BilingualBlockViewer.tsx) - The reading view for translated notes: blocks
  with translation (and optionally the original), plus the TTS controls and playhead/auto-play logic
- [BilingualBlockViewerContainer.tsx](src/BilingualBlockViewerContainer.tsx) - Yjs connector for BilingualBlockViewer
- [CurrentSlideViewer.tsx](src/CurrentSlideViewer.tsx) - Proclaim slide viewer with pure component and Yjs container
- [SlideTranslationViewer.tsx](src/SlideTranslationViewer.tsx) - Current slide's translation for a language
- [SlideReview.tsx](src/SlideReview.tsx) / [SlideReviewContainer.tsx](src/SlideReviewContainer.tsx) - Pre-service
  review and editing of slide translations
- [StatusView.tsx](src/StatusView.tsx) / [TranscriptHealth.tsx](src/TranscriptHealth.tsx) - The `/status` dashboard
- [useFitText.ts](src/useFitText.ts) / [SlideText.tsx](src/SlideText.tsx) - Binary-search text fitting for slide display

### Live Audio (LiveKit + Gemini Live)
Lazily imported in [App.tsx](src/App.tsx) so the LiveKit SDK stays out of the main bundle.
- [ListenViewer.tsx](src/ListenViewer.tsx) - Listener pane: opt-in audio, translator-bot lifecycle, status light
- [BroadcastControl.tsx](src/BroadcastControl.tsx) - Speaker pane: mic publishing, level meter, listener dashboard
- [LiveTranscript.tsx](src/LiveTranscript.tsx) - Transcript for one language code, read from Yjs (no LiveKit dependency)
- [transcriptKeys.ts](src/transcriptKeys.ts) / [useTranscriptSegments.ts](src/useTranscriptSegments.ts) - Doc keys and the read hook
- [liveAudioConfig.ts](src/liveAudioConfig.ts) / [useSourceLanguage.ts](src/useSourceLanguage.ts) - The session's spoken language: doc contract and the read hook

### TTS System
- [useTTS.ts](src/useTTS.ts) - Low-level TTS hook managing audio playback lifecycle
- [useTTS.test.ts](src/useTTS.test.ts) - Comprehensive tests for useTTS hook
- [BilingualBlockViewer.test.tsx](src/BilingualBlockViewer.test.tsx) - Component tests for playhead and auto-play

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
```

### UI Localization

UI strings are localized via [src/strings.ts](src/strings.ts) and [src/useLocale.ts](src/useLocale.ts):

- **Supported locales**: `en`, `fr`, `ht`, `es` — defined in `SupportedLocale` and `SUPPORTED_LOCALES`
- **Adding strings**: Add to `AppStrings` interface, then add values for all four locales in the `strings` record
- **Using strings in components**: Call `useStrings()` directly inside the component — do not pass strings as props
- **Locale resolution**: URL `?locale=` param takes priority, then `navigator.languages`, then defaults to `en`
- **`LANGUAGE_BCP47`**: Maps translation language names (e.g. `'French'`) to BCP 47 codes — separate from UI locale

### Translation Cache Keys

Translation cache keys combine language and content ([src/translationUtils.ts](src/translationUtils.ts)):
```typescript
translationCacheKey(language, chunkText) // Returns "{language}:{chunkText}"
```

### Component Testing Pattern

The codebase favors **separating pure components from Yjs concerns** to enable comprehensive testing:

**Pattern**:
1. **Pure component**: Accepts plain props (e.g. `blocks: Block[]`), no Yjs dependencies
2. **Container component**: Connects to Yjs and passes props to pure component
3. **Tests**: Focus on pure component with mock data

**Benefits**:
- Components testable without Yjs setup
- Clear separation of concerns
- Easy to reason about component behavior
- Fast test execution

**Example**: `BilingualBlockViewer` (pure) + `BilingualBlockViewerContainer` (Yjs connector);
`CurrentSlideViewer` and `SlideReview` follow the same split.

```typescript
// Pure component - easy to test
function BilingualBlockViewer({ blocks, translations, language }: Props) {
  // All logic works with plain arrays/maps
}

// Container - handles Yjs: observe the doc, convert to plain data
function BilingualBlockViewerContainer({ language }: ContainerProps) {
  const sourceBlocks = ydoc.getArray<BlockYMap>('sourceBlocks'); // observeDeep -> bump a version
  const translationCache = useMap('notesTranslationCache');      // observe   -> bump a version
  const blocks = /* yMapToBlock + sort by position */;
  const translations = /* Y.Map -> plain Map */;
  return <BilingualBlockViewer blocks={blocks} translations={translations} language={language} />;
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
- [BilingualBlockViewer.test.tsx](src/BilingualBlockViewer.test.tsx) - Component tests (playhead, auto-play, user interactions)
- [blockTypes.test.ts](src/blockTypes.test.ts) - Pure utility function tests

**Test Infrastructure**:
- Vitest for test runner
- @testing-library/react for component testing
- Global Audio mock in [test/setup.ts](src/test/setup.ts)
- [serverBoot.test.ts](serverBoot.test.ts) is the one test that boots the *real*
  [server.ts](server.ts), as a subprocess on a real socket: everything else assembles the
  pieces it wants into a small express app, so nothing else would notice `server.ts` failing
  at import (a new `getEnvOrCrash`, a bad top-level `await`) or middleware registered in the
  wrong order. It runs hermetically — dummy credentials, `LIVEKIT_*` blanked so the live-audio
  supervisor stays off, PostHog pointed at a dead port, state in a temp dir.

## LiveKit

LiveKit is a fast-evolving project. Always refer to the latest documentation. Run `lk docs --help` to see available commands. Key commands: `lk docs overview`, `lk docs search`, `lk docs get-page`, `lk docs code-search`, `lk docs changelog`, `lk docs pricing-info`. Run `lk docs <command> --help` before using a command for the first time. Prefer browsing (`overview`, `get-page`) over search, and `search` over `code-search`, as docs pages provide better context than raw code.
