import { useCallback, useState } from 'react';
import { useYDoc } from '@y-sweet/react';
import * as Y from 'yjs';
import { getUpdatedBlockTranslations } from './translationUtils';
import { yMapToBlock, getBlockTranslationYText, compareBlockPositions, setBlockTranslationSource } from './blockTypes';
import { setYTextFromString } from './yjsUtils';

export function useBlockTranslationManager({
  languages,
}: {
  languages: readonly string[];
}) {
  const ydoc = useYDoc();
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationError, setTranslationError] = useState("");

  const doTranslations = useCallback(async () => {
    const sourceBlocks = ydoc.getArray<Y.Map<any>>("sourceBlocks");

    async function doTranslation(language: string) {
      // Convert Yjs blocks to translation input, sorted by position
      const blocks = sourceBlocks
        .toArray()
        .map((yMap: Y.Map<any>) => yMapToBlock(yMap))
        .sort(compareBlockPositions)
        .filter((block) => block.content.trim() !== '')
        .map((block) => ({
          blockId: block.id,
          content: block.content,
          existingTranslation: block.translations[language],
          translationSource: block.translationSources[language], // Pass source snapshot
        }));

      if (blocks.length === 0) {
        console.warn("No blocks available for translation.");
        return;
      }

      const translations = await getUpdatedBlockTranslations(language, blocks);

      // Update each block's translation AND source snapshot in its yMap
      ydoc.transact(() => {
        sourceBlocks.forEach((yMap: Y.Map<any>) => {
          const blockId = yMap.get('id') as string;
          const translatedText = translations.get(blockId);
          if (translatedText !== undefined) {
            // Get current content from the yMap
            const contentYText = yMap.get('content') as Y.Text;
            // eslint-disable-next-line @typescript-eslint/no-base-to-string
            const currentContent = contentYText ? contentYText.toString() : '';

            // Store the translation
            const translationYText = getBlockTranslationYText(yMap, language);
            setYTextFromString(translationYText, translatedText);

            // Store the source snapshot (what content was translated)
            setBlockTranslationSource(yMap, language, currentContent);
          }
        });
      });
    }

    setIsTranslating(true);
    setTranslationError("");

    try {
      await Promise.all(languages.map(language => doTranslation(language)));
    } catch (error) {
      console.error("Error during translation:", error);
      setTranslationError(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setIsTranslating(false);
    }
  }, [languages, ydoc]);

  const doResetTranslations = useCallback(() => {
    const sourceBlocks = ydoc.getArray<Y.Map<any>>("sourceBlocks");

    ydoc.transact(() => {
      sourceBlocks.forEach((yMap: Y.Map<any>) => {
        for (const lang of languages) {
          // Delete translation
          const translationKey = `translation-${lang}`;
          if (yMap.has(translationKey)) {
            yMap.delete(translationKey);
          }
          // Delete source snapshot
          const sourceKey = `translationSource-${lang}`;
          if (yMap.has(sourceKey)) {
            yMap.delete(sourceKey);
          }
        }
      });
    });

    setTranslationError("");
  }, [languages, ydoc]);

  return {
    isTranslating,
    translationError,
    doTranslations,
    doResetTranslations,
    setTranslationError,
  };
}
