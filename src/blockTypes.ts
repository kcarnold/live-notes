import * as Y from 'yjs';
import { v4 as uuidv4 } from 'uuid';
import { setYTextFromString } from './yjsUtils';
import { generateKeyBetween } from 'fractional-indexing';

export type BlockType = 'heading' | 'bullet';

export interface Block {
  id: string;
  content: string; // For rendering; actual storage is Y.Text in the Y.Map
  type: BlockType;
  level: number; // 0-5 for indentation
  position: string; // Fractional index for stable ordering
}

export const MAX_INDENT_LEVEL = 5;

/**
 * Create a new block with required position to ensure stable ordering
 */
export function createBlock(
  content = '',
  type: BlockType = 'bullet',
  level = 0,
  position: string
): Block {
  if (!position) { 
    throw new Error('Position is required to create a block');
  }
  return {
    id: uuidv4(),
    content,
    type,
    level: Math.min(Math.max(0, level), MAX_INDENT_LEVEL),
    position,
  };
}

export function getPosition(prevBlock: Block | null, nextBlock: Block | null): string {
  const prevPos = prevBlock ? prevBlock.position : null;
  const nextPos = nextBlock ? nextBlock.position : null;
  return generateKeyBetween(prevPos, nextPos);
}

/**
 * Convert a Y.Map to a Block
 * Note: content is stored as Y.Text in the map, but we return it as string for rendering
 *
 * Logs warnings if expected fields are missing - indicates incorrect state.
 */
export function yMapToBlock(yMap: Y.Map<any>): Block {
  const yText = yMap.get('content') as Y.Text | undefined;
  const id = yMap.get('id') as string | undefined;
  const type = yMap.get('type') as BlockType | undefined;
  const level = yMap.get('level') as number | undefined;
  const position = yMap.get('position') as string | undefined;

  if (!id || !type || level === undefined || !position) {
    console.warn('yMapToBlock: Missing required fields in Y.Map', {
      id,
      type,
      level,
      position,
    });
    //throw new Error('[yMapToBlock] Missing required fields in Y.Map');
  }

  return {
    id: id || uuidv4(),
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    content: yText ? yText.toString() : '',
    type: type || 'bullet',
    level: level ?? 0,
    position: position || getPosition(null, null),
  };
}

/**
 * Update a Y.Map with block data
 * Note: content updates should go through the Y.Text directly, not this function
 *
 * All updates are wrapped in a transaction to ensure atomicity when multiple
 * fields are updated simultaneously.
 */
export function updateYMap(yMap: Y.Map<any>, block: Partial<Block>): void {
  const doc = yMap.doc;

  const performUpdates = () => {
    if (block.id !== undefined) yMap.set('id', block.id);
    if (block.content !== undefined) {
      // Initialize or replace content as Y.Text
      let yText = yMap.get('content') as Y.Text | undefined;
      const isNewYText = !yText;
      if (!yText) {
        yText = new Y.Text();
        yMap.set('content', yText);
      }

      if (isNewYText) {
        // Newly created Y.Text - just insert content directly
        // Don't read from it (toString) until it's attached to a doc
        if (block.content) {
          yText.insert(0, block.content);
        }
      } else {
        // Existing Y.Text - update it using diff-based approach
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const currentText = yText.toString();
        if (currentText !== block.content) {
          setYTextFromString(yText, block.content);
        }
      }
    }
    if (block.type !== undefined) yMap.set('type', block.type);
    if (block.level !== undefined) {
      yMap.set('level', Math.min(Math.max(0, block.level), MAX_INDENT_LEVEL));
    }
    if (block.position !== undefined) yMap.set('position', block.position);
  };

  // Wrap all updates in a transaction if attached to a document
  if (doc) {
    doc.transact(performUpdates);
  } else {
    // If not attached to a doc yet, just perform updates directly
    performUpdates();
  }
}

/**
 * Add a block to a Y.Array
 * Creates the Y.Map first, adds it to the array (attaching to doc), then populates it.
 * 
 * This avoids warnings from Yjs about modifying a Y.Map before it's attached to a document.
 */
export function addBlockToYArray(yArray: Y.Array<Y.Map<any>>, block: Block): void {
  const yMap = new Y.Map();
  yArray.push([yMap]);
  if (yArray.doc == null) {
    updateYMap(yMap, block);
  } else {
    yArray.doc.transact(() => {
      updateYMap(yMap, block);
    });
  }
}

/**
 * Serialize blocks to markdown string
 * Skips empty blocks (blocks with no content)
 */
export function serializeBlocksToMarkdown(blocks: Block[]): string {
  return blocks
    .filter((block) => block.content.trim() !== '')
    .map((block) => {
      if (block.type === 'heading') {
        // Headings use level for number of #'s (level 0 = ##, level 1 = ###, etc.)
        const hashes = '#'.repeat(block.level + 2);
        return `${hashes} ${block.content}`;
      } else {
        // Bullets use level for indentation
        const indent = '  '.repeat(block.level);
        return `${indent}- ${block.content}`;
      }
    })
    .join('\n');
}

/**
 * Ensure there's always at least one block
 */
export function ensureMinimumBlocks(yArray: Y.Array<Y.Map<any>>): void {
  if (yArray.length > 0) {
    return;
  }
  const block = createBlock('', 'bullet', 0, getPosition(null, null));
  addBlockToYArray(yArray, block);
}

/**
 * Get the Y.Text for a block's content
 */
export function getBlockYText(yMap: Y.Map<any>): Y.Text {
  let yText = yMap.get('content') as Y.Text | undefined;
  if (!yText) {
    yText = new Y.Text();
    yMap.set('content', yText);
  }
  return yText;
}

/**
 * Compare function for sorting blocks by fractional index position.
 * Uses native string comparison (case-sensitive) as required by fractional-indexing library.
 * DO NOT use localeCompare() as it is case-insensitive and will give incorrect ordering.
 *
 * See https://github.com/rocicorp/fractional-indexing?tab=readme-ov-file#sorting
 */
export function compareBlockPositions(a: Block, b: Block): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Test utility: Generate sequential positions for creating multiple blocks in order.
 * Makes tests less verbose by generating all positions at once.
 *
 * @param count - Number of sequential positions to generate
 * @returns Array of position strings in sorted order
 *
 * @example
 * const positions = createSequentialPositions(3);
 * const blocks = [
 *   createBlock('Block 1', 'bullet', 0, positions[0]),
 *   createBlock('Block 2', 'bullet', 0, positions[1]),
 *   createBlock('Block 3', 'bullet', 0, positions[2]),
 * ];
 */
export function createSequentialPositions(count: number): string[] {
  const positions: string[] = [];
  let prevPos: string | null = null;

  for (let i = 0; i < count; i++) {
    const pos = generateKeyBetween(prevPos, null) as string;
    positions.push(pos);
    prevPos = pos;
  }

  return positions;
}

