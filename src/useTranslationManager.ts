import { useCallback, useState } from 'react';
import { useMap, useYDoc } from '@y-sweet/react';
import { setYTextFromString } from './yjsUtils';
import type { GenericMap, TranslationBlock, TranslationCache } from './translationUtils';
import { getUpdatedTranslationFromBlocks, translatedTextKeyForLanguage } from './translationUtils';

export function useTranslationManager({
  languages,
  sourceBlocksRef,
  translationCacheName
}: {
  languages: readonly string[];
  sourceBlocksRef: React.RefObject<TranslationBlock[]>;
  translationCacheName: string;
}) {
  const ydoc = useYDoc();
  const translationCache = useMap(translationCacheName);
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationError, setTranslationError] = useState("");

  const doTranslations = useCallback(async () => {
    const blocks = sourceBlocksRef.current;
    if (!blocks || blocks.length === 0) {
      console.warn("No source blocks available for translation.");
      return;
    }

    async function doTranslation(language: string) {
      const updatedText = await getUpdatedTranslationFromBlocks(
        language,
        blocks,
        translationCache as GenericMap as TranslationCache,
      );
      const key = translatedTextKeyForLanguage(language);
      setYTextFromString(ydoc.getText(key), updatedText);
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
  }, [languages, translationCache, sourceBlocksRef, ydoc]);

  const doResetTranslations = useCallback(() => {
    for (const lang of languages) {
      const key = translatedTextKeyForLanguage(lang);
      const text = ydoc.getText(key);
      if (text) {
        text.delete(0, text.length);
      }
    }
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
