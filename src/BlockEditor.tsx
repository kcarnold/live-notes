import { useCallback, useEffect, useState, useRef, useMemo, memo } from 'react';
import * as Y from 'yjs';
import { TextAreaBinding } from 'y-textarea';
import { generateKeyBetween } from 'fractional-indexing';
import {
  Block,
  BlockType,
  createBlock,
  yMapToBlock,
  updateYMap,
  serializeBlocksToMarkdown,
  ensureMinimumBlocks,
  MAX_INDENT_LEVEL,
  getBlockYText,
  compareBlockPositions,
  addBlockToYArray,
} from './blockTypes';

const SHOW_BUTTONS = true;

interface BlockEditorProps {
  yArray: Y.Array<Y.Map<any>>;
  onTextChanged?: (markdown: string) => void;
  editable?: boolean;
  onTranslationTrigger?: () => void;
}

interface BlockItemProps {
  blockId: string;
  yArray: Y.Array<Y.Map<any>>;
  isFocused: boolean;
  isFirst: boolean;
  isLast: boolean;
  editable: boolean;
  onFocus: (blockId: string) => void;
  onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>, block: Block) => void;
  onToggleHeading: (blockId: string) => void;
  onMoveBlock: (blockId: string, direction: 'up' | 'down') => void;
  onIndent: (blockId: string) => void;
  onDedent: (blockId: string) => void;
}

const BlockItem = memo(function BlockItem({
  blockId,
  yArray,
  isFocused,
  isFirst,
  isLast,
  editable,
  onFocus,
  onBlur,
  onKeyDown,
  onToggleHeading,
  onMoveBlock,
  onIndent,
  onDedent,
}: BlockItemProps) {
  const [version, setVersion] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Find the Y.Map for this specific block
  const yMap = useMemo(() => {
    return yArray.toArray().find(map => map.get('id') === blockId);
  }, [yArray, blockId, version]); // Include version to refresh when array changes

  // Observe only this block's Y.Map
  useEffect(() => {
    if (!yMap) return;

    const observer = () => {
      setVersion(v => v + 1);
    };

    yMap.observeDeep(observer);
    return () => yMap.unobserveDeep(observer);
  }, [yMap]);

  // Auto-resize textarea to fit content
  const autoResize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to get accurate measurement
    textarea.style.height = '0px';
    // Set height to scrollHeight to fit content
    textarea.style.height = textarea.scrollHeight + 'px';
  }, []);

  // Focus management
  useEffect(() => {
    if (isFocused && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isFocused]);

  if (!yMap) {
    return null; // Block was deleted
  }

  const block = yMapToBlock(yMap);
  // Headings are not indented; bullets use level for indentation
  const indentPadding = block.type === 'heading' ? 0 : block.level * 12;
  // Headings use level for number of #'s (level 0 = ##, level 1 = ###, etc.)
  const prefix = block.type === 'heading'
    ? '#'.repeat(block.level + 2) + ' '
    : '- ';

  return (
    <div
      className="flex items-start gap-2 py-1 hover:bg-gray-50"
      style={{ paddingLeft: `${indentPadding}px` }}
    >
      {/* Operation buttons - only shown when focused */}
      {SHOW_BUTTONS && editable && isFocused && (
        <div
          className="flex gap-0 pt-1 flex-shrink-0"
          onMouseDown={(e) => e.preventDefault()} // Prevent blur when clicking buttons
        >
          <button
            type="button"
            onClick={() => onMoveBlock(blockId, 'up')}
            className="px-1 text-xs border rounded hover:bg-gray-100"
            title="Move up (Cmd+↑)"
            disabled={isFirst}
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => onMoveBlock(blockId, 'down')}
            className="px-1 text-xs border rounded hover:bg-gray-100"
            title="Move down (Cmd+↓)"
            disabled={isLast}
          >
            ↓
          </button>
          <button
            type="button"
            onClick={() => onIndent(blockId)}
            className="px-1 text-xs border rounded hover:bg-gray-100"
            title="Indent (Tab)"
            disabled={block.level >= MAX_INDENT_LEVEL}
          >
            →
          </button>
          <button
            type="button"
            onClick={() => onDedent(blockId)}
            className="px-1 text-xs border rounded hover:bg-gray-100"
            title="Dedent (Shift+Tab)"
            disabled={block.level === 0}
          >
            ←
          </button>
        </div>
      )}

      {/* Prefix indicator - clickable to toggle heading (Cmd+H) */}
      <button
        type="button"
        onClick={() => onToggleHeading(blockId)}
        onMouseDown={(e) => e.preventDefault()} // Prevent blur when clicking
        className={`flex-shrink-0 bg-transparent border-none cursor-pointer hover:opacity-60 p-0 ${
          block.type === 'heading' ? 'font-bold' : ''
        }`}
        title="Click to toggle heading (Cmd+H)"
        disabled={!editable}
      >
        {prefix}
      </button>

      {/* Content */}
      <div className="flex-grow min-w-0">
        {isFocused && editable ? (
          <textarea
            ref={(el) => {
              if (!el) return;
              textareaRef.current = el;

              const yText = getBlockYText(yMap);
              const binding = new TextAreaBinding(yText, el);

              // Initial resize
              autoResize();
              return () => binding.destroy();
            }}
            defaultValue={block.content}
            onKeyDown={(e) => onKeyDown(e, block)}
            onBlur={onBlur}
            className={`w-full border-none outline-none resize-none ${
              block.type === 'heading' ? 'font-bold text-lg' : ''
            }`}
            rows={1}
            style={{ minHeight: '1.5rem' }}
          />
        ) : (
          <div
            onClick={() => editable && onFocus(blockId)}
            className={`cursor-text ${block.type === 'heading' ? 'font-bold text-lg' : ''}`}
          >
            {block.content || (
              <span className="text-gray-400 italic">Click to edit...</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export function BlockEditor({ yArray, onTextChanged, editable = true, onTranslationTrigger }: BlockEditorProps) {
  const [version, setVersion] = useState(0);
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const onTextChangedRef = useRef(onTextChanged);

  // Keep ref updated
  useEffect(() => {
    onTextChangedRef.current = onTextChanged;
  }, [onTextChanged]);

  // Initialize and observe Yjs array
  useEffect(() => {
    // Ensure minimum blocks on mount
    const timeout = setTimeout(() => ensureMinimumBlocks(yArray), 1000);
    // @ts-expect-error - for debugging
    window.yArray = yArray;

    // Trigger initial render
    setVersion(v => v + 1);

    // Call onTextChanged with initial state
    if (onTextChangedRef.current) {
      const blocks = yArray.toArray().map(yMap => yMapToBlock(yMap)).sort(compareBlockPositions);
      const markdown = serializeBlocksToMarkdown(blocks);
      onTextChangedRef.current(markdown);
    }

    // Observer just triggers re-renders
    const observer = () => {
      setVersion(v => v + 1);

      // Notify parent of markdown changes
      if (onTextChangedRef.current) {
        const blocks = yArray.toArray().map(yMap => yMapToBlock(yMap)).sort(compareBlockPositions);
        const markdown = serializeBlocksToMarkdown(blocks);
        onTextChangedRef.current(markdown);
      }
    };

    yArray.observeDeep(observer);
    return () => {
      yArray.unobserveDeep(observer);
      clearTimeout(timeout);
    }
  }, [yArray]);

  // Memoized sorted list of block IDs
  // version is used to trigger re-computation when yArray changes
  void version;
  const sortedBlockIds = useMemo(() => {
    const blocks = yArray
      .toArray()
      .map(yMap => yMapToBlock(yMap))
      .sort(compareBlockPositions);
    return blocks.map(b => b.id);
  }, [yArray, version]);

  const updateBlock = useCallback(
    (blockId: string, updates: Partial<Block>) => {
      const index = yArray.toArray().findIndex((yMap) => yMap.get('id') === blockId);
      if (index !== -1) {
        const yMap = yArray.get(index);
        updateYMap(yMap, updates);
      }
    },
    [yArray]
  );

  const deleteBlock = useCallback(
    (blockId: string) => {
      // Never delete the last block
      if (yArray.length <= 1) return;

      const sortedBlocks = yArray
        .toArray()
        .map(yMap => yMapToBlock(yMap))
        .sort(compareBlockPositions);

      const sortedIndex = sortedBlocks.findIndex(b => b.id === blockId);
      if (sortedIndex === -1) return;

      // Find the Y.Map in the array and delete it
      const arrayIndex = yArray.toArray().findIndex((yMap) => yMap.get('id') === blockId);
      if (arrayIndex !== -1) {
        yArray.delete(arrayIndex, 1);

        // Focus previous block in sorted order, if available, otherwise next block
        const newFocusIndex = sortedIndex > 0 ? sortedIndex - 1 : 0;
        if (newFocusIndex < sortedBlocks.length) {
          const newFocusBlock = sortedBlocks[newFocusIndex];
          setFocusedBlockId(newFocusBlock.id);
        }
      }
    },
    [yArray]
  );

  const insertBlockAfter = useCallback(
    (blockId: string, content: string, type: BlockType, level: number) => {
      const sortedBlocks = yArray
        .toArray()
        .map(yMap => yMapToBlock(yMap))
        .sort(compareBlockPositions);

      const currentIndex = sortedBlocks.findIndex(b => b.id === blockId);
      if (currentIndex === -1) {
        console.warn('insertBlockAfter: blockId not found', blockId);
        return;
      }

      // Calculate position between current and next block
      const currentPos = sortedBlocks[currentIndex].position;
      const nextPos = currentIndex < sortedBlocks.length - 1
        ? sortedBlocks[currentIndex + 1].position
        : null;
      const newPosition = generateKeyBetween(currentPos, nextPos) as string;

      const newBlock = createBlock(
        content,
        type,
        level,
        newPosition
      );
      addBlockToYArray(yArray, newBlock);
      setFocusedBlockId(newBlock.id);
    },
    [yArray]
  );

  const moveBlock = useCallback(
    (blockId: string, direction: 'up' | 'down') => {
      const sortedBlocks = yArray
        .toArray()
        .map(yMap => yMapToBlock(yMap))
        .sort(compareBlockPositions);

      const currentIndex = sortedBlocks.findIndex(b => b.id === blockId);
      if (currentIndex === -1) return;

      // Calculate new position between neighbors (excluding current block)
      let prevPos: string | null;
      let nextPos: string | null;

      if (direction === 'up') {
        if (currentIndex === 0) return; // Already at top
        // Moving up: position between (currentIndex - 2) and (currentIndex - 1)
        prevPos = currentIndex > 1 ? sortedBlocks[currentIndex - 2].position : null;
        nextPos = sortedBlocks[currentIndex - 1].position;
      } else {
        if (currentIndex === sortedBlocks.length - 1) return; // Already at bottom
        // Moving down: position between (currentIndex + 1) and (currentIndex + 2)
        prevPos = sortedBlocks[currentIndex + 1].position;
        nextPos = currentIndex < sortedBlocks.length - 2 ? sortedBlocks[currentIndex + 2].position : null;
      }

      const newPosition = generateKeyBetween(prevPos, nextPos);

      // Update position (not delete-insert!)
      updateBlock(blockId, { position: newPosition });
    },
    [yArray, updateBlock]
  );

  const indent = useCallback(
    (blockId: string) => {
      const yMap = yArray.toArray().find((map) => map.get('id') === blockId);
      if (yMap) {
        const block = yMapToBlock(yMap);
        if (block.level < MAX_INDENT_LEVEL) {
          updateBlock(blockId, { level: block.level + 1 });
        }
      }
    },
    [yArray, updateBlock]
  );

  const dedent = useCallback(
    (blockId: string) => {
      const yMap = yArray.toArray().find((map) => map.get('id') === blockId);
      if (yMap) {
        const block = yMapToBlock(yMap);
        if (block.level > 0) {
          updateBlock(blockId, { level: block.level - 1 });
        }
      }
    },
    [yArray, updateBlock]
  );

  const toggleHeading = useCallback(
    (blockId: string) => {
      const yMap = yArray.toArray().find((map) => map.get('id') === blockId);
      if (yMap) {
        const block = yMapToBlock(yMap);
        const newType: BlockType = block.type === 'heading' ? 'bullet' : 'heading';
        updateBlock(blockId, { type: newType });
      }
    },
    [yArray, updateBlock]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>, block: Block) => {
      if (!editable) return;

      const textarea = e.currentTarget;
      const cursorPos = textarea.selectionStart;
      const isAtStart = cursorPos === 0;
      const isAtEnd = cursorPos === textarea.value.length;

      // Cmd/Ctrl+Enter: trigger translation (check BEFORE plain Enter)
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (onTranslationTrigger) {
          onTranslationTrigger();
        }
      }
      // Enter: split block or create new block
      else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const beforeCursor = block.content.substring(0, cursorPos);
        const afterCursor = block.content.substring(cursorPos);

        // Wrap both operations in a transaction for atomicity
        yArray.doc?.transact(() => {
          // Update current block with content before cursor
          updateBlock(block.id, { content: beforeCursor });

          // Create new block with content after cursor
          const newType = block.type === 'heading' ? 'bullet' : block.type;
          const newLevel = block.type === 'heading' ? 0 : block.level;

          insertBlockAfter(block.id, afterCursor, newType, newLevel);
        });
      }
      // Backspace at start: merge with previous block
      else if (e.key === 'Backspace' && isAtStart && block.content === '') {
        e.preventDefault();
        deleteBlock(block.id);
      }
      // Tab: indent
      else if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        indent(block.id);
      }
      // Shift+Tab: dedent
      else if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        dedent(block.id);
      }
      // Cmd/Ctrl+H: toggle heading
      else if (e.key === 'h' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleHeading(block.id);
      }
      // Cmd/Ctrl+Up: move up
      else if (e.key === 'ArrowUp' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        moveBlock(block.id, 'up');
      }
      // Cmd/Ctrl+Down: move down
      else if (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        moveBlock(block.id, 'down');
      }
      // ArrowUp at start: focus previous block
      else if (e.key === 'ArrowUp' && isAtStart) {
        e.preventDefault();
        const index = sortedBlockIds.findIndex((id) => id === block.id);
        if (index > 0) {
          setFocusedBlockId(sortedBlockIds[index - 1]);
        }
      }
      // ArrowDown at end: focus next block
      else if (e.key === 'ArrowDown' && isAtEnd) {
        e.preventDefault();
        const index = sortedBlockIds.findIndex((id) => id === block.id);
        if (index < sortedBlockIds.length - 1) {
          setFocusedBlockId(sortedBlockIds[index + 1]);
        }
      }
    },
    [editable, sortedBlockIds, updateBlock, insertBlockAfter, deleteBlock, indent, dedent, toggleHeading, moveBlock, onTranslationTrigger]
  );

  return (
    <div className="border rounded p-1 bg-white">
      {sortedBlockIds.length === 0 ? (
        <div className="text-gray-400 italic">No blocks yet</div>
      ) : (
        sortedBlockIds.map((blockId, index) => (
          <BlockItem
            key={blockId}
            blockId={blockId}
            yArray={yArray}
            isFocused={focusedBlockId === blockId}
            isFirst={index === 0}
            isLast={index === sortedBlockIds.length - 1}
            editable={editable}
            onFocus={setFocusedBlockId}
            onBlur={() => setFocusedBlockId(null)}
            onKeyDown={handleKeyDown}
            onToggleHeading={toggleHeading}
            onMoveBlock={moveBlock}
            onIndent={indent}
            onDedent={dedent}
          />
        ))
      )}
    </div>
  );
}
