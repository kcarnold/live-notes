# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **live translation application** for presentations/talks. It provides real-time speech transcription and AI-powered translation into multiple languages, displayed in configurable layouts. The system uses:

- **Real-time collaboration**: Y-Sweet/Yjs for shared state across viewers
- **Speech transcription**: AssemblyAI for live speech-to-text
- **Translation**: Google Gemini for AI-powered translation
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
- `ASSEMBLYAI_API_KEY` - AssemblyAI API key

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
   - `translatedText-{language}` (Y.Text): Translated output for each language
   - `meta` (Y.Map): Metadata like video visibility settings
   - `notesTranslationCache` (Y.Map): Translation cache to avoid re-translating unchanged text

### Translation Pipeline

The translation system is sophisticated with caching and incremental updates:

1. **Chunking** ([translationUtils.ts:53-90](translationUtils.ts#L53-L90)): Source text is split into chunks (lines), with whitespace handling
2. **Decomposition** ([translationUtils.ts:30-42](translationUtils.ts#L30-L42)): Each chunk is decomposed into `format` (markdown syntax), `content`, and `trailingWhitespace`
3. **Cache lookup** ([translationUtils.ts:112-164](translationUtils.ts#L112-L164)): Check which chunks need translation using `translationCache`
4. **Context provision**: Untranslated chunks get 3 lines of context from already-translated chunks
5. **Batch translation** ([server.ts:76-90](server.ts#L76-L90)): Server endpoint processes batches via Gemini
6. **Cache update** ([translationUtils.ts:166-185](translationUtils.ts#L166-L185)): New translations are cached in the shared Y.Map
7. **Reconstruction** ([translationUtils.ts:187-204](translationUtils.ts#L187-L204)): Final text is reassembled from cached translations with original formatting

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

## Key Files

- [server.ts](server.ts) - Express backend with Y-Sweet auth and translation API
- [nlp.ts](nlp.ts) - Gemini API integration for translation
- [App.tsx](src/App.tsx) - Main React app with routing and layout system
- [ProseMirrorEditor.tsx](src/ProseMirrorEditor.tsx) - Collaborative rich text editor
- [translationUtils.ts](src/translationUtils.ts) - Translation pipeline logic (chunking, caching, reconstruction)
- [SourceTextTranslationManager.tsx](src/SourceTextTranslationManager.tsx) - Source text editor with translation controls
- [TranslatedTextViewer.tsx](src/TranslatedTextViewer.tsx) - Markdown renderer for translated output
- [SpeechTranscriber.tsx](src/SpeechTranscriber.tsx) - AssemblyAI integration for live transcription

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

### Translation Cache Keys

Translation cache keys combine language and content ([translationUtils.ts:106-110](translationUtils.ts#L106-L110)):
```typescript
translationCacheKey(language, chunkText) // Returns "{language}:{chunkText}"
```
