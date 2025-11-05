import React, { useRef, useMemo, useState, useCallback, useEffect, useEffectEvent } from 'react';
import { useScrollToBottom } from './reactUtils';
import { useAsPlainText } from './yjsUtils';
import { Remark } from 'react-remark';
import { translatedTextKeyForLanguage } from './translationUtils';
import { useTTS } from './useTTS';

interface TranslatedTextViewerProps {
  language: string;
  fontSize?: number;
  headerControls?: React.ReactNode;
}

const TranslatedTextViewer: React.FC<TranslatedTextViewerProps> = ({ language, fontSize, headerControls }) => {
  const yJsKey = translatedTextKeyForLanguage(language);
  const [translatedText] = useAsPlainText(yJsKey);
  const translatedTextEndRef = useRef<HTMLDivElement | null>(null);
  useScrollToBottom(translatedTextEndRef, [translatedText], true);

  const lines = useMemo(() => {
    const lines = translatedText ? translatedText.split('\n') : [];
    return lines.filter(line => line.trim() !== '');
  }, [translatedText]);

  const isTTSEnabled = language === 'French' || language === 'Spanish';

  // Auto-speak state
  const [autoSpeakEnabled, setAutoSpeakEnabled] = useState(false);
  const [speechHistory, setSpeechHistory] = useState<string[]>([]);
  const spokenLinesSet = useMemo(() => new Set(speechHistory), [speechHistory]);

  // Low-level TTS hook
  const tts = useTTS({
    onFinished: (text) => {
      // Add to history when finished
      setSpeechHistory(prev => [...prev, text]);
    },
    onError: (error) => {
      console.error('TTS error:', error);
    }
  });

  /**
   * Auto-play logic: find and play the next line after the last spoken one.
   * Uses effect event to avoid stale closures.
   */
  const runAutoPlay = useEffectEvent(() => {
    if (!autoSpeakEnabled || !isTTSEnabled || tts.status !== 'idle') {
      return;
    }

    // Find the last spoken line in the current lines array
    let lastSpokenIndex = -1;
    for (let i = speechHistory.length - 1; i >= 0; i--) {
      const lastSpokenText = speechHistory[i];
      const indexInCurrentLines = lines.lastIndexOf(lastSpokenText);
      if (indexInCurrentLines !== -1) {
        lastSpokenIndex = indexInCurrentLines;
        break;
      }
    }

    // Play the next line after the last spoken one
    const nextLineIndex = lastSpokenIndex + 1;
    if (nextLineIndex < lines.length) {
      const nextLine = lines[nextLineIndex];
      tts.speak(nextLine, language);
    }
  });

  // Trigger auto-play when lines change or when TTS becomes idle
  useEffect(() => {
    runAutoPlay();
  }, [lines, tts.status]);

  // Manual play: click on a line to speak it
  const handleLineClick = useCallback((line: string) => {
    if (!isTTSEnabled) return;

    // If clicking the currently playing line, cancel it
    if (tts.currentText === line) {
      tts.cancel();
      return;
    }

    // Otherwise, speak the clicked line
    tts.speak(line, language);
  }, [isTTSEnabled, language, tts]);

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
          const hasBeenSpoken = spokenLinesSet.has(line);

          return (
            <div
              key={index}
              onClick={() => handleLineClick(line)}
              className={`
                cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800
                ${isPlaying ? 'bg-blue-200 dark:bg-blue-800' : ''}
                ${isLoading ? 'tts-loading' : ''}
                ${hasBeenSpoken ? 'border-l-4 border-amber-200 dark:border-amber-700 pl-2' : ''}
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
