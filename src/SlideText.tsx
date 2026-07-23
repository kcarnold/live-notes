import type { ReactNode } from 'react';
import { useFitText } from './useFitText';

// Non-breaking space so blank lines keep their height (and testing-library can
// match them without whitespace-collapsing).
const BLANK_LINE = ' ';

export interface SlideTextProps {
  /** Lines of the slide, already split on newlines. Omit to show `placeholder`. */
  lines?: string[];
  /** Optional content above the text (e.g. translation badges). Not scaled. */
  header?: ReactNode;
  /** Rendered in place of `lines` when there is nothing to show (e.g. "not translated"). */
  placeholder?: ReactNode;
}

/**
 * Shared presentation for a single slide: a full-height black panel whose text
 * is auto-scaled to fit without vertical scrolling.
 *
 * Both the original-language slide viewer and the translation viewer render
 * through here so the shell and the fit behavior live in one place.
 */
export function SlideText({ lines, header, placeholder }: SlideTextProps) {
  // Re-fit whenever the content changes.
  const contentKey = placeholder != null ? ' placeholder' : (lines ?? []).join('\n');
  const { containerRef, textRef, fontSize } = useFitText<HTMLDivElement, HTMLDivElement>([
    contentKey,
  ]);

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full bg-black dark:bg-gray-950 text-white overflow-hidden">
      <div
        ref={containerRef}
        style={{ fontSize }}
        className="flex-1 min-h-0 overflow-hidden flex flex-col justify-center px-2 py-2"
      >
        <div ref={textRef} className="w-full">
          {header && <div className="mb-1">{header}</div>}
          {placeholder != null ? (
            <div className="text-center">{placeholder}</div>
          ) : (
            <div className="text-center leading-tight space-y-1">
              {(lines ?? []).map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines have no stable id
                <div key={i}>{line || BLANK_LINE}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
