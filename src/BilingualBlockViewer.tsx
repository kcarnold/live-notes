import { Block } from './blockTypes';

export interface BilingualBlockViewerProps {
  blocks: Block[];
  translations: Map<string, string>;  // cacheKey → translated text
  language: string;
  fontSize?: number;
}

/**
 * Pure component that renders blocks with both original and translated text.
 *
 * Each block is displayed with:
 * - Original text (dimmer, smaller)
 * - Translated text (prominent)
 *
 * Translation lookup uses the same cache key format as the translation pipeline:
 * `${language}:${content}` where content is the text without markdown formatting.
 */
export function BilingualBlockViewer({
  blocks,
  translations,
  language,
  fontSize = 24,
}: BilingualBlockViewerProps) {
  // Filter out empty blocks
  const nonEmptyBlocks = blocks.filter(block => block.content.trim() !== '');

  if (nonEmptyBlocks.length === 0) {
    return (
      <div className="p-4 text-gray-500 dark:text-gray-400 italic">
        No content yet
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 overflow-auto h-full">
      {nonEmptyBlocks.map((block) => {
        // Cache key matches translationUtils.ts: `${language}:${content}`
        const cacheKey = `${language}:${block.content.trim()}`;
        const translation = translations.get(cacheKey);

        return (
          <BlockPair
            key={block.id}
            block={block}
            translation={translation}
            fontSize={fontSize}
          />
        );
      })}
    </div>
  );
}

interface BlockPairProps {
  block: Block;
  translation: string | undefined;
  fontSize: number;
}

function BlockPair({ block, translation, fontSize }: BlockPairProps) {
  // Compute indent based on block level
  const indentClass = block.level > 0 ? `ml-${block.level * 4}` : '';

  // Heading style
  const isHeading = block.type === 'heading';
  const headingClass = isHeading ? 'font-bold' : '';

  return (
    <div className={`flex flex-col gap-1 ${indentClass}`}>
      {/* Original text - smaller and dimmer */}
      <div
        className={`text-gray-500 dark:text-gray-400 ${headingClass}`}
        style={{ fontSize: fontSize * 0.6 }}
      >
        {isHeading && <span className="text-gray-400 dark:text-gray-500 mr-1">{'#'.repeat(block.level + 2)}</span>}
        {block.type === 'bullet' && <span className="text-gray-400 dark:text-gray-500 mr-1">•</span>}
        {block.content}
      </div>

      {/* Translated text - prominent */}
      <div
        className={`text-gray-900 dark:text-gray-100 ${headingClass}`}
        style={{ fontSize }}
      >
        {translation ?? (
          <span className="text-gray-400 dark:text-gray-500 italic">
            (not translated)
          </span>
        )}
      </div>
    </div>
  );
}

export default BilingualBlockViewer;
