import { describe, it, expect } from 'vitest';
import { createBlock, serializeBlocksToMarkdown } from './blockTypes';

describe('blockTypes', () => {
  describe('serializeBlocksToMarkdown', () => {
    it('serializes bullets without indentation', () => {
      const blocks = [
        createBlock('First item', 'bullet', 0),
        createBlock('Second item', 'bullet', 0),
      ];
      const markdown = serializeBlocksToMarkdown(blocks);
      expect(markdown).toBe('- First item\n- Second item');
    });

    it('serializes headings', () => {
      const blocks = [
        createBlock('Main Title', 'heading', 0),
        createBlock('Content', 'bullet', 0),
      ];
      const markdown = serializeBlocksToMarkdown(blocks);
      expect(markdown).toBe('## Main Title\n- Content');
    });

    it('serializes indented bullets', () => {
      const blocks = [
        createBlock('Level 0', 'bullet', 0),
        createBlock('Level 1', 'bullet', 1),
        createBlock('Level 2', 'bullet', 2),
      ];
      const markdown = serializeBlocksToMarkdown(blocks);
      expect(markdown).toBe('- Level 0\n  - Level 1\n    - Level 2');
    });

    it('serializes mixed content with indentation', () => {
      const blocks = [
        createBlock('Title', 'heading', 0),
        createBlock('First point', 'bullet', 0),
        createBlock('Nested point', 'bullet', 1),
        createBlock('Another point', 'bullet', 0),
      ];
      const markdown = serializeBlocksToMarkdown(blocks);
      expect(markdown).toBe('## Title\n- First point\n  - Nested point\n- Another point');
    });

    it('handles empty content', () => {
      const blocks = [createBlock('', 'bullet', 0)];
      const markdown = serializeBlocksToMarkdown(blocks);
      expect(markdown).toBe('- ');
    });

    it('handles maximum indentation', () => {
      const blocks = [createBlock('Deep', 'bullet', 5)];
      const markdown = serializeBlocksToMarkdown(blocks);
      expect(markdown).toBe('          - Deep'); // 10 spaces (5 levels * 2 spaces)
    });
  });

  describe('createBlock', () => {
    it('creates block with defaults', () => {
      const block = createBlock();
      expect(block.content).toBe('');
      expect(block.type).toBe('bullet');
      expect(block.level).toBe(0);
      expect(block.id).toBeDefined();
    });

    it('caps level at maximum', () => {
      const block = createBlock('test', 'bullet', 99);
      expect(block.level).toBe(5);
    });

    it('prevents negative levels', () => {
      const block = createBlock('test', 'bullet', -1);
      expect(block.level).toBe(0);
    });
  });
});
