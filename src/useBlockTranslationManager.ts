import { useCallback, useState } from 'react';
import { useMap, useYDoc } from '@y-sweet/react';
import * as Y from 'yjs';
import {
  GenericMap,
  TranslationCache,
  getUpdatedBlockTranslations,
} from './translationUtils';
import { yMapToBlock, getBlockTranslationYText, compareBlockPositions } from './blockTypes';
import { setYTextFromString } from './yjsUtils';

export function useBlockTranslationManager({
  languages,
  translationCacheName,
}: {
  languages: readonly string[];
  translationCacheName: string;
}) {
  const ydoc = useYDoc();
  const translationCache = useMap(translationCacheName);
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationError, setTranslationError] = useState("");

  const doTranslations = useCallback(async () => {
    const sourceBlocks = ydoc.getArray<Y.Map<any>>("sourceBlocks");

    // Convert Yjs blocks to translation input, sorted by position
    const blocks = sourceBlocks
      .toArray()
      .map((yMap: Y.Map<any>) => yMapToBlock(yMap))
      .sort(compareBlockPositions)
      .filter((block) => block.content.trim() !== '')
      .map((block) => ({
        blockId: block.id,
        content: block.content,
      }));

    if (blocks.length === 0) {
      console.warn("No blocks available for translation.");
      return;
    }

    async function doTranslation(language: string) {
      const translations = await getUpdatedBlockTranslations(
        language,
        translationCache as GenericMap as TranslationCache,
        blocks
      );

      // Update each block's translation in its yMap
      ydoc.transact(() => {
        sourceBlocks.forEach((yMap: Y.Map<any>) => {
          const blockId = yMap.get('id') as string;
          const translatedText = translations.get(blockId);
          if (translatedText !== undefined) {
            const translationYText = getBlockTranslationYText(yMap, language);
            setYTextFromString(translationYText, translatedText);
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
  }, [languages, translationCache, ydoc]);

  const doResetTranslations = useCallback(() => {
    const sourceBlocks = ydoc.getArray<Y.Map<any>>("sourceBlocks");

    ydoc.transact(() => {
      sourceBlocks.forEach((yMap: Y.Map<any>) => {
        for (const lang of languages) {
          const key = `translation-${lang}`;
          if (yMap.has(key)) {
            yMap.delete(key);
          }
        }
      });
    });

    translationCache.clear();
    setTranslationError("");
  }, [languages, translationCache, ydoc]);

  return {
    isTranslating,
    translationError,
    doTranslations,
    doResetTranslations,
    setTranslationError,
  };
}
