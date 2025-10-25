import { describe, test, expect } from 'vitest';
import {
  autoTTSReducer,
  initialAutoTTSState,
  calculateNextLine,
  type AutoTTSState,
} from './autoTTSReducer';

describe('calculateNextLine', () => {
  test('returns null when no lines available', () => {
    expect(calculateNextLine(-1, 0, 3)).toBe(null);
  });

  test('returns null when already caught up', () => {
    expect(calculateNextLine(9, 10, 3)).toBe(null);
    expect(calculateNextLine(5, 5, 3)).toBe(null);
  });

  test('plays next line sequentially when backlog is small', () => {
    // lastSpoken: -1, total: 2, threshold: 3
    // Haven't started yet, so always start at 0
    expect(calculateNextLine(-1, 2, 3)).toBe(0);

    // lastSpoken: 7, total: 10, threshold: 3
    // nextSeq: 8, backlog: 10-8 = 2 (less than 3)
    expect(calculateNextLine(7, 10, 3)).toBe(8);

    // lastSpoken: 0, total: 3, threshold: 3
    // nextSeq: 1, backlog: 3-1 = 2 (less than 3)
    expect(calculateNextLine(0, 3, 3)).toBe(1);
  });

  test('skips ahead when backlog exceeds threshold', () => {
    // lastSpoken: 2, total: 10, threshold: 3
    // nextSeq: 3, backlog: 10-3 = 7 (exceeds 3)
    // skipTo: 10-3 = 7
    expect(calculateNextLine(2, 10, 3)).toBe(7);

    // lastSpoken: 3, total: 10, threshold: 2
    // nextSeq: 4, backlog: 10-4 = 6 (exceeds 2)
    // skipTo: 10-2 = 8
    expect(calculateNextLine(3, 10, 2)).toBe(8);
  });

  test('handles edge case where skipTo would be before nextSeq', () => {
    // This shouldn't happen in normal use, but let's ensure it's safe
    // lastSpoken: 5, total: 8, threshold: 10
    // nextSeq: 6, backlog: 8-6 = 2 (doesn't exceed)
    expect(calculateNextLine(5, 8, 10)).toBe(6);
  });
});

describe('autoTTSReducer', () => {
  test('initial state is disabled and idle', () => {
    expect(initialAutoTTSState.enabled).toBe(false);
    expect(initialAutoTTSState.playbackStatus).toBe('idle');
    expect(initialAutoTTSState.lastSpokenLineIndex).toBe(-1);
  });

  test('TOGGLE_ENABLED switches enabled state', () => {
    let state = initialAutoTTSState;

    // Toggle on
    state = autoTTSReducer(state, { type: 'TOGGLE_ENABLED' });
    expect(state.enabled).toBe(true);

    // Toggle off
    state = autoTTSReducer(state, { type: 'TOGGLE_ENABLED' });
    expect(state.enabled).toBe(false);
  });

  test('TOGGLE_ENABLED resets playback state', () => {
    const state: AutoTTSState = {
      ...initialAutoTTSState,
      enabled: true,
      playbackStatus: 'playing',
      currentlyPlayingIndex: 5,
      errorMessage: 'Some error',
    };

    const newState = autoTTSReducer(state, { type: 'TOGGLE_ENABLED' });
    expect(newState.playbackStatus).toBe('idle');
    expect(newState.currentlyPlayingIndex).toBe(null);
    expect(newState.errorMessage).toBeUndefined();
  });

  test('SET_ENABLED sets enabled state', () => {
    let state = initialAutoTTSState;

    state = autoTTSReducer(state, { type: 'SET_ENABLED', enabled: true });
    expect(state.enabled).toBe(true);

    state = autoTTSReducer(state, { type: 'SET_ENABLED', enabled: false });
    expect(state.enabled).toBe(false);
  });

  test('SET_ENABLED to false resets playback', () => {
    const state: AutoTTSState = {
      ...initialAutoTTSState,
      enabled: true,
      playbackStatus: 'playing',
      currentlyPlayingIndex: 3,
    };

    const newState = autoTTSReducer(state, { type: 'SET_ENABLED', enabled: false });
    expect(newState.playbackStatus).toBe('idle');
    expect(newState.currentlyPlayingIndex).toBe(null);
  });

  test('START_LOADING sets loading state', () => {
    const state = autoTTSReducer(initialAutoTTSState, {
      type: 'START_LOADING',
      lineIndex: 5,
      text: 'Test line',
    });

    expect(state.playbackStatus).toBe('loading');
    expect(state.currentlyPlayingIndex).toBe(5);
    expect(state.currentlyPlayingText).toBe('Test line');
    expect(state.errorMessage).toBeUndefined();
  });

  test('START_PLAYING sets playing state', () => {
    const state = autoTTSReducer(initialAutoTTSState, {
      type: 'START_PLAYING',
      lineIndex: 3,
      text: 'Another test line',
    });

    expect(state.playbackStatus).toBe('playing');
    expect(state.currentlyPlayingIndex).toBe(3);
    expect(state.currentlyPlayingText).toBe('Another test line');
  });

  test('PLAYBACK_ENDED updates lastSpokenLineIndex and resets to idle', () => {
    const state = autoTTSReducer(
      {
        ...initialAutoTTSState,
        playbackStatus: 'playing',
        currentlyPlayingIndex: 5,
        currentlyPlayingText: 'Test text',
      },
      { type: 'PLAYBACK_ENDED', lineIndex: 5 }
    );

    expect(state.playbackStatus).toBe('idle');
    expect(state.lastSpokenLineIndex).toBe(5);
    expect(state.currentlyPlayingIndex).toBe(null);
    expect(state.currentlyPlayingText).toBeUndefined();
  });

  test('PLAYBACK_ERROR sets error state', () => {
    const state = autoTTSReducer(
      {
        ...initialAutoTTSState,
        playbackStatus: 'playing',
        currentlyPlayingIndex: 3,
        currentlyPlayingText: 'Error text',
      },
      { type: 'PLAYBACK_ERROR', error: 'Network error', lineIndex: 3 }
    );

    expect(state.playbackStatus).toBe('error');
    expect(state.errorMessage).toBe('Network error');
    expect(state.currentlyPlayingIndex).toBe(null);
    expect(state.currentlyPlayingText).toBeUndefined();
  });

  test('SET_CATCHUP_THRESHOLD updates threshold', () => {
    const state = autoTTSReducer(initialAutoTTSState, {
      type: 'SET_CATCHUP_THRESHOLD',
      threshold: 5,
    });

    expect(state.catchupThreshold).toBe(5);
  });

  test('SET_CATCHUP_THRESHOLD enforces minimum of 1', () => {
    const state = autoTTSReducer(initialAutoTTSState, {
      type: 'SET_CATCHUP_THRESHOLD',
      threshold: 0,
    });

    expect(state.catchupThreshold).toBe(1);
  });

  test('RESET resets state but preserves enabled and threshold', () => {
    const state: AutoTTSState = {
      enabled: true,
      lastSpokenLineIndex: 5,
      currentlyPlayingIndex: 3,
      playbackStatus: 'playing',
      catchupThreshold: 5,
    };

    const resetState = autoTTSReducer(state, { type: 'RESET' });

    expect(resetState.enabled).toBe(true); // preserved
    expect(resetState.catchupThreshold).toBe(5); // preserved
    expect(resetState.lastSpokenLineIndex).toBe(-1); // reset
    expect(resetState.currentlyPlayingIndex).toBe(null); // reset
    expect(resetState.playbackStatus).toBe('idle'); // reset
  });

  test('TEXT_UPDATED does not change state directly', () => {
    const state = initialAutoTTSState;
    const newState = autoTTSReducer(state, { type: 'TEXT_UPDATED', totalLines: 10 });

    expect(newState).toEqual(state);
  });
});

describe('Integration scenarios', () => {
  test('complete auto-play sequence', () => {
    let state = initialAutoTTSState;

    // Enable auto-TTS
    state = autoTTSReducer(state, { type: 'SET_ENABLED', enabled: true });
    expect(state.enabled).toBe(true);

    // Start loading first line
    state = autoTTSReducer(state, { type: 'START_LOADING', lineIndex: 0, text: 'First line' });
    expect(state.playbackStatus).toBe('loading');

    // Start playing
    state = autoTTSReducer(state, { type: 'START_PLAYING', lineIndex: 0, text: 'First line' });
    expect(state.playbackStatus).toBe('playing');
    expect(state.currentlyPlayingIndex).toBe(0);
    expect(state.currentlyPlayingText).toBe('First line');

    // Playback ends
    state = autoTTSReducer(state, { type: 'PLAYBACK_ENDED', lineIndex: 0 });
    expect(state.playbackStatus).toBe('idle');
    expect(state.lastSpokenLineIndex).toBe(0);
    expect(state.currentlyPlayingText).toBeUndefined();

    // With only 3 lines, next should be sequential (backlog of 2 < threshold of 3)
    const nextLine = calculateNextLine(state.lastSpokenLineIndex, 3, state.catchupThreshold);
    expect(nextLine).toBe(1);
  });

  test('catchup scenario: far behind', () => {
    let state = initialAutoTTSState;

    // Enable and play first few lines
    state = autoTTSReducer(state, { type: 'SET_ENABLED', enabled: true });
    state = autoTTSReducer(state, { type: 'PLAYBACK_ENDED', lineIndex: 2 });

    expect(state.lastSpokenLineIndex).toBe(2);

    // Now we have 10 total lines, we're at line 2
    // backlog = 10 - 3 = 7 (exceeds threshold of 3)
    // Should skip to line 7
    const nextLine = calculateNextLine(state.lastSpokenLineIndex, 10, state.catchupThreshold);
    expect(nextLine).toBe(7);
  });

  test('error recovery', () => {
    let state = initialAutoTTSState;

    state = autoTTSReducer(state, { type: 'SET_ENABLED', enabled: true });
    state = autoTTSReducer(state, { type: 'START_PLAYING', lineIndex: 3, text: 'Error line' });

    // Error occurs
    state = autoTTSReducer(state, {
      type: 'PLAYBACK_ERROR',
      error: 'Network timeout',
      lineIndex: 3,
    });

    expect(state.playbackStatus).toBe('error');
    expect(state.errorMessage).toBe('Network timeout');
    expect(state.currentlyPlayingText).toBeUndefined();

    // Can retry by loading again
    state = autoTTSReducer(state, { type: 'START_LOADING', lineIndex: 3, text: 'Error line' });
    expect(state.playbackStatus).toBe('loading');
    expect(state.errorMessage).toBeUndefined();
  });

  test('tracks text to handle line insertions/deletions', () => {
    let state = initialAutoTTSState;

    // Start playing line at index 5
    state = autoTTSReducer(state, {
      type: 'START_PLAYING',
      lineIndex: 5,
      text: 'Hello world',
    });

    expect(state.currentlyPlayingIndex).toBe(5);
    expect(state.currentlyPlayingText).toBe('Hello world');

    // Simulate playback ending (hook would reconcile the index)
    // If text moved to index 7 due to insertions, the hook would pass lineIndex: 7
    state = autoTTSReducer(state, { type: 'PLAYBACK_ENDED', lineIndex: 7 });

    expect(state.lastSpokenLineIndex).toBe(7); // Reconciled index
    expect(state.currentlyPlayingText).toBeUndefined(); // Cleared after playback
  });

  test('clears playing text on playback end', () => {
    const state = autoTTSReducer(
      {
        ...initialAutoTTSState,
        playbackStatus: 'playing',
        currentlyPlayingIndex: 2,
        currentlyPlayingText: 'Some text',
      },
      { type: 'PLAYBACK_ENDED', lineIndex: 2 }
    );

    expect(state.currentlyPlayingText).toBeUndefined();
  });
});
