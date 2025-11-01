import * as Y from 'yjs';
import { v4 as uuidv4 } from 'uuid';
import { setYTextFromString } from './yjsUtils';

export type BlockType = 'heading' | 'bullet';

export interface Block {
  id: string;
  content: string; // For rendering; actual storage is Y.Text in the Y.Map
  type: BlockType;
  level: number; // 0-5 for indentation
}

export const MAX_INDENT_LEVEL = 5;

/**
 * Create a new block with default values
 */
export function createBlock(
  content = '',
  type: BlockType = 'bullet',
  level = 0
): Block {
  return {
    id: uuidv4(),
    content,
    type,
    level: Math.min(Math.max(0, level), MAX_INDENT_LEVEL),
  };
}

/**
 * Convert a Y.Map to a Block
 * Note: content is stored as Y.Text in the map, but we return it as string for rendering
 */
export function yMapToBlock(yMap: Y.Map<any>): Block {
  const yText = yMap.get('content') as Y.Text | undefined;
  return {
    id: yMap.get('id') || uuidv4(),
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    content: yText ? yText.toString() : '',
    type: yMap.get('type') || 'bullet',
    level: yMap.get('level') || 0,
  };
}

/**
 * Update a Y.Map with block data
 * Note: content updates should go through the Y.Text directly, not this function
 */
export function updateYMap(yMap: Y.Map<any>, block: Partial<Block>): void {
  if (block.id !== undefined) yMap.set('id', block.id);
  if (block.content !== undefined) {
    // Initialize or replace content as Y.Text
    let yText = yMap.get('content') as Y.Text | undefined;
    if (!yText) {
      yText = new Y.Text();
      yMap.set('content', yText);
    }
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const currentText = yText.toString();
    if (currentText !== block.content) {
      setYTextFromString(yText, block.content);
    }
  }
  if (block.type !== undefined) yMap.set('type', block.type);
  if (block.level !== undefined) {
    yMap.set('level', Math.min(Math.max(0, block.level), MAX_INDENT_LEVEL));
  }
}

/**
 * Create a Y.Map from a Block
 */
export function blockToYMap(block: Block): Y.Map<any> {
  const yMap = new Y.Map();
  updateYMap(yMap, block);
  return yMap;
}

/**
 * Serialize blocks to markdown string
 */
export function serializeBlocksToMarkdown(blocks: Block[]): string {
  return blocks
    .map((block) => {
      const indent = '  '.repeat(block.level);
      const prefix = block.type === 'heading' ? '## ' : '- ';
      return `${indent}${prefix}${block.content}`;
    })
    .join('\n');
}

/**
 * Ensure there's always at least one block
 */
export function ensureMinimumBlocks(yArray: Y.Array<Y.Map<any>>): void {
  if (yArray.length === 0) {
    yArray.push([blockToYMap(createBlock())]);
  }
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

