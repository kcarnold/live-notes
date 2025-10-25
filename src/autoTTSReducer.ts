/**
 * Auto-TTS State Machine Reducer
 *
 * Manages automatic text-to-speech playback with intelligent catchup logic.
 * When enabled, plays translated lines sequentially, skipping ahead if backlog
 * exceeds the catchup threshold.
 */

export interface AutoTTSState {
  /** Whether auto-TTS mode is enabled */
  enabled: boolean;

  /** Index of the last line that finished playing (-1 if none) */
  lastSpokenLineIndex: number;

  /** Index of the line currently playing (null if idle) */
  currentlyPlayingIndex: number | null;

  /** Text of the line currently playing (used to handle line insertions/deletions) */
  currentlyPlayingText?: string;

  /** Current playback status */
  playbackStatus: 'idle' | 'loading' | 'playing' | 'error';

  /** Error message if playbackStatus is 'error' */
  errorMessage?: string;

  /** How many lines behind before we skip ahead (default: 3) */
  catchupThreshold: number;
}

export type AutoTTSAction =
  | { type: 'TOGGLE_ENABLED' }
  | { type: 'SET_ENABLED'; enabled: boolean }
  | { type: 'TEXT_UPDATED'; totalLines: number }
  | { type: 'START_LOADING'; lineIndex: number; text: string }
  | { type: 'START_PLAYING'; lineIndex: number; text: string }
  | { type: 'PLAYBACK_ENDED'; lineIndex: number }
  | { type: 'PLAYBACK_ERROR'; error: string; lineIndex: number }
  | { type: 'SET_CATCHUP_THRESHOLD'; threshold: number }
  | { type: 'RESET' };

export const initialAutoTTSState: AutoTTSState = {
  enabled: false,
  lastSpokenLineIndex: -1,
  currentlyPlayingIndex: null,
  playbackStatus: 'idle',
  catchupThreshold: 3,
};

/**
 * Calculate the next line to play based on current state and total available lines.
 *
 * Catchup logic:
 * - If we haven't started yet (lastSpokenLineIndex === -1): always start at 0
 * - If backlog > threshold: skip ahead to stay current
 * - Otherwise: play next line sequentially
 *
 * Returns null if there's nothing to play.
 */
export function calculateNextLine(
  lastSpokenLineIndex: number,
  totalLines: number,
  catchupThreshold: number
): number | null {
  // No lines available
  if (totalLines === 0) return null;

  const nextSequentialIndex = lastSpokenLineIndex + 1;

  // Already caught up (no new lines)
  if (nextSequentialIndex >= totalLines) return null;

  // If we haven't started yet, always start from the beginning
  if (lastSpokenLineIndex === -1) return 0;

  // Calculate how many lines we're behind
  const backlog = totalLines - nextSequentialIndex;

  // If backlog exceeds threshold, skip ahead
  if (backlog > catchupThreshold) {
    // Skip to (totalLines - catchupThreshold)
    // Example: 10 total lines, threshold 3 → start at line 7
    // This ensures we speak the last ~threshold lines
    const skipToIndex = totalLines - catchupThreshold;
    return Math.max(nextSequentialIndex, skipToIndex);
  }

  // Otherwise, play sequentially
  return nextSequentialIndex;
}

export function autoTTSReducer(
  state: AutoTTSState,
  action: AutoTTSAction
): AutoTTSState {
  switch (action.type) {
    case 'TOGGLE_ENABLED':
      return {
        ...state,
        enabled: !state.enabled,
        // Reset playback state when toggling
        playbackStatus: 'idle',
        currentlyPlayingIndex: null,
        errorMessage: undefined,
      };

    case 'SET_ENABLED':
      return {
        ...state,
        enabled: action.enabled,
        // Reset playback state when disabling
        playbackStatus: action.enabled ? state.playbackStatus : 'idle',
        currentlyPlayingIndex: action.enabled ? state.currentlyPlayingIndex : null,
        errorMessage: action.enabled ? state.errorMessage : undefined,
      };

    case 'TEXT_UPDATED':
      // Text updates don't change state directly - the hook will use
      // calculateNextLine() to determine if we should start playback
      return state;

    case 'START_LOADING':
      return {
        ...state,
        playbackStatus: 'loading',
        currentlyPlayingIndex: action.lineIndex,
        currentlyPlayingText: action.text,
        errorMessage: undefined,
      };

    case 'START_PLAYING':
      return {
        ...state,
        playbackStatus: 'playing',
        currentlyPlayingIndex: action.lineIndex,
        currentlyPlayingText: action.text,
        errorMessage: undefined,
      };

    case 'PLAYBACK_ENDED':
      return {
        ...state,
        playbackStatus: 'idle',
        lastSpokenLineIndex: action.lineIndex,
        currentlyPlayingIndex: null,
        currentlyPlayingText: undefined,
        errorMessage: undefined,
      };

    case 'PLAYBACK_ERROR':
      return {
        ...state,
        playbackStatus: 'error',
        errorMessage: action.error,
        currentlyPlayingIndex: null,
        currentlyPlayingText: undefined,
      };

    case 'SET_CATCHUP_THRESHOLD':
      return {
        ...state,
        catchupThreshold: Math.max(1, action.threshold),
      };

    case 'RESET':
      return {
        ...initialAutoTTSState,
        enabled: state.enabled, // Preserve enabled state
        catchupThreshold: state.catchupThreshold, // Preserve settings
      };

    default:
      return state;
  }
}
