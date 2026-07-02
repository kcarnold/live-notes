import type React from 'react';
import { useEffect, useState, useMemo } from 'react';
import { useYDoc, useMap } from '@y-sweet/react';
import { type Block, type BlockYMap, yMapToBlock, compareBlockPositions } from './blockTypes';
import { BilingualBlockViewer } from './BilingualBlockViewer';

interface BilingualBlockViewerContainerProps {
  language: string;
  fontSize?: number;
  headerControls?: React.ReactNode;
  /** When false, hide the original-language text and show only the translation. Defaults to true. */
  showOriginal?: boolean;
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
  showOriginal,
}: BilingualBlockViewerContainerProps) {
  const ydoc = useYDoc();
  const translationCache = useMap('notesTranslationCache');
  const [version, setVersion] = useState(0);

  // Get the sourceBlocks array
  const sourceBlocks = useMemo(
    () => ydoc.getArray<BlockYMap>('sourceBlocks'),
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

  // Convert Yjs data to props for pure component. Unaccepted AI proposals (status
  // 'proposed') are filtered out so they never reach the audience/listener — only the
  // editor sees them, in BlockEditor.
  const blocks: Block[] = useMemo(() => {
    void version; // Include version to trigger recompute on changes
    return sourceBlocks
      .toArray()
      .map(yMap => yMapToBlock(yMap))
      .filter(block => block.status === 'confirmed')
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
      showOriginal={showOriginal}
    />
  );
}

export default BilingualBlockViewerContainer;
