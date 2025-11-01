import { useCallback, useEffect, useState, useRef } from 'react';
import * as Y from 'yjs';
import { TextAreaBinding } from 'y-textarea';
import { generateKeyBetween } from 'fractional-indexing';
import {
  Block,
  BlockType,
  createBlock,
  yMapToBlock,
  blockToYMap,
  updateYMap,
  serializeBlocksToMarkdown,
  ensureMinimumBlocks,
  MAX_INDENT_LEVEL,
  getBlockYText,
} from './blockTypes';

interface BlockEditorProps {
  yArray: Y.Array<Y.Map<any>>;
  onTextChanged?: (markdown: string) => void;
  editable?: boolean;
  onTranslationTrigger?: () => void;
}

export function BlockEditor({ yArray, onTextChanged, editable = true, onTranslationTrigger }: BlockEditorProps) {
  const [version, setVersion] = useState(0);
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const textareaRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const bindingsRef = useRef<Map<string, TextAreaBinding>>(new Map());
  const onTextChangedRef = useRef(onTextChanged);

  // Keep ref updated
  useEffect(() => {
    onTextChangedRef.current = onTextChanged;
  }, [onTextChanged]);

  // Initialize and observe Yjs array
  useEffect(() => {
    // Ensure minimum blocks on mount
    ensureMinimumBlocks(yArray);
    // @ts-expect-error - for debugging
    window.yArray = yArray;

    // Trigger initial render
    setVersion(v => v + 1);

    // Observer just triggers re-renders
    const observer = () => {
      setVersion(v => v + 1);

      // Notify parent of markdown changes
      if (onTextChangedRef.current) {
        const blocks = yArray.toArray().map(yMap => yMapToBlock(yMap));
        const markdown = serializeBlocksToMarkdown(blocks);
        onTextChangedRef.current(markdown);
      }
    };

    yArray.observeDeep(observer);
    return () => yArray.unobserveDeep(observer);
  }, [yArray]);

  // Read blocks directly from Yjs during render
  // version is used to trigger re-renders via setState
  void version;
  const blocks = yArray
    .toArray()
    .map(yMap => yMapToBlock(yMap))
    .sort((a, b) => a.position.localeCompare(b.position));

  // Focus management - focus the textarea when a block becomes focused
  useEffect(() => {
    if (focusedBlockId) {
      const textarea = textareaRefs.current.get(focusedBlockId);
      if (textarea) {
        textarea.focus();
      }
    }
  }, [focusedBlockId]);

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
        .sort((a, b) => a.position.localeCompare(b.position));

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
    (blockId: string, newBlock?: Block) => {
      const sortedBlocks = yArray
        .toArray()
        .map(yMap => yMapToBlock(yMap))
        .sort((a, b) => a.position.localeCompare(b.position));

      const currentIndex = sortedBlocks.findIndex(b => b.id === blockId);
      if (currentIndex === -1) return;

      // Calculate position between current and next block
      const currentPos = sortedBlocks[currentIndex].position;
      const nextPos = currentIndex < sortedBlocks.length - 1
        ? sortedBlocks[currentIndex + 1].position
        : null;
      const newPosition = generateKeyBetween(currentPos, nextPos);

      const block = newBlock || createBlock('', 'bullet', 0, newPosition);
      if (!newBlock) {
        block.position = newPosition;
      }

      yArray.push([blockToYMap(block)]);
      setFocusedBlockId(block.id);
    },
    [yArray]
  );

  const moveBlock = useCallback(
    (blockId: string, direction: 'up' | 'down') => {
      const sortedBlocks = yArray
        .toArray()
        .map(yMap => yMapToBlock(yMap))
        .sort((a, b) => a.position.localeCompare(b.position));

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
      const block = blocks.find((b) => b.id === blockId);
      if (block && block.level < MAX_INDENT_LEVEL) {
        updateBlock(blockId, { level: block.level + 1 });
      }
    },
    [blocks, updateBlock]
  );

  const dedent = useCallback(
    (blockId: string) => {
      const block = blocks.find((b) => b.id === blockId);
      if (block && block.level > 0) {
        updateBlock(blockId, { level: block.level - 1 });
      }
    },
    [blocks, updateBlock]
  );

  const toggleHeading = useCallback(
    (blockId: string) => {
      const block = blocks.find((b) => b.id === blockId);
      if (block) {
        const newType: BlockType = block.type === 'heading' ? 'bullet' : 'heading';
        updateBlock(blockId, { type: newType });
      }
    },
    [blocks, updateBlock]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>, block: Block) => {
      if (!editable) return;

      const textarea = e.currentTarget;
      const cursorPos = textarea.selectionStart;
      const isAtStart = cursorPos === 0;
      const isAtEnd = cursorPos === textarea.value.length;

      // Enter: split block or create new block
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const beforeCursor = block.content.substring(0, cursorPos);
        const afterCursor = block.content.substring(cursorPos);

        // Update current block with content before cursor
        updateBlock(block.id, { content: beforeCursor });

        // Create new block with content after cursor
        const newBlock = createBlock(afterCursor, block.type, block.level);
        insertBlockAfter(block.id, newBlock);
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
      // Cmd/Ctrl+Enter: trigger translation
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (onTranslationTrigger) {
          onTranslationTrigger();
        }
      }
      // ArrowUp at start: focus previous block
      else if (e.key === 'ArrowUp' && isAtStart) {
        e.preventDefault();
        const index = blocks.findIndex((b) => b.id === block.id);
        if (index > 0) {
          setFocusedBlockId(blocks[index - 1].id);
        }
      }
      // ArrowDown at end: focus next block
      else if (e.key === 'ArrowDown' && isAtEnd) {
        e.preventDefault();
        const index = blocks.findIndex((b) => b.id === block.id);
        if (index < blocks.length - 1) {
          setFocusedBlockId(blocks[index + 1].id);
        }
      }
    },
    [editable, blocks, updateBlock, insertBlockAfter, deleteBlock, indent, dedent, toggleHeading, moveBlock, onTranslationTrigger]
  );

  const renderBlock = (block: Block) => {
    const isFocused = focusedBlockId === block.id;
    const indentPadding = block.level * 24; // 24px per level
    const prefix = block.type === 'heading' ? '## ' : '- ';

    return (
      <div
        key={block.id}
        className="flex items-start gap-2 py-1 hover:bg-gray-50"
        style={{ paddingLeft: `${indentPadding}px` }}
      >
        {/* Operation buttons */}
        {editable && (
          <div className="flex gap-1 pt-1 flex-shrink-0">
            <button
              onClick={() => toggleHeading(block.id)}
              className="px-1 text-xs border rounded hover:bg-gray-100"
              title="Toggle heading (Cmd+H)"
            >
              H
            </button>
            <button
              onClick={() => moveBlock(block.id, 'up')}
              className="px-1 text-xs border rounded hover:bg-gray-100"
              title="Move up (Cmd+↑)"
              disabled={blocks[0]?.id === block.id}
            >
              ↑
            </button>
            <button
              onClick={() => moveBlock(block.id, 'down')}
              className="px-1 text-xs border rounded hover:bg-gray-100"
              title="Move down (Cmd+↓)"
              disabled={blocks[blocks.length - 1]?.id === block.id}
            >
              ↓
            </button>
            <button
              onClick={() => indent(block.id)}
              className="px-1 text-xs border rounded hover:bg-gray-100"
              title="Indent (Tab)"
              disabled={block.level >= MAX_INDENT_LEVEL}
            >
              →
            </button>
            <button
              onClick={() => dedent(block.id)}
              className="px-1 text-xs border rounded hover:bg-gray-100"
              title="Dedent (Shift+Tab)"
              disabled={block.level === 0}
            >
              ←
            </button>
          </div>
        )}

        {/* Prefix indicator */}
        <span className={`flex-shrink-0 ${block.type === 'heading' ? 'font-bold' : ''}`}>
          {prefix}
        </span>

        {/* Content */}
        <div className="flex-grow min-w-0">
          {isFocused && editable ? (
            <textarea
              ref={(el) => {
                if (!el) return;
                textareaRefs.current.set(block.id, el);

                const blockIndex = yArray.toArray().findIndex(yMap => yMap.get('id') === block.id);
                if (blockIndex === -1) {
                  textareaRefs.current.delete(block.id);
                  return;
                }

                const yMap = yArray.get(blockIndex);
                const yText = getBlockYText(yMap);

                // Ensure Y.Text is actually in the document
                if (!yText.doc) {
                  console.warn('Y.Text not in document yet, deferring binding for block', block.id);
                  // Try again on next tick
                  setTimeout(() => {
                    const yText = getBlockYText(yMap);
                    if (yText.doc && el.isConnected) {
                      const binding = new TextAreaBinding(yText, el);
                      bindingsRef.current.set(block.id, binding);
                    }
                  }, 0);
                  return () => {
                    // Cleanup deferred binding if it was created
                    const binding = bindingsRef.current.get(block.id);
                    if (binding) {
                      binding.destroy();
                      bindingsRef.current.delete(block.id);
                    }
                  };
                }

                // Use official y-textarea binding
                const binding = new TextAreaBinding(yText, el);
                bindingsRef.current.set(block.id, binding);

                // Return cleanup function - React will call it on unmount
                return () => {
                  binding.destroy();
                  bindingsRef.current.delete(block.id);
                };
             }}
              defaultValue={block.content}
              onKeyDown={(e) => handleKeyDown(e, block)}
              onBlur={() => setFocusedBlockId(null)}
              className={`w-full border-none outline-none resize-none ${
                block.type === 'heading' ? 'font-bold text-lg' : ''
              }`}
              rows={1}
              style={{ minHeight: '1.5rem' }}
            />
          ) : (
            <div
              onClick={() => editable && setFocusedBlockId(block.id)}
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
  };

  return (
    <div className="border rounded p-4 bg-white">
      {blocks.length === 0 ? (
        <div className="text-gray-400 italic">No blocks yet</div>
      ) : (
        blocks.map(renderBlock)
      )}
    </div>
  );
}
