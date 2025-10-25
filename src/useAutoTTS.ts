import { useReducer, useEffect, useRef, useCallback } from 'react';
import {
  autoTTSReducer,
  initialAutoTTSState,
  calculateNextLine,
  type AutoTTSState,
} from './autoTTSReducer';

/**
 * Fetches audio for a given text and language from the TTS API.
 */
async function fetchAudio(text: string, language: string): Promise<string> {
  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language }),
  });

  if (!response.ok) {
    console.error('TTS request failed:', response.statusText);
    throw new Error(`TTS request failed: ${response.statusText}`);
  }

  const data = await response.json() as { audioUrl: string };
  return data.audioUrl;
}

export interface UseAutoTTSResult {
  /** Current auto-TTS state */
  state: AutoTTSState;

  /** Enable or disable auto-TTS mode */
  setEnabled: (enabled: boolean) => void;

  /** Toggle auto-TTS mode on/off */
  toggleEnabled: () => void;

  /** Manually play a specific line (for manual click-to-play mode) */
  playLine: (text: string) => Promise<void>;

  /** Stop current playback */
  stopPlayback: () => void;
}

/**
 * Hook for managing auto-TTS playback.
 *
 * When enabled, automatically plays new translated lines as they become available,
 * with intelligent catchup logic to skip ahead if falling too far behind.
 *
 * Also supports manual click-to-play when disabled.
 */
export function useAutoTTS(
  lines: string[],
  language: string,
  isTTSEnabled: boolean
): UseAutoTTSResult {
  const [state, dispatch] = useReducer(autoTTSReducer, initialAutoTTSState);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  /**
   * Stop and clean up current audio playback.
   */
  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, []);

  /**
   * Play a specific line by index.
   */
  const playLineByIndex = useCallback(
    async (lineIndex: number) => {
      if (!isTTSEnabled || lineIndex < 0 || lineIndex >= lines.length) return;

      const text = lines[lineIndex];
      if (!text?.trim()) return;

      // Start loading
      dispatch({ type: 'START_LOADING', lineIndex, text });

      let audioUrl: string;
      try {
        audioUrl = await fetchAudio(text, language);
      } catch (error: unknown) {
        console.error('Error fetching TTS audio:', error);
        dispatch({
          type: 'PLAYBACK_ERROR',
          error: error instanceof Error ? error.message : 'Unknown error',
          lineIndex,
        });
        return;
      }

      // Create and configure audio element
      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      audio.onerror = (err: string | Event) => {
        console.error('Audio playback error:', err);
        const errStr = err instanceof Event ? 'Audio playback error' : err.toString();
        dispatch({
          type: 'PLAYBACK_ERROR',
          error: errStr,
          lineIndex,
        });
      };

      audio.onended = () => {
        // Reconcile the index: the text might have moved to a different position
        // due to insertions/deletions while audio was playing
        const currentLines = lines; // Capture current lines at playback end

        // If text at stored index is still the same, the index is valid (common case)
        if (currentLines[lineIndex] === text) {
          dispatch({ type: 'PLAYBACK_ENDED', lineIndex, text });
          return;
        }

        // Text at stored index changed - try to find where it moved
        // Use indexOf, but only reconcile to a LATER index to avoid duplicate line issues
        const foundIndex = currentLines.indexOf(text);
        const reconciledIndex = (foundIndex !== -1 && foundIndex > lineIndex)
          ? foundIndex  // Text moved to later position (insertion before cursor)
          : Math.min(lineIndex, currentLines.length - 1); // Use clamped stored index

        dispatch({ type: 'PLAYBACK_ENDED', lineIndex: reconciledIndex, text });
      };

      // Start playing
      dispatch({ type: 'START_PLAYING', lineIndex, text });
      await audio.play();
    },
    [lines, language, isTTSEnabled]
  );

  /**
   * Manually play a specific line by text (for manual mode).
   */
  const playLine = useCallback(
    async (text: string) => {
      // If already playing the same text, stop it
      if (state.playbackStatus === 'playing' && state.currentlyPlayingIndex !== null) {
        const currentText = lines[state.currentlyPlayingIndex];
        if (currentText === text) {
          stopPlayback();
          dispatch({ type: 'SET_ENABLED', enabled: false }); // Ensure auto mode is off
          return;
        }
        // Different text - stop current and start new
        stopPlayback();
      }

      // Don't start new playback if already loading
      if (state.playbackStatus === 'loading') return;

      // Find the line index
      const lineIndex = lines.indexOf(text);
      if (lineIndex === -1) return;

      // Temporarily disable auto mode for manual playback
      const wasEnabled = state.enabled;
      if (wasEnabled) {
        dispatch({ type: 'SET_ENABLED', enabled: false });
      }

      await playLineByIndex(lineIndex);

      // Re-enable auto mode if it was enabled
      if (wasEnabled) {
        dispatch({ type: 'SET_ENABLED', enabled: true });
      }
    },
    [state, lines, playLineByIndex, stopPlayback]
  );

  /**
   * Toggle auto-TTS mode.
   */
  const toggleEnabled = useCallback(() => {
    stopPlayback();
    dispatch({ type: 'TOGGLE_ENABLED' });
  }, [stopPlayback]);

  /**
   * Set auto-TTS enabled state.
   */
  const setEnabled = useCallback(
    (enabled: boolean) => {
      if (enabled === state.enabled) return;
      stopPlayback();
      dispatch({ type: 'SET_ENABLED', enabled });
    },
    [state.enabled, stopPlayback]
  );

  /**
   * Auto-play effect: When enabled and idle, check if there's a next line to play.
   */
  useEffect(() => {
    // Only auto-play when:
    // 1. Auto mode is enabled
    // 2. TTS is supported for this language
    // 3. We're idle (not currently loading or playing)
    if (!state.enabled || !isTTSEnabled || state.playbackStatus !== 'idle') {
      return;
    }

    // Calculate the next line to play
    const nextLineIndex = calculateNextLine(
      state.lastSpokenLineIndex,
      lines.length,
      state.catchupThreshold
    );

    // If there's a line to play, check if it's actually new content
    if (nextLineIndex !== null) {
      const nextLineText = lines[nextLineIndex];

      // Don't play if it's the same text we just finished speaking
      // (This prevents re-playing when lines are inserted above the cursor)
      if (nextLineText !== state.lastSpokenText) {
        void playLineByIndex(nextLineIndex);
      }
    }
  }, [
    state.enabled,
    state.playbackStatus,
    state.lastSpokenLineIndex,
    state.lastSpokenText,
    state.catchupThreshold,
    lines,
    isTTSEnabled,
    playLineByIndex,
  ]);

  /**
   * Cleanup on unmount.
   */
  useEffect(() => {
    return () => {
      stopPlayback();
    };
  }, [stopPlayback]);

  return {
    state,
    setEnabled,
    toggleEnabled,
    playLine,
    stopPlayback,
  };
}
