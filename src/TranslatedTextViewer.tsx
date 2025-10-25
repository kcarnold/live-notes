import React, { useRef, useMemo } from 'react';
import { useScrollToBottom } from './reactUtils';
import { useAsPlainText } from './yjsUtils';
import { Remark } from 'react-remark';
import { translatedTextKeyForLanguage } from './translationUtils';
import { useAutoTTS } from './useAutoTTS';

interface TranslatedTextViewerProps {
  language: string;
  fontSize?: number;
}

const TranslatedTextViewer: React.FC<TranslatedTextViewerProps> = ({ language, fontSize }) => {
  const yJsKey = translatedTextKeyForLanguage(language);
  const [translatedText] = useAsPlainText(yJsKey);
  const translatedTextEndRef = useRef<HTMLDivElement | null>(null);
  useScrollToBottom(translatedTextEndRef, [translatedText], true);

  const lines = useMemo(() => {
    const lines = translatedText ? translatedText.split('\n') : [];
    return lines.filter(line => line.trim() !== '');
  }, [translatedText]);

  const isTTSEnabled = language === 'French' || language === 'Spanish';

  // Use the auto-TTS hook
  const { state: autoTTSState, toggleEnabled, playLine } = useAutoTTS(
    lines,
    language,
    isTTSEnabled
  );

  // Determine which line is currently being played or loaded
  const currentLineText = autoTTSState.currentlyPlayingIndex !== null
    ? lines[autoTTSState.currentlyPlayingIndex]
    : undefined;

  return (
    <div className="relative h-full flex flex-col">
      {/* Auto-TTS Toggle Button */}
      {isTTSEnabled && (
        <div className="flex items-center gap-2 p-2 border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={toggleEnabled}
            className={`
              px-3 py-1 rounded text-sm font-medium transition-colors
              ${autoTTSState.enabled
                ? 'bg-blue-500 text-white hover:bg-blue-600'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
              }
            `}
          >
            {autoTTSState.enabled ? '⏸️ Auto-TTS ON' : '▶️ Auto-TTS OFF'}
          </button>
          {autoTTSState.enabled && autoTTSState.playbackStatus === 'playing' && (
            <span className="text-sm text-gray-600 dark:text-gray-400">
              Speaking line {(autoTTSState.currentlyPlayingIndex ?? 0) + 1} of {lines.length}
            </span>
          )}
          {autoTTSState.playbackStatus === 'error' && (
            <span className="text-sm text-red-600 dark:text-red-400">
              Error: {autoTTSState.errorMessage}
            </span>
          )}
        </div>
      )}

      {/* Translated Text Content */}
      <div
        className="overflow-auto pb-16 max-w-2xl w-full mx-auto flex-1"
        style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
      >
        {lines.map((line, index) => {
          const isPlaying = autoTTSState.playbackStatus === 'playing' && currentLineText === line;
          const isLoading = autoTTSState.playbackStatus === 'loading' && currentLineText === line;
          const isLastSpoken = autoTTSState.lastSpokenLineIndex === index;

          return (
            <p
              key={index}
              onClick={() => {
                if (!autoTTSState.enabled) {
                  void playLine(line);
                }
              }}
              className={`
                ${!autoTTSState.enabled ? 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : ''}
                ${isPlaying ? 'bg-blue-200 dark:bg-blue-800' : ''}
                ${isLoading ? 'tts-loading' : ''}
                ${isLastSpoken && autoTTSState.enabled ? 'border-l-4 border-blue-500 pl-2' : ''}
              `}
            >
              <Remark>{line}</Remark>
            </p>
          );
        })}
        <div ref={translatedTextEndRef} />
      </div>
    </div>
  );
};

export default TranslatedTextViewer;
