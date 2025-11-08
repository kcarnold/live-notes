import React, { useRef, useState, useCallback, useEffect, useEffectEvent } from 'react';
import { useScrollToBottom } from './reactUtils';
import { Remark } from 'react-remark';
import { useTTS } from './useTTS';

interface TranslatedTextViewerProps {
  /** Lines of text to display (non-empty lines only) */
  lines: string[];
  /** Language for TTS (determines if TTS is enabled) */
  language: string;
  /** Optional font size override */
  fontSize?: number;
  /** Optional header controls to display */
  headerControls?: React.ReactNode;
}

/**
 * TranslatedTextViewer component.
 *
 * Displays translated text with optional text-to-speech functionality.
 *
 * TTS Features:
 * - Manual mode: Click any line to speak it
 * - Auto mode: Automatically plays lines sequentially using a playhead cursor
 * - Toggle between modes with the Auto-Speak button
 */
const TranslatedTextViewer: React.FC<TranslatedTextViewerProps> = ({
  lines,
  language,
  fontSize,
  headerControls
}) => {
  const translatedTextEndRef = useRef<HTMLDivElement | null>(null);
  useScrollToBottom(translatedTextEndRef, [lines], true);

  const isTTSEnabled = language === 'French' || language === 'Spanish';

  // Auto-speak state
  const [autoSpeakEnabled, setAutoSpeakEnabled] = useState(false);

  /**
   * Playhead cursor: index of the last line that finished playing.
   * -1 means we haven't played anything yet.
   * When auto-speak is enabled, we always play lines[playhead + 1] next.
   */
  const [playhead, setPlayhead] = useState(-1);

  // Low-level TTS hook
  const tts = useTTS({
    onFinished: (text) => {
      // When a line finishes, advance the playhead
      const finishedIndex = lines.indexOf(text);
      if (finishedIndex !== -1) {
        setPlayhead(finishedIndex);
      }
    },
    onError: (error) => {
      console.error('TTS error:', error);
    }
  });

  /**
   * Auto-play logic: play the next line after the playhead.
   * Uses effect event to avoid stale closures.
   */
  const runAutoPlay = useEffectEvent(() => {
    if (!autoSpeakEnabled || !isTTSEnabled || tts.status !== 'idle') {
      return;
    }

    const nextLineIndex = playhead + 1;
    if (nextLineIndex < lines.length) {
      const nextLine = lines[nextLineIndex];
      tts.speak(nextLine, language);
    }
  });

  // Trigger auto-play when conditions change
  useEffect(() => {
    runAutoPlay();
  }, [lines.length, tts.status, autoSpeakEnabled, playhead]);

  // Manual play: click on a line to speak it
  const handleLineClick = useCallback((lineIndex: number) => {
    if (!isTTSEnabled) return;

    const line = lines[lineIndex];

    // If clicking the currently playing line, cancel it
    if (tts.currentText === line) {
      tts.cancel();
      return;
    }

    // Otherwise, speak the clicked line
    // Note: clicking a line doesn't update the playhead - only onFinished does
    tts.speak(line, language);
  }, [isTTSEnabled, language, lines, tts]);

  // Toggle auto-speak mode
  const toggleAutoSpeak = useCallback(() => {
    setAutoSpeakEnabled(prev => !prev);
  }, []);

  return (
    <div className="relative h-full flex flex-col">
      {/* Header with controls */}
      {(headerControls || isTTSEnabled) && (
        <div className="flex items-center gap-2 p-2 border-b border-gray-200 dark:border-gray-700">
          {headerControls}

          {isTTSEnabled && (
            <>
              <button
                type='button'
                aria-label={autoSpeakEnabled ? "Disable auto text-to-speech" : "Enable auto text-to-speech"}
                aria-pressed={autoSpeakEnabled}
                onClick={toggleAutoSpeak}
                className={`
                  px-3 py-1 rounded text-sm font-medium transition-colors
                  ${autoSpeakEnabled
                    ? 'bg-blue-500 text-white hover:bg-blue-600'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                  }
                `}
              >
                {autoSpeakEnabled ? '⏸️ Auto-Speak' : '▶️ Tap to Speak'}
              </button>
              {tts.status === 'error' && (
                <span className="text-sm text-red-600 dark:text-red-400">
                  Error: {tts.errorMessage}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* Translated Text Content */}
      <div
        className="overflow-auto pb-16 max-w-2xl w-full mx-auto flex-1"
        style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
      >
        {lines.map((line, index) => {
          const isPlaying = tts.status === 'playing' && tts.currentText === line;
          const isLoading = tts.status === 'loading' && tts.currentText === line;
          const isPlayhead = index === playhead;

          return (
            <div
              key={index}
              onClick={() => handleLineClick(index)}
              className={`
                cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800
                ${isPlaying ? 'bg-blue-200 dark:bg-blue-800' : ''}
                ${isLoading ? 'tts-loading' : ''}
                ${isPlayhead ? 'border-l-4 border-green-500 dark:border-green-600 pl-2' : ''}
              `}
            >
              <Remark>{line}</Remark>
            </div>
          );
        })}
        <div ref={translatedTextEndRef} />
      </div>
    </div>
  );
};

export default TranslatedTextViewer;
