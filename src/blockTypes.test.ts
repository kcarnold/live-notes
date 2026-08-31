import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  createBlock,
  serializeBlocksToMarkdown,
  compareBlockPositions,
  createSequentialPositions,
  addBlockToYArray,
  updateYMap,
  yMapToBlock,
  isProposed,
  type BlockYMap,
} from './blockTypes';

const positions = createSequentialPositions(5);

describe('blockTypes', () => {
  describe('serializeBlocksToMarkdown', () => {
    it('serializes bullets without indentation', () => {
      const blocks = [
        createBlock('First item', 'bullet', 0, positions[0]),
        createBlock('Second item', 'bullet', 0, positions[1]),
      ];
      const markdown = serializeBlocksToMarkdown(blocks);
      expect(markdown).toBe('- First item\n- Second item');
    });

    it('serializes headings', () => {
      const blocks = [
        createBlock('Main Title', 'heading', 0, positions[0]),
        createBlock('Content', 'bullet', 0, positions[1]),
      ];
      const markdown = serializeBlocksToMarkdown(blocks);
      expect(markdown).toBe('## Main Title\n- Content');
    });

    it('serializes indented bullets', () => {
      const blocks = [
        createBlock('Level 0', 'bullet', 0, positions[0]),
        createBlock('Level 1', 'bullet', 1, positions[1]),
        createBlock('Level 2', 'bullet', 2, positions[2]),
      ];
      const markdown = serializeBlocksToMarkdown(blocks);
      expect(markdown).toBe('- Level 0\n  - Level 1\n    - Level 2');
    });

    it('serializes mixed content with indentation', () => {
      const blocks = [
        createBlock('Title', 'heading', 0, positions[0]),
        createBlock('First point', 'bullet', 0, positions[1]),
        createBlock('Nested point', 'bullet', 1, positions[2]),
        createBlock('Another point', 'bullet', 0, positions[3]),
      ];
      const markdown = serializeBlocksToMarkdown(blocks);
      expect(markdown).toBe('## Title\n- First point\n  - Nested point\n- Another point');
    });

    it('ignores empty content', () => {
      const blocks = [createBlock('', 'bullet', 0, positions[0])];
      const markdown = serializeBlocksToMarkdown(blocks);
      expect(markdown).toBe('');
    });

    it('handles maximum indentation', () => {
      const blocks = [createBlock('Deep', 'bullet', 5, positions[0])];
      const markdown = serializeBlocksToMarkdown(blocks);
      expect(markdown).toBe('          - Deep'); // 10 spaces (5 levels * 2 spaces)
    });
  });

  describe('createBlock', () => {
    it('caps level at maximum', () => {
      const block = createBlock('test', 'bullet', 99, positions[0]);
      expect(block.level).toBe(5);
    });

    it('prevents negative levels', () => {
      const block = createBlock('test', 'bullet', -1, positions[0]);
      expect(block.level).toBe(0);
    });
  });

  describe('compareBlockPositions', () => {
    it('sorts blocks correctly using case-sensitive comparison', () => {
      // Create blocks with fractional index positions
      // The fractional-indexing library generates case-sensitive strings
      const block1 = createBlock('First', 'bullet', 0, 'Yza');
      const block2 = createBlock('Second', 'bullet', 0, 'YzZ');
      const block3 = createBlock('Third', 'bullet', 0, 'Yzb');

      const blocks = [block2, block3, block1]; // Out of order
      const sorted = blocks.sort(compareBlockPositions);

      expect(sorted.map(b => b.position)).toEqual(['YzZ', 'Yza', 'Yzb']);
      expect(sorted.map(b => b.content)).toEqual(['Second', 'First', 'Third']);
    });

    it('breaks ties using block id', () => {
      const block1 = createBlock('First', 'bullet', 0, 'abc');
      const block2 = createBlock('Second', 'bullet', 0, 'abc');

      const result = compareBlockPositions(block1, block2);
      expect(result).not.toBe(0);
    });

    it('correctly orders uppercase before lowercase (case-sensitive)', () => {
      // This is the critical difference from localeCompare
      // Native string comparison: uppercase letters come before lowercase
      const blockA = createBlock('A', 'bullet', 0, 'A');
      const blockB = createBlock('a', 'bullet', 0, 'a');

      const result = compareBlockPositions(blockA, blockB);
      expect(result).toBe(-1); // 'A' < 'a' in native comparison
      expect('A' < 'a').toBe(true); // Verify native behavior
    });

    it('sorts multiple blocks correctly', () => {
      const positions = ['a0', 'a1', 'a2', 'a3', 'a4'];
      const blocks = positions.map(pos => createBlock(`Block ${pos}`, 'bullet', 0, pos));

      // Shuffle the blocks
      const shuffled = [blocks[3], blocks[1], blocks[4], blocks[0], blocks[2]];
      const sorted = shuffled.sort(compareBlockPositions);

      expect(sorted.map(b => b.position)).toEqual(positions);
    });
  });

  describe('status / origin (AI proposals)', () => {
    it('defaults new blocks to confirmed/human', () => {
      const block = createBlock('hi', 'bullet', 0, positions[0]);
      expect(block.status).toBe('confirmed');
      expect(block.origin).toBe('human');
      expect(isProposed(block)).toBe(false);
    });

    it('treats legacy blocks (no status/origin in the Y.Map) as confirmed/human', () => {
      const doc = new Y.Doc();
      const yArray = doc.getArray<BlockYMap>('sourceBlocks');
      const yMap: BlockYMap = new Y.Map();
      yArray.push([yMap]);
      // Simulate a block written before status/origin existed.
      doc.transact(() => {
        yMap.set('id', 'legacy');
        yMap.set('type', 'bullet');
        yMap.set('level', 0);
        yMap.set('position', positions[0]);
        yMap.set('content', new Y.Text('legacy content'));
      });
      const block = yMapToBlock(yMap);
      expect(block.status).toBe('confirmed');
      expect(block.origin).toBe('human');
    });

    it('round-trips a proposed AI block through the Y.Map', () => {
      const doc = new Y.Doc();
      const yArray = doc.getArray<BlockYMap>('sourceBlocks');
      addBlockToYArray(yArray, createBlock('idea', 'bullet', 0, positions[0], 'proposed', 'ai'));
      const block = yMapToBlock(yArray.get(0));
      expect(block.status).toBe('proposed');
      expect(block.origin).toBe('ai');
      expect(isProposed(block)).toBe(true);
    });

    it('accept flips proposed -> confirmed without touching content/position', () => {
      const doc = new Y.Doc();
      const yArray = doc.getArray<BlockYMap>('sourceBlocks');
      addBlockToYArray(yArray, createBlock('idea', 'bullet', 1, positions[0], 'proposed', 'ai'));
      const yMap = yArray.get(0);
      updateYMap(yMap, { status: 'confirmed' });
      const block = yMapToBlock(yMap);
      expect(block.status).toBe('confirmed');
      expect(block.origin).toBe('ai'); // provenance preserved
      expect(block.content).toBe('idea');
      expect(block.level).toBe(1);
      expect(block.position).toBe(positions[0]);
    });
  });

  describe('serializeBlocksToMarkdown proposal filtering', () => {
    const blocks = [
      createBlock('Confirmed point', 'bullet', 0, positions[0]),
      createBlock('Proposed point', 'bullet', 0, positions[1], 'proposed', 'ai'),
    ];

    it('excludes proposed blocks by default (leakage guard)', () => {
      expect(serializeBlocksToMarkdown(blocks)).toBe('- Confirmed point');
    });

    it('includes proposed blocks when asked', () => {
      expect(serializeBlocksToMarkdown(blocks, { includeProposed: true })).toBe(
        '- Confirmed point\n- Proposed point'
      );
    });
  });
});
