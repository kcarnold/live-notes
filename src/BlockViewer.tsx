import React from 'react';
import { Block } from './blockTypes';

interface BlockViewerProps {
  /** Blocks to display (should be sorted by position before passing) */
  blocks: Block[];
  /** Language to display (if provided, shows translation instead of original content) */
  language?: string;
  /** Optional font size override */
  fontSize?: number;
  /** Optional callback when a block is clicked */
  onBlockClick?: (block: Block, index: number) => void;
  /** Optional function to determine if a block should be highlighted */
  getBlockClassName?: (block: Block, index: number) => string;
}

/**
 * BlockViewer component - renders blocks directly without Markdown conversion
 *
 * Displays blocks based on their type (heading/bullet) and level (indentation).
 * Can show original content or translations.
 */
export const BlockViewer: React.FC<BlockViewerProps> = ({
  blocks,
  language,
  fontSize,
  onBlockClick,
  getBlockClassName,
}) => {
  const renderBlock = (block: Block, index: number) => {
    // Get content: translation if language is specified and available, otherwise original
    const content = language && block.translations[language]
      ? block.translations[language]
      : block.content;

    // Skip empty blocks
    if (content.trim() === '') {
      return null;
    }

    const isHeading = block.type === 'heading';
    const indentLevel = block.level;

    // Calculate indent style
    const indentStyle = {
      paddingLeft: `${indentLevel * 1.5}rem`,
    };

    // Heading styles based on level
    const headingClassName = isHeading
      ? indentLevel === 0
        ? 'text-2xl font-bold mt-4 mb-2'
        : indentLevel === 1
        ? 'text-xl font-bold mt-3 mb-2'
        : indentLevel === 2
        ? 'text-lg font-semibold mt-2 mb-1'
        : 'text-base font-semibold mt-2 mb-1'
      : '';

    // Get custom className from prop
    const customClassName = getBlockClassName ? getBlockClassName(block, index) : '';

    return (
      <div
        key={block.id}
        onClick={() => onBlockClick?.(block, index)}
        className={`
          ${onBlockClick ? 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : ''}
          ${customClassName}
        `}
        style={indentStyle}
      >
        {isHeading ? (
          <div className={headingClassName}>{content}</div>
        ) : (
          <div className="flex items-start gap-2 my-1">
            <span className="select-none flex-shrink-0">•</span>
            <span className="flex-1">{content}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="overflow-auto pb-16 max-w-2xl w-full mx-auto flex-1"
      style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
    >
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
};
