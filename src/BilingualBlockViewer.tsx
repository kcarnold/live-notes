import type React from 'react';
import { useRef, useState, useCallback, useEffect, useEffectEvent, useMemo } from 'react';
import snarkdown from 'snarkdown';
import type { Block } from './blockTypes';
import { useScrollToBottom } from './reactUtils';
import { useTTS } from './useTTS';
import { useStrings } from './useLocale';

export interface BilingualBlockViewerProps {
  blocks: Block[];
  translations: Map<string, string>;  // cacheKey → translated text
  language: string;
  fontSize?: number;
  headerControls?: React.ReactNode;
}

/**
 * Pure component that renders blocks with both original and translated text.
 *
 * Each block is displayed with:
 * - Original text (dimmer, smaller)
 * - Translated text (prominent)
 *
 * Features:
 * - TTS: Click any block to speak it, or enable auto-speak mode
 * - Markdown rendering
 * - Language selection and font size controls via headerControls
 *
 * Translation lookup uses the same cache key format as the translation pipeline:
 * `${language}:${content}` where content is the text without markdown formatting.
 */
export function BilingualBlockViewer({
  blocks,
  translations,
  language,
  fontSize = 24,
  headerControls,
}: BilingualBlockViewerProps) {
  const s = useStrings();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const contentEndRef = useRef<HTMLDivElement | null>(null);

  // Filter out empty blocks
  const nonEmptyBlocks = useMemo(
    () => blocks.filter(block => block.content.trim() !== ''),
    [blocks]
  );

  // Get translation lines for TTS (just the translated text)
  const translationLines = useMemo(() => {
    return nonEmptyBlocks.map(block => {
      const cacheKey = `${language}:${block.content.trim()}`;
      return translations.get(cacheKey) ?? '';
    }).filter(line => line.trim() !== '');
  }, [nonEmptyBlocks, translations, language]);

  useScrollToBottom(scrollContainerRef, contentEndRef, [nonEmptyBlocks.length, translations.size], true);

  const isTTSEnabled = language === 'French' || language === 'Spanish';

  // Auto-speak state
  const [autoSpeakEnabled, setAutoSpeakEnabled] = useState(false);

  /**
   * Playhead cursor: index of the last block that finished playing.
   * -1 means we haven't played anything yet.
   * When auto-speak is enabled, we always play the next block.
   */
  const [playhead, setPlayhead] = useState(-1);

  // Low-level TTS hook
  const tts = useTTS({
    onFinished: (text) => {
      // When a line finishes, advance the playhead
      const finishedIndex = translationLines.indexOf(text);
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
    if (nextLineIndex < translationLines.length) {
      const nextLine = translationLines[nextLineIndex];
      if (nextLine.trim()) {
        tts.speak(nextLine, language);
      }
    }
  });

  // Trigger auto-play when conditions change
  useEffect(() => {
    void translationLines.length;
    void tts.status;
    void autoSpeakEnabled;
    void playhead;
    runAutoPlay();
  }, [translationLines.length, tts.status, autoSpeakEnabled, playhead]);

  // Manual play: click on a block to speak it
  const handleBlockClick = useCallback((blockIndex: number) => {
    if (!isTTSEnabled) return;

    const block = nonEmptyBlocks[blockIndex];
    const cacheKey = `${language}:${block.content.trim()}`;
    const translation = translations.get(cacheKey);

    if (!translation?.trim()) return;

    // If clicking the currently playing text, cancel it
    if (tts.currentText === translation) {
      tts.cancel();
      return;
    }

    // Otherwise, speak the clicked block's translation
    tts.speak(translation, language);
  }, [isTTSEnabled, language, nonEmptyBlocks, translations, tts]);

  // Toggle auto-speak mode
  const toggleAutoSpeak = useCallback(() => {
    setAutoSpeakEnabled(prev => !prev);
  }, []);

  if (nonEmptyBlocks.length === 0) {
    return (
      <div className="relative h-full flex flex-col">
        {(headerControls || isTTSEnabled) && (
          <div className="flex items-center gap-2 p-2 border-b border-gray-200 dark:border-gray-700">
            {headerControls}
          </div>
        )}
        <div className="p-4 text-gray-500 dark:text-gray-400 italic flex-1">
          {s.noContent}
        </div>
      </div>
    );
  }

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
                aria-label={autoSpeakEnabled ? s.disableAutoTTS : s.enableAutoTTS}
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
                {autoSpeakEnabled ? s.autoSpeak : s.tapToSpeak}
              </button>
              {tts.status === 'error' && (
                <span className="text-sm text-red-600 dark:text-red-400">
                  {s.ttsError}{tts.errorMessage}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* Block Content */}
      <div
        ref={scrollContainerRef}
        className="overflow-auto pb-16 flex-1"
      >
        <div className="flex flex-col gap-1 p-4 max-w-2xl mx-auto p-compact">
          {nonEmptyBlocks.map((block, index) => {
            const cacheKey = `${language}:${block.content.trim()}`;
            const translation = translations.get(cacheKey);
            const isPlaying = tts.status === 'playing' && tts.currentText === translation;
            const isLoading = tts.status === 'loading' && tts.currentText === translation;
            // Find the index in translationLines for playhead comparison
            const translationLineIndex = translation ? translationLines.indexOf(translation) : -1;
            const isPlayhead = translationLineIndex !== -1 && translationLineIndex === playhead;

            if (!translation) {
              return null; // Skip blocks without translation
            }

            return (
              <BlockPair
                key={block.id}
                block={block}
                translation={translation}
                fontSize={fontSize}
                isPlaying={isPlaying}
                isLoading={isLoading}
                isPlayhead={isPlayhead}
                isTTSEnabled={isTTSEnabled}
                onClick={() => handleBlockClick(index)}
              />
            );
          })}
          <div ref={contentEndRef} />
        </div>
      </div>
    </div>
  );
}

interface BlockPairProps {
  block: Block;
  translation: string | undefined;
  fontSize: number;
  isPlaying: boolean;
  isLoading: boolean;
  isPlayhead: boolean;
  isTTSEnabled: boolean;
  onClick: () => void;
}

function BlockPair({
  block,
  translation,
  fontSize,
  isPlaying,
  isLoading,
  isPlayhead,
  isTTSEnabled,
  onClick,
}: BlockPairProps) {
  const s = useStrings();
  // Compute indent based on block level
  const indentClass = block.level > 0 ? `ml-${block.level * 4}` : '';

  // Heading style
  const isHeading = block.type === 'heading';
  const headingClass = isHeading ? 'font-bold' : '';

  // Render markdown to HTML using snarkdown
  const translationHtml = useMemo(() => {
    if (!translation) return null;
    return snarkdown(translation);
  }, [translation]);

  return (
    <div
      onClick={isTTSEnabled ? onClick : undefined}
      className={`
        flex flex-col gap-0 ${indentClass}
        ${isTTSEnabled ? 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : ''}
        ${isPlaying ? 'bg-blue-200 dark:bg-blue-800' : ''}
        ${isLoading ? 'tts-loading' : ''}
        ${isPlayhead ? 'border-l-4 border-green-500 dark:border-green-600 pl-2' : ''}
      `}
    >
      {/* Original text - smaller and dimmer */}
      <div
        className={`text-gray-500 dark:text-gray-400 ${headingClass}`}
        style={{ fontSize: fontSize * 0.6 }}
      >
        {isHeading && <span className="text-gray-400 dark:text-gray-500 mr-1">{'#'.repeat(block.level + 2)}</span>}
        {block.type === 'bullet' && <span className="text-gray-400 dark:text-gray-500 mr-1">•</span>}
        {block.content}
      </div>

      {/* Translated text - prominent, rendered as HTML */}
      <div
        className={`text-gray-900 dark:text-gray-100 ${headingClass} prose dark:prose-invert max-w-none`}
        style={{ fontSize }}
      >
        {translationHtml ? (
          <div dangerouslySetInnerHTML={{ __html: translationHtml }} />
        ) : (
          <span className="text-gray-400 dark:text-gray-500 italic">
            {s.notTranslated}
          </span>
        )}
      </div>
    </div>
  );
}

export default BilingualBlockViewer;
