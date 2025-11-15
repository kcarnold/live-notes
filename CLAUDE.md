# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **live translation application** for presentations/talks. It provides real-time speech transcription and AI-powered translation into multiple languages, displayed in configurable layouts. The system uses:

- **Real-time collaboration**: Y-Sweet/Yjs for shared state across viewers
- **Speech transcription**: Web Speech API (browser-native) for live speech-to-text
- **Translation**: Google Gemini for AI-powered translation
- **Text-to-Speech**: ElevenLabs for audio playback of translations
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
- `TTS_MAX_CONCURRENT` - (Optional) Max concurrent TTS requests (default: 2)

### Development
```bash
# Run backend server (port 8000 by default)
npm run dev:server

# Run frontend dev server (in separate terminal)
npm run dev
```

### Testing & Building
```bash
# Run tests
npm test

# Run specific test file
npm test -- path/to/test.ts --run

# Lint code
npm run lint

# Build for production
npm run build

# Start production server (serves built files)
npm start
```

### Deployment
```bash
docker-compose build
docker-compose up -d
```

## Architecture

### Core Collaboration Flow

The app uses **Yjs** for real-time collaborative state management:

1. **Y-Sweet authentication** ([server.ts:62-73](server.ts#L62-L73)): Backend issues read-only or full access tokens based on editor status
2. **Shared Y.Doc** per session: Each session (identified by `?doc=doc-YYYY-MM-DD`) has a shared Yjs document
3. **Key shared data structures**:
   - `transcriptDoc` (XmlFragment): Live transcription from speech
   - `prosemirror` (XmlFragment): User-edited source text for translation
   - `sourceBlocks` (Y.Array<Y.Map>): Structured blocks containing content and translations
   - `meta` (Y.Map): Metadata like video visibility settings

### Block Structure

Each block in `sourceBlocks` is a Y.Map containing:

```typescript
interface Block {
  id: string;              // Unique block identifier
  content: string;         // Source text (Y.Text)
  type: BlockType;         // 'bullet' | 'heading'
  level: number;           // Indentation level (0-based)
  position: string;        // Fractional index for stable ordering
  translations: Record<string, string>;        // language -> translated text (Y.Text stored as `translation-{lang}`)
  translationSources: Record<string, string>;  // language -> source snapshot (stored as `translationSource-{lang}`)
}
```

**Key features**:
- Translations are stored **directly in each block** (no separate documents)
- **Source snapshots** detect when content changes after translation
- Blocks are sorted by `position` using fractional indexing for stable ordering
- All blocks use Y.Text for collaborative editing of content and translations

### Translation Pipeline

The translation system uses a **block-based approach** with staleness detection:

1. **Block collection** ([useBlockTranslationManager.ts](src/useBlockTranslationManager.ts)): Convert Y.Array blocks to translation input, sorted by position
2. **Staleness detection** ([translationUtils.ts:267-292](translationUtils.ts#L267-L292)): Check each block's translation status:
   - No translation exists → needs translation
   - Translation exists but no source snapshot → needs translation (legacy data)
   - Content differs from snapshot → needs re-translation
   - Content matches snapshot → skip (translation is current)
3. **Context provision**: Untranslated blocks get 3 lines of context from already-translated blocks
4. **Batch translation** ([server.ts:76-90](server.ts#L76-L90)): Server endpoint processes batches via Gemini
5. **Atomic storage** ([useBlockTranslationManager.ts:42-60](src/useBlockTranslationManager.ts#L42-L60)): Store translation AND source snapshot together in block's Y.Map

**No cache needed**: Blocks are the single source of truth. Duplicate content may translate multiple times, but API costs are negligible and context differs anyway.

**Migration from old documents**: Documents created before this refactoring may have:
- Old `translatedText-{language}` Y.Text docs (ignored, harmless)
- Blocks without `translationSource` snapshots (treated as stale, will re-translate on first click)

### Auto-TTS System

The auto-TTS system provides automatic text-to-speech playback with intelligent catchup logic:

#### Architecture
- **Reducer-based state machine** ([autoTTSReducer.ts](src/autoTTSReducer.ts)): Pure state logic, easily testable
- **React hook wrapper** ([useAutoTTS.ts](src/useAutoTTS.ts)): Integrates reducer with audio playback side effects
- **ElevenLabs API** ([server.ts](server.ts)): Backend TTS endpoint with caching and retry logic

#### State Machine
```
States: idle | loading | playing | error

Tracks:
- lastSpokenLineIndex: Last line that finished playing
- currentlyPlayingIndex: Currently playing line (or null)
- currentlyPlayingText: Text being played (for handling insertions/deletions)
- playbackStatus: Current state
- enabled: Whether auto-TTS mode is active
```

#### Catchup Logic ([autoTTSReducer.ts:calculateNextLine](src/autoTTSReducer.ts))
When new translated text arrives faster than speech:
1. If we haven't started: always start at line 0
2. Calculate backlog: `totalLines - (lastSpokenIndex + 1)`
3. If backlog > threshold (default: 3): skip ahead to stay current
4. Otherwise: play next line sequentially

Example: If at line 2 with 10 total lines and threshold 3:
- Backlog = 7 lines (exceeds threshold)
- Skip to line 7 (plays last 3 lines: 7, 8, 9)

#### Handling Stale Indices
**Problem**: When lines are inserted/deleted during playback, array indices become stale.

**Solution**: Hybrid approach tracking both text and index ([useAutoTTS.ts](src/useAutoTTS.ts)):
```typescript
audio.onended = () => {
  // Search for the text we just played
  const currentIndex = lines.indexOf(playedText);

  // If found at different index, use new position (handles insertions)
  // If not found, use stored index with bounds check (handles edits)
  const reconciledIndex = currentIndex !== -1
    ? currentIndex
    : Math.min(storedIndex, lines.length - 1);
};
```

This handles the common case (insertions before cursor) correctly while degrading gracefully for edge cases.

**Note**: This is a temporary solution. Future versions will use proper Yjs document structure with stable identifiers instead of array indices.

#### Dual Modes
- **Auto mode ON**: Automatic playback with catchup
- **Auto mode OFF**: Click-to-play any line (existing behavior preserved)

#### TTS Backend
- **Caching**: Audio files cached in `/audio-cache` (MD5 hash keys)
- **Concurrency**: Limited to 2 concurrent requests (configurable)
- **Retry**: Exponential backoff on rate limit errors (429)
- **Deduplication**: In-flight request caching prevents duplicate fetches

### ProseMirror Integration

The app uses ProseMirror for collaborative rich text editing:

- **Yjs binding**: [y-prosemirror](https://github.com/yjs/y-prosemirror) synchronizes ProseMirror state with Y.XmlFragment
- **Markdown serialization** ([ProseMirrorEditor.tsx:74-83](ProseMirrorEditor.tsx#L74-L83)): Content is converted to markdown on every change
- **Custom keybindings** ([ProseMirrorEditor.tsx:54-68](ProseMirrorEditor.tsx#L54-L68)):
  - `Mod-z/y`: Undo/redo (Yjs-aware)
  - `Tab/Shift-Tab`: List item indent/outdent
  - `Mod-Enter`: Trigger translation

### Layout System

The UI uses a **URL-based layout system** ([App.tsx:262-384](App.tsx#L262-L384)):

- Layouts are encoded in the URL path: `/transcript,sourceText|translatedOutline-French,video`
- Format: rows separated by `|`, columns separated by `,`
- Components: `transcript`, `sourceText`, `translatedOutline-{language}`, `video`
- Language selection in translated views updates the URL dynamically
- Editor mode is triggered by `#editor` hash in URL

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

## Key Files

### Backend
- [server.ts](server.ts) - Express backend with Y-Sweet auth, translation API, and TTS endpoint
- [nlp.ts](nlp.ts) - Gemini API integration for translation

### Frontend Core
- [App.tsx](src/App.tsx) - Main React app with routing and layout system
- [ProseMirrorEditor.tsx](src/ProseMirrorEditor.tsx) - Collaborative rich text editor
- [blockTypes.ts](src/blockTypes.ts) - Block data structure and type definitions
- [translationUtils.ts](src/translationUtils.ts) - Translation pipeline logic (block-based and legacy markdown-based functions)
- [yjsUtils.ts](src/yjsUtils.ts) - Yjs utility functions and React hooks

### Components
- [SourceTextTranslationManager.tsx](src/SourceTextTranslationManager.tsx) - Source text editor with translation controls
- [SpeechTranscriber.tsx](src/SpeechTranscriber.tsx) - Web Speech API integration for live transcription
- [BlockEditor.tsx](src/BlockEditor.tsx) - Collaborative block editor with ProseMirror integration
- [BlockViewer.tsx](src/BlockViewer.tsx) - Direct block rendering (headings, bullets) without Markdown parsing
- [TranslatedTextViewer.tsx](src/TranslatedTextViewer.tsx) - Block viewer for translations with TTS controls
- [useBlockTranslationManager.ts](src/useBlockTranslationManager.ts) - React hook for managing block translations

### Auto-TTS System
- [useAutoTTS.ts](src/useAutoTTS.ts) - React hook integrating reducer with audio playback
- [autoTTSReducer.ts](src/autoTTSReducer.ts) - Pure state machine logic for auto-TTS (attempts to be testable, but async functions and extra logic in useAutoTTS add untested edge cases)
- [autoTTSReducer.test.ts](src/autoTTSReducer.test.ts) - Some unit tests, doesn't address effects in the reducer.

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

### Block Translation Updates

When updating block translations, always store both the translation AND the source snapshot atomically:

```typescript
// Store translation
const translationYText = getBlockTranslationYText(yMap, language);
setYTextFromString(translationYText, translatedText);

// Store source snapshot (what content was translated)
setBlockTranslationSource(yMap, language, currentContent);
```

This ensures staleness detection works correctly - if the block content changes later, the system will detect that `content !== translationSource` and re-translate.

### Reducer-Based State Management

For complex state machines, use the reducer pattern to separate pure logic from side effects:

**Benefits**:
- Pure functions are easily testable without React
- State transitions are explicit and traceable
- Impossible states are prevented by TypeScript
- Logic can be understood in isolation

**Structure**:
```typescript
// 1. Define state and actions
interface State { /* ... */ }
type Action = { type: 'ACTION_NAME'; payload?: any } | /* ... */

// 2. Pure reducer function (testable without React)
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'ACTION_NAME': return { ...state, /* updates */ };
    // ...
  }
}

// 3. React hook wrapping reducer + side effects
function useMyFeature() {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    // Side effects based on state
  }, [state.someField]);

  return { state, actions };
}
```

**Example**: Auto-TTS ([autoTTSReducer.ts](src/autoTTSReducer.ts) + [useAutoTTS.ts](src/useAutoTTS.ts))

### Testing Philosophy

- **Unit tests for pure logic**: Test reducers and utility functions in isolation
- **Integration tests for hooks**: Test React hooks with mock dependencies
- **Keep tests simple**: Each test should verify one clear behavior
- **Test edge cases**: Empty arrays, null values, boundary conditions
- **Use descriptive test names**: "handles line insertion during playback" not "test case 5"

**Example**: [autoTTSReducer.test.ts](src/autoTTSReducer.test.ts) - tests covering state transitions, catchup logic, and edge cases

Challenge: logic bleeds into effects, async functions add hidden states.