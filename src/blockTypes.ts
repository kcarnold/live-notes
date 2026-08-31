import * as Y from 'yjs';
import { v4 as uuidv4 } from 'uuid';
import { setYTextFromString, yTextToString } from './yjsUtils';
import { generateKeyBetween } from 'fractional-indexing';

export type BlockType = 'heading' | 'bullet';

// Review state of a block. `confirmed` blocks are part of the real outline (they feed
// translation and the read-only/listener viewers). `proposed` blocks are AI suggestions
// awaiting the editor's review — they render only in the editor and never leak to the
// audience/translator until accepted (status flipped to `confirmed`).
export type BlockStatus = 'confirmed' | 'proposed';

// Provenance, for styling and as a signal to the note synthesizer. Legacy blocks and
// anything a human types default to `human`; AI proposals are `ai`.
export type BlockOrigin = 'human' | 'ai';

export const DEFAULT_BLOCK_STATUS: BlockStatus = 'confirmed';
export const DEFAULT_BLOCK_ORIGIN: BlockOrigin = 'human';

export interface Block {
  id: string;
  content: string; // For rendering; actual storage is Y.Text in the Y.Map
  type: BlockType;
  level: number; // 0-5 for indentation
  position: string; // Fractional index for stable ordering
  status: BlockStatus;
  origin: BlockOrigin;
}

// The Y.Map backing a block holds a mix of these value types (id/type/position
// are strings, level is a number, content is a Y.Text).
export type BlockYMap = Y.Map<string | number | Y.Text>;

export const MAX_INDENT_LEVEL = 5;

/**
 * Create a new block with required position to ensure stable ordering
 */
export function createBlock(
  content = '',
  type: BlockType = 'bullet',
  level = 0,
  position: string,
  status: BlockStatus = DEFAULT_BLOCK_STATUS,
  origin: BlockOrigin = DEFAULT_BLOCK_ORIGIN
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
    status,
    origin,
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
export function yMapToBlock(yMap: BlockYMap): Block {
  const yText = yMap.get('content') as Y.Text | undefined;
  const id = yMap.get('id') as string | undefined;
  const type = yMap.get('type') as BlockType | undefined;
  const level = yMap.get('level') as number | undefined;
  const position = yMap.get('position') as string | undefined;
  // status/origin are newer fields; blocks written before they existed (and every
  // human-authored block) default to confirmed/human, preserving legacy behavior.
  const status = yMap.get('status') as BlockStatus | undefined;
  const origin = yMap.get('origin') as BlockOrigin | undefined;

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
    content: yText ? yTextToString(yText) : '',
    type: type || 'bullet',
    level: level ?? 0,
    position: position || getPosition(null, null),
    status: status ?? DEFAULT_BLOCK_STATUS,
    origin: origin ?? DEFAULT_BLOCK_ORIGIN,
  };
}

/**
 * Update a Y.Map with block data
 * Note: content updates should go through the Y.Text directly, not this function
 *
 * All updates are wrapped in a transaction to ensure atomicity when multiple
 * fields are updated simultaneously.
 */
export function updateYMap(yMap: BlockYMap, block: Partial<Block>): void {
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
        const currentText = yTextToString(yText);
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
    if (block.status !== undefined) yMap.set('status', block.status);
    if (block.origin !== undefined) yMap.set('origin', block.origin);
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
export function addBlockToYArray(yArray: Y.Array<BlockYMap>, block: Block): void {
  const yMap: BlockYMap = new Y.Map();
  yArray.push([yMap]);
  if (yArray.doc == null) {
    updateYMap(yMap, block);
  } else {
    yArray.doc.transact(() => {
      updateYMap(yMap, block);
    });
  }
}

/** Whether a block is an unaccepted AI proposal. */
export function isProposed(block: Pick<Block, 'status'>): boolean {
  return block.status === 'proposed';
}

/**
 * Serialize blocks to markdown string.
 * Skips empty blocks (blocks with no content). By default also skips `proposed`
 * (unaccepted AI) blocks so proposals never leak into translation source or any
 * markdown shown to the audience — pass `{ includeProposed: true }` for contexts
 * (like the note synthesizer) that want the full outline.
 */
export function serializeBlocksToMarkdown(
  blocks: Block[],
  { includeProposed = false }: { includeProposed?: boolean } = {}
): string {
  return blocks
    .filter((block) => block.content.trim() !== '')
    .filter((block) => includeProposed || !isProposed(block))
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
export function ensureMinimumBlocks(yArray: Y.Array<BlockYMap>): void {
  if (yArray.length > 0) {
    return;
  }
  const block = createBlock('', 'bullet', 0, getPosition(null, null));
  addBlockToYArray(yArray, block);
}

/**
 * Get the Y.Text for a block's content
 */
export function getBlockYText(yMap: BlockYMap): Y.Text {
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
    const pos = generateKeyBetween(prevPos, null);
    positions.push(pos);
    prevPos = pos;
  }

  return positions;
}

