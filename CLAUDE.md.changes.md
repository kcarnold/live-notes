# Suggested CLAUDE.md Updates

## Summary of Changes

Based on implementing the auto-TTS feature, here are the recommended updates to CLAUDE.md:

### 1. **Project Overview**
- ✅ Added: "Text-to-Speech: ElevenLabs for audio playback of translations"

### 2. **Environment Variables**
- ✅ Added: `ELEVENLABS_API_KEY` - Required for TTS functionality
- ✅ Added: `TTS_MAX_CONCURRENT` - Optional concurrency control

### 3. **Testing Commands**
- ✅ Added: Example for running specific test files with `--run` flag

### 4. **New Architecture Section: Auto-TTS System**
Comprehensive documentation including:
- Architecture overview (reducer + hook pattern)
- State machine diagram with all states and tracked fields
- Catchup logic explanation with concrete example
- Handling stale indices problem and solution
- Dual mode behavior (auto vs manual)
- TTS backend details (voice, caching, retry logic)

### 5. **Key Files Section**
- ✅ Reorganized into subsections (Backend, Frontend Core, Components, Auto-TTS System)
- ✅ Added auto-TTS files:
  - `autoTTSReducer.ts` - Pure state machine logic
  - `autoTTSReducer.test.ts` - 23 unit tests
  - `useAutoTTS.ts` - React hook wrapper
- ✅ Updated `TranslatedTextViewer.tsx` description to mention TTS controls
- ✅ Updated `server.ts` description to mention TTS endpoint

### 6. **New Pattern: Reducer-Based State Management**
Documents when and how to use reducers:
- Benefits (testability, explicitness, type safety)
- Code structure template
- Reference to auto-TTS as example

### 7. **New Pattern: Handling Array Indices with Live Updates**
Addresses the stale index problem:
- Problem description with example
- Solution pattern (track both content and index)
- When to use this pattern
- Note about future Yjs-based solution

### 8. **New Pattern: Testing Philosophy**
Based on our testing approach:
- Unit tests for pure logic
- Integration tests for hooks
- Guidelines for writing clear tests
- Reference to autoTTSReducer tests as example

### 9. **Editor vs Viewer Mode**
- ✅ Added: "Can use TTS (auto or manual mode)" to Viewer mode

## Why These Changes Matter

### For Future Development
1. **Reducer pattern** is now established as a best practice for complex state
2. **Stale index handling** pattern prevents a common bug class
3. **Testing philosophy** guides quality standards

### For Code Comprehension
1. Auto-TTS architecture is fully documented
2. State machine behavior is explicit
3. Design decisions are explained (e.g., why hybrid approach for indices)

### For Onboarding
1. New developers understand the TTS system
2. Patterns can be applied to new features
3. Testing expectations are clear

## How to Apply

1. **Review** the suggested file at `CLAUDE.md.suggested`
2. **Compare** with current `CLAUDE.md`
3. **Replace** if approved:
   ```bash
   mv CLAUDE.md.suggested CLAUDE.md
   git add CLAUDE.md
   git commit -m "Update CLAUDE.md with auto-TTS documentation and patterns"
   ```

## Optional: Keep Design Doc

The detailed design document `AUTO_TTS_DESIGN.md` contains:
- Multiple architecture options considered
- Detailed state diagrams
- Extended testing strategy
- Configuration options

Consider whether to:
- **Keep it**: Useful reference for major design decisions
- **Remove it**: Now redundant with CLAUDE.md updates
- **Move it**: Archive in a `/docs` directory
