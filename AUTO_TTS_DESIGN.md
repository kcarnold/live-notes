# Auto-TTS Mode Design Document

## Overview

Add automatic text-to-speech playback mode to the TranslatedTextViewer where new translated text is spoken automatically as it becomes available, with intelligent catch-up logic to handle fast text updates.

## Problem Statement

Currently, TTS requires manual clicks on text blocks. For live translation scenarios, we want:
1. Automatic playback when new translated text arrives
2. A "playback cursor" to track position in case playback falls behind
3. Intelligent catch-up when text arrives faster than speech
4. User control to enable/disable the mode

## Proposed Architecture

### Option A: Reducer-Based State Machine (RECOMMENDED)

**Pros:**
- Clean separation of state logic and side effects
- Highly testable (pure reducer functions)
- Clear state transitions
- Easy to debug with Redux DevTools (if needed)

**Cons:**
- More boilerplate than simple useState
- Slightly more complex for future maintainers unfamiliar with reducers

**Structure:**
```typescript
// autoTTSReducer.ts - Pure state logic (easily testable)
interface AutoTTSState {
  enabled: boolean;
  lastSpokenLineIndex: number;      // Last line fully spoken
  currentlyPlayingIndex: number | null; // Currently playing line (or null)
  playbackStatus: 'idle' | 'loading' | 'playing' | 'error';
  errorMessage?: string;
  catchupThreshold: number;         // How many lines behind before skipping
}

type AutoTTSAction =
  | { type: 'TOGGLE_ENABLED' }
  | { type: 'TEXT_UPDATED'; totalLines: number }
  | { type: 'START_LOADING'; lineIndex: number }
  | { type: 'START_PLAYING'; lineIndex: number }
  | { type: 'PLAYBACK_ENDED'; lineIndex: number }
  | { type: 'PLAYBACK_ERROR'; error: string; lineIndex: number }
  | { type: 'SET_CATCHUP_THRESHOLD'; threshold: number };

function autoTTSReducer(state: AutoTTSState, action: AutoTTSAction): AutoTTSState;

// useAutoTTS.ts - React hook wrapping the reducer
function useAutoTTS(lines: string[], language: string, isTTSEnabled: boolean) {
  const [state, dispatch] = useReducer(autoTTSReducer, initialState);

  // Side effects (audio playback) in useEffect
  // Returns controls and state for UI
}
```

### Option B: Simple useState with Refs

**Pros:**
- Less code
- More familiar to most React developers
- Faster to implement

**Cons:**
- Harder to test (tightly coupled with React)
- State logic mixed with side effects
- Harder to trace bugs

**Structure:**
```typescript
function useAutoTTS(lines: string[], language: string) {
  const [enabled, setEnabled] = useState(false);
  const [lastSpokenIndex, setLastSpokenIndex] = useState(-1);
  const playbackRef = useRef({ isPlaying: false, currentIndex: null });

  // All logic in useEffect hooks
}
```

### Option C: State Machine Library (e.g., XState)

**Pros:**
- Formal state machine guarantees
- Excellent visualization tools
- Prevents impossible states

**Cons:**
- Additional dependency
- Overkill for this use case
- Steeper learning curve

## Recommended: Option A (Reducer-Based)

Use a reducer for state management with side effects in hooks. This provides the best balance of testability, clarity, and simplicity.

## State Machine Design

### States

```
┌─────────────────────────────────────────────────────────┐
│ AUTO-TTS STATE MACHINE                                  │
└─────────────────────────────────────────────────────────┘

State: { enabled: boolean, playbackStatus, lastSpokenLineIndex, currentlyPlayingIndex }

playbackStatus ∈ { 'idle', 'loading', 'playing', 'error' }

                    ┌──────────────┐
                    │   DISABLED   │
                    │ enabled=false│
                    └──────┬───────┘
                           │ TOGGLE_ENABLED
                           ▼
                    ┌──────────────┐
              ┌────▶│     IDLE     │◀────┐
              │     │ enabled=true │     │
              │     │ status=idle  │     │
              │     └──────┬───────┘     │
              │            │             │
              │            │ New text    │ PLAYBACK_ENDED
              │            │ available   │ (no more lines)
              │            ▼             │
              │     ┌──────────────┐     │
              │     │   LOADING    │     │
              │     │status=loading│     │
              │     └──────┬───────┘     │
              │            │             │
              │            │ Audio ready │
              │            ▼             │
              │     ┌──────────────┐     │
              └─────│   PLAYING    │─────┘
       Error        │status=playing│     PLAYBACK_ENDED
                    └──────┬───────┘     (more lines)
                           │              ▼
                           │         ┌────────┐
                           │         │Continue│
                           │         │ loop   │
                           │         └────────┘
                           │ TOGGLE_ENABLED
                           ▼
                    ┌──────────────┐
                    │   DISABLED   │
                    └──────────────┘
```

### State Transitions

| Current State | Action | Next State | Side Effect |
|--------------|--------|------------|-------------|
| enabled=false | TOGGLE_ENABLED | enabled=true, idle | - |
| enabled=true, idle | TEXT_UPDATED (new lines) | loading | Fetch audio for next line |
| loading | START_PLAYING | playing | Start audio playback |
| playing | PLAYBACK_ENDED (more lines) | loading | Fetch next line audio |
| playing | PLAYBACK_ENDED (no more) | idle | - |
| any | TOGGLE_ENABLED | enabled=false, idle | Stop current playback |
| loading/playing | PLAYBACK_ERROR | error | Show error state |

### Catchup Logic

When `PLAYBACK_ENDED` or `TEXT_UPDATED` occurs:

```typescript
const backlog = totalLines - (lastSpokenLineIndex + 1);

if (backlog > catchupThreshold) {
  // Skip ahead: jump to (totalLines - catchupThreshold + 1)
  nextLineIndex = totalLines - catchupThreshold + 1;
} else {
  // Play next line sequentially
  nextLineIndex = lastSpokenLineIndex + 1;
}
```

**Example with catchupThreshold = 3:**
- Total lines: 10
- Last spoken: line 3
- Backlog: 10 - 3 - 1 = 6 lines
- 6 > 3, so skip to line: 10 - 3 + 1 = 8
- Speaks lines 8, 9, 10, then goes idle

## UI Controls

### Toggle Button
- Location: Top of TranslatedTextViewer
- States:
  - OFF: Gray button "Enable Auto-TTS"
  - ON: Blue button "Disable Auto-TTS"
  - PLAYING: Green button with speaker icon + progress indicator

### Visual Feedback
- **Currently playing line**: Blue highlight (existing)
- **Loading line**: Pulsing blue (existing)
- **Playback cursor indicator**: Subtle marker showing last spoken position
- **Skipped lines**: Light gray background (optional, to show what was skipped)

### Settings (Optional Future Enhancement)
- Catchup threshold slider (1-10 lines)
- Auto-scroll toggle (follow playback cursor)

## Implementation Plan

### Phase 1: Core State Machine
1. Create `autoTTSReducer.ts` with reducer and types
2. Write unit tests for reducer (using Jest)
3. Test all state transitions and catchup logic

### Phase 2: React Hook
4. Create `useAutoTTS.ts` hook
5. Integrate with audio playback side effects
6. Handle cleanup on unmount/disable

### Phase 3: UI Integration
7. Add toggle button to TranslatedTextViewer
8. Add playback cursor indicator
9. Update styling for visual feedback

### Phase 4: Testing & Refinement
10. Integration tests with React Testing Library
11. Manual testing with various text speeds
12. Tune default catchupThreshold
13. Edge case handling (empty text, language changes, etc.)

## Testing Strategy

### Unit Tests (autoTTSReducer.ts)

```typescript
describe('autoTTSReducer', () => {
  test('enables auto-TTS mode', () => {
    const state = reducer(initialState, { type: 'TOGGLE_ENABLED' });
    expect(state.enabled).toBe(true);
  });

  test('calculates correct next line with catchup', () => {
    const state = {
      enabled: true,
      lastSpokenLineIndex: 2,
      currentlyPlayingIndex: null,
      playbackStatus: 'idle',
      catchupThreshold: 3
    };
    const nextState = reducer(state, {
      type: 'TEXT_UPDATED',
      totalLines: 10
    });
    // Should skip ahead: 10 - 3 + 1 = 8
    expect(nextState.nextLineToPlay).toBe(8);
  });

  test('plays sequentially when not behind', () => {
    const state = {
      enabled: true,
      lastSpokenLineIndex: 7,
      currentlyPlayingIndex: null,
      playbackStatus: 'idle',
      catchupThreshold: 3
    };
    const nextState = reducer(state, {
      type: 'TEXT_UPDATED',
      totalLines: 10
    });
    // Backlog = 2, less than threshold, so play next
    expect(nextState.nextLineToPlay).toBe(8);
  });

  // More tests...
});
```

### Integration Tests (useAutoTTS hook)

```typescript
describe('useAutoTTS', () => {
  beforeEach(() => {
    // Mock fetchAudio
    // Mock Audio API
  });

  test('auto-plays new line when enabled', async () => {
    const { result, rerender } = renderHook(
      ({ lines }) => useAutoTTS(lines, 'French', true),
      { initialProps: { lines: ['Line 1'] } }
    );

    act(() => result.current.enable());

    rerender({ lines: ['Line 1', 'Line 2'] });

    await waitFor(() => {
      expect(mockFetchAudio).toHaveBeenCalledWith('Line 2', 'French');
    });
  });

  // More integration tests...
});
```

## Edge Cases to Handle

1. **Disable while playing**: Stop current audio immediately
2. **Language change**: Reset lastSpokenIndex, stop playback
3. **Text deletion**: Handle lines.length decreasing
4. **Empty text**: Don't attempt playback
5. **Very fast updates**: Ensure we don't queue multiple fetches
6. **Network errors**: Show error state, allow retry
7. **Component unmount**: Clean up audio and refs

## Configuration

### Default Values
```typescript
const AUTO_TTS_DEFAULTS = {
  enabled: false,
  catchupThreshold: 3,  // Skip if more than 3 lines behind
  initialPlaybackIndex: -1,
};
```

### Persistence (Optional)
Store `enabled` state in localStorage per language:
```typescript
localStorage.getItem(`autoTTS.${language}.enabled`)
```

## Performance Considerations

1. **Audio caching**: Leverage existing ElevenLabs cache in server.ts
2. **Debouncing**: Don't trigger on every keystroke, wait for "stable" text
3. **Prefetching**: Optionally pre-fetch next N lines while current plays
4. **Memory**: Clean up Audio objects after playback

## Alternative: Simpler "Auto-Play Latest" Mode

If the full catchup logic seems too complex, a simpler alternative:

**Simple Mode:**
- When enabled, always play the most recent complete line
- No queue, no catchup logic
- Just track "last played line" and play next when audio ends

**Implementation:**
```typescript
useEffect(() => {
  if (enabled && playbackStatus === 'idle' && lines.length > lastSpokenLineIndex + 1) {
    playLine(lines[lastSpokenLineIndex + 1], lastSpokenLineIndex + 1);
  }
}, [enabled, playbackStatus, lines.length]);
```

This is much simpler but provides less sophisticated catch-up behavior.

## Questions for Discussion

1. **Which architecture approach do you prefer?** (Reducer, useState, or XState)
2. **Default catchup threshold?** (I suggest 3 lines)
3. **Should we persist enabled state?** (localStorage)
4. **Visual indicator for skipped lines?** (or just cursor)
5. **Do we want a simple mode first, then enhance?** (or full catchup from start)

## Next Steps

Once you approve the design, I'll:
1. Implement the chosen architecture
2. Write tests alongside implementation
3. Integrate into TranslatedTextViewer
4. Add UI controls
5. Test with various scenarios

---

**Recommendation**: Start with **Option A (Reducer-based)** with **full catchup logic**. It's more code upfront but will be easier to maintain and test. If you prefer to start simpler, we can do the "Simple Mode" first and add catchup later.
