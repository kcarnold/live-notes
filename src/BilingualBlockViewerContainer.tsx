import type React from 'react';
import { useEffect, useState, useMemo } from 'react';
import { useYDoc, useMap } from '@y-sweet/react';
import type * as Y from 'yjs';
import { type Block, yMapToBlock, compareBlockPositions } from './blockTypes';
import { BilingualBlockViewer } from './BilingualBlockViewer';

interface BilingualBlockViewerContainerProps {
  language: string;
  fontSize?: number;
  headerControls?: React.ReactNode;
}

/**
 * Container component that connects BilingualBlockViewer to Yjs.
 *
 * Reads:
 * - sourceBlocks Y.Array - the blocks being edited
 * - notesTranslationCache Y.Map - translation cache with keys `${language}:${content}`
 *
 * Sorts blocks using compareBlockPositions for correct ordering.
 */
export function BilingualBlockViewerContainer({
  language,
  fontSize,
  headerControls,
}: BilingualBlockViewerContainerProps) {
  const ydoc = useYDoc();
  const translationCache = useMap('notesTranslationCache');
  const [version, setVersion] = useState(0);

  // Get the sourceBlocks array
  const sourceBlocks = useMemo(
    () => ydoc.getArray<Y.Map<any>>('sourceBlocks'),
    [ydoc]
  );

  // Observe changes to sourceBlocks
  useEffect(() => {
    const observer = () => setVersion(v => v + 1);
    sourceBlocks.observeDeep(observer);
    return () => sourceBlocks.unobserveDeep(observer);
  }, [sourceBlocks]);

  // Observe changes to translation cache
  useEffect(() => {
    const observer = () => setVersion(v => v + 1);
    translationCache.observe(observer);
    return () => translationCache.unobserve(observer);
  }, [translationCache]);

  // Convert Yjs data to props for pure component
  const blocks: Block[] = useMemo(() => {
    void version; // Include version to trigger recompute on changes
    return sourceBlocks
      .toArray()
      .map(yMap => yMapToBlock(yMap))
      .sort(compareBlockPositions);
  }, [sourceBlocks, version]);

  // Convert Y.Map to regular Map
  const translations = useMemo(() => {
    void version; // Include version to trigger recompute on changes
    const map = new Map<string, string>();
    translationCache.forEach((value, key) => {
      if (typeof key === 'string' && typeof value === 'string') {
        map.set(key, value);
      }
    });
    return map;
  }, [translationCache, version]);

  return (
    <BilingualBlockViewer
      blocks={blocks}
      translations={translations}
      language={language}
      fontSize={fontSize}
      headerControls={headerControls}
    />
  );
}

export default BilingualBlockViewerContainer;
