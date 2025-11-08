import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * Fetches audio for a given text and language from the TTS API.
 */
async function fetchAudio(text: string, language: string): Promise<string> {
  // Strip markdown, except for a simple emphasis
  // TODO: this doesn't strip all markdown - consider using a proper markdown parser
  let strippedText = text.replace(/^#+ /gm, '').replace(/\*+/g, '*').trim();

  // If text doesn't end with punctuation, add a period to improve TTS intonation
  if (!/[.!?]$/.test(strippedText)) {
    strippedText += '.';
  }

  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: strippedText, language }),
  });

  if (!response.ok) {
    console.error('TTS request failed:', response.statusText);
    throw new Error(`TTS request failed: ${response.statusText}`);
  }

  const data = await response.json() as { audioUrl: string };
  return data.audioUrl;
}

export type TTSStatus = 'idle' | 'loading' | 'playing' | 'error';

export interface TTSState {
  /** The text currently being spoken (null if idle) */
  currentText: string | null;
  /** Current playback status */
  status: TTSStatus;
  /** Error message if status is 'error' */
  errorMessage?: string;
}

export interface UseTTSOptions {
  /** Called when audio finishes playing successfully */
  onFinished?: (text: string) => void;
  /** Called when an error occurs */
  onError?: (error: string, text: string) => void;
}

export interface UseTTSResult extends TTSState {
  /**
   * Speak the given text in the specified language.
   * Cancels any currently playing audio.
   */
  speak: (text: string, language: string) => void;
  /** Cancel current playback */
  cancel: () => void;
}

/**
 * Low-level hook for text-to-speech playback.
 *
 * Manages the audio playback lifecycle:
 * - Fetches audio from TTS API
 * - Plays audio via HTML Audio element
 * - Notifies when finished via callback
 *
 * This hook handles "how to speak" - deciding "what to speak"
 * should be done in a higher-level hook or component.
 */
export function useTTS(options: UseTTSOptions = {}): UseTTSResult {
  const [state, setState] = useState<TTSState>({
    currentText: null,
    status: 'idle',
  });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentRequestRef = useRef<{ text: string; language: string } | null>(null);

  // Use refs for callbacks to avoid stale closures
  const onFinishedRef = useRef(options.onFinished);
  const onErrorRef = useRef(options.onError);

  useEffect(() => {
    onFinishedRef.current = options.onFinished;
    onErrorRef.current = options.onError;
  }, [options.onFinished, options.onError]);

  /**
   * Cancel current playback and reset state.
   */
  const cancel = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    currentRequestRef.current = null;
    setState({ currentText: null, status: 'idle' });
  }, []);

  /**
   * Speak the given text in the specified language.
   */
  const speak = useCallback((text: string, language: string) => {
    if (!text?.trim()) return;

    // Cancel any current playback
    cancel();

    // Track this request
    const request = { text, language };
    currentRequestRef.current = request;

    // Update state to loading
    setState({ currentText: text, status: 'loading' });

    // Fetch and play audio
    fetchAudio(text, language)
      .then((audioUrl) => {
        // Check if this request is still current (not cancelled/superseded)
        if (currentRequestRef.current !== request) {
          return;
        }

        // Create and play audio
        const audio = new Audio(audioUrl);
        audioRef.current = audio;

        audio.addEventListener('ended', () => {
          // Only call callback if this request is still current
          if (currentRequestRef.current === request) {
            setState({ currentText: null, status: 'idle' });
            onFinishedRef.current?.(text);
          }
        });

        audio.addEventListener('error', () => {
          // Only call callback if this request is still current
          if (currentRequestRef.current === request) {
            setState({ currentText: null, status: 'error', errorMessage: 'Audio playback error' });
            onErrorRef.current?.('Audio playback error', text);
          }
        });

        setState({ currentText: text, status: 'playing' });
        void audio.play();
      })
      .catch((error) => {
        // Only handle error if this request is still current
        if (currentRequestRef.current === request) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          setState({ currentText: null, status: 'error', errorMessage: errorMsg });
          onErrorRef.current?.(errorMsg, text);
        }
      });
  }, [cancel]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  return {
    ...state,
    speak,
    cancel,
  };
}
