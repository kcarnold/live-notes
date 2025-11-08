import React, { useRef, useState, useCallback, useEffect, useEffectEvent, useMemo } from 'react';
import { useScrollToBottom } from './reactUtils';
import { useTTS } from './useTTS';
import { Block } from './blockTypes';
import { BlockViewer } from './BlockViewer';

interface TranslatedTextViewerProps {
  /** Blocks to display (should be sorted by position) */
  blocks: Block[];
  /** Language for TTS (determines if TTS is enabled and which translation to show) */
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
 * - Manual mode: Click any block to speak it
 * - Auto mode: Automatically plays blocks sequentially using a playhead cursor
 * - Toggle between modes with the Auto-Speak button
 */
const TranslatedTextViewer: React.FC<TranslatedTextViewerProps> = ({
  blocks,
  language,
  fontSize,
  headerControls
}) => {
  const translatedTextEndRef = useRef<HTMLDivElement | null>(null);

  // Filter to blocks with translations in the target language
  const translatedBlocks = useMemo(() => {
    return blocks.filter(block => {
      const translation = block.translations[language];
      return translation && translation.trim() !== '';
    });
  }, [blocks, language]);

  useScrollToBottom(translatedTextEndRef, [translatedBlocks], true);

  const isTTSEnabled = language === 'French' || language === 'Spanish';

  // Auto-speak state
  const [autoSpeakEnabled, setAutoSpeakEnabled] = useState(false);

  /**
   * Playhead cursor: index of the last block that finished playing.
   * -1 means we haven't played anything yet.
   * When auto-speak is enabled, we always play translatedBlocks[playhead + 1] next.
   */
  const [playhead, setPlayhead] = useState(-1);

  // Low-level TTS hook
  const tts = useTTS({
    onFinished: (text) => {
      // When a block finishes, advance the playhead
      const finishedIndex = translatedBlocks.findIndex(block => {
        const translation = block.translations[language];
        return translation === text;
      });
      if (finishedIndex !== -1) {
        setPlayhead(finishedIndex);
      }
    },
    onError: (error) => {
      console.error('TTS error:', error);
    }
  });

  /**
   * Auto-play logic: play the next block after the playhead.
   * Uses effect event to avoid stale closures.
   */
  const runAutoPlay = useEffectEvent(() => {
    if (!autoSpeakEnabled || !isTTSEnabled || tts.status !== 'idle') {
      return;
    }

    const nextBlockIndex = playhead + 1;
    if (nextBlockIndex < translatedBlocks.length) {
      const nextBlock = translatedBlocks[nextBlockIndex];
      const translation = nextBlock.translations[language];
      if (translation) {
        tts.speak(translation, language);
      }
    }
  });

  // Trigger auto-play when conditions change
  useEffect(() => {
    runAutoPlay();
  }, [translatedBlocks.length, tts.status, autoSpeakEnabled, playhead]);

  // Manual play: click on a block to speak it
  const handleBlockClick = useCallback((block: Block, blockIndex: number) => {
    if (!isTTSEnabled) return;

    const translation = block.translations[language];
    if (!translation) return;

    // If clicking the currently playing block, cancel it
    if (tts.currentText === translation) {
      tts.cancel();
      return;
    }

    // Otherwise, speak the clicked block's translation
    // Note: clicking a block doesn't update the playhead - only onFinished does
    tts.speak(translation, language);
  }, [isTTSEnabled, language, tts]);

  // Toggle auto-speak mode
  const toggleAutoSpeak = useCallback(() => {
    setAutoSpeakEnabled(prev => !prev);
  }, []);

  // Get className for each block based on TTS state
  const getBlockClassName = useCallback((block: Block, index: number) => {
    const translation = block.translations[language];
    const isPlaying = tts.status === 'playing' && tts.currentText === translation;
    const isLoading = tts.status === 'loading' && tts.currentText === translation;
    const isPlayhead = index === playhead;

    return `
      ${isPlaying ? 'bg-blue-200 dark:bg-blue-800' : ''}
      ${isLoading ? 'tts-loading' : ''}
      ${isPlayhead ? 'border-l-4 border-green-500 dark:border-green-600 pl-2' : ''}
    `;
  }, [language, tts.status, tts.currentText, playhead]);

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
      <div className="relative flex-1 overflow-hidden">
        <BlockViewer
          blocks={translatedBlocks}
          language={language}
          fontSize={fontSize}
          onBlockClick={handleBlockClick}
          getBlockClassName={getBlockClassName}
        />
        <div ref={translatedTextEndRef} className="absolute bottom-0" />
      </div>
    </div>
  );
};

export default TranslatedTextViewer;
