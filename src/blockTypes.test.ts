import { describe, it, expect } from 'vitest';
import { createBlock, serializeBlocksToMarkdown, compareBlockPositions, createSequentialPositions } from './blockTypes';

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

    it('handles empty content', () => {
      const blocks = [createBlock('', 'bullet', 0, positions[0])];
      const markdown = serializeBlocksToMarkdown(blocks);
      expect(markdown).toBe('- ');
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

    it('handles identical positions', () => {
      const block1 = createBlock('First', 'bullet', 0, 'abc');
      const block2 = createBlock('Second', 'bullet', 0, 'abc');

      const result = compareBlockPositions(block1, block2);
      expect(result).toBe(0);
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
});
