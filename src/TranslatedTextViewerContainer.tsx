import React, { useMemo } from 'react';
import { useYDoc } from '@y-sweet/react';
import { useYjsArray } from './yjsUtils';
import { yMapToBlock, compareBlockPositions, Block } from './blockTypes';
import TranslatedTextViewer from './TranslatedTextViewer';
import * as Y from 'yjs';

interface TranslatedTextViewerContainerProps {
  language: string;
  fontSize?: number;
  headerControls?: React.ReactNode;
}

/**
 * Container component that connects TranslatedTextViewer to Yjs.
 *
 * This wrapper:
 * 1. Fetches source blocks from Yjs shared document
 * 2. Converts to Block objects and sorts by position
 * 3. Passes blocks to TranslatedTextViewer (which displays translations)
 */
const TranslatedTextViewerContainer: React.FC<TranslatedTextViewerContainerProps> = ({
  language,
  fontSize,
  headerControls,
}) => {
  const ydoc = useYDoc();
  const sourceBlocks = ydoc.getArray<Y.Map<any>>("sourceBlocks");
  const [, version] = useYjsArray(sourceBlocks);

  const blocks = useMemo(() => {
    const blockArray: Block[] = sourceBlocks
      .toArray()
      .map((yMap: Y.Map<any>) => yMapToBlock(yMap))
      .sort(compareBlockPositions);

    return blockArray;
  }, [sourceBlocks, version]);

  return (
    <TranslatedTextViewer
      blocks={blocks}
      language={language}
      fontSize={fontSize}
      headerControls={headerControls}
    />
  );
};

export default TranslatedTextViewerContainer;
