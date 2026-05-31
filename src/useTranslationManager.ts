import { useCallback, useState } from 'react';
import { useMap } from '@y-sweet/react';
import type { GenericMap, TranslationBlock, TranslationCache } from './translationUtils';
import { fetchAndCacheTranslations } from './translationUtils';

export function useTranslationManager({
  languages,
  sourceBlocksRef,
  translationCacheName
}: {
  languages: readonly string[];
  sourceBlocksRef: React.RefObject<TranslationBlock[]>;
  translationCacheName: string;
}) {
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
      // Populates translationCache (notesTranslationCache) as a side effect;
      // the returned markdown blob is no longer consumed since viewers read the cache directly.
      await fetchAndCacheTranslations(
        language,
        blocks,
        translationCache as GenericMap as TranslationCache,
      );
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
  }, [languages, translationCache, sourceBlocksRef]);

  const doResetTranslations = useCallback(() => {
    translationCache.clear();
    setTranslationError("");
  }, [translationCache]);

  return {
    isTranslating,
    translationError,
    doTranslations,
    doResetTranslations,
    setTranslationError,
  };
}
