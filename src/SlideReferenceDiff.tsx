import { useState } from 'react';

import type { LookupDiff } from './referenceLookupDiff';
import { cardClass, chipClass, subtleTextClass } from './slideReviewStyles';
import { useStrings } from './useLocale';

/**
 * Shows where the agent's translation drifts from the canonical text it looked up.
 *
 * Deliberately generic: a "reference" is whatever a registered lookup adapter produced —
 * Scripture now, creeds and confessions later — so nothing here names the Bible. The base of
 * each diff is the canonical wording, so a **removed** span is text the published translation
 * has and the agent dropped or changed, and an **added** span is the agent's own wording.
 *
 * Pure: takes computed diffs, renders nothing when there are none.
 */
export interface SlideReferenceDiffProps {
  diffs: LookupDiff[];
}

export function SlideReferenceDiff({ diffs }: SlideReferenceDiffProps) {
  const s = useStrings();
  const [open, setOpen] = useState(true);

  if (diffs.length === 0) return null;

  return (
    <section className={`${cardClass} p-2 flex flex-col gap-2`}>
      <button
        type="button"
        className="flex items-center gap-2 text-left"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <span aria-hidden="true" className="text-gray-500 dark:text-gray-400 text-xs">
          {open ? '▾' : '▸'}
        </span>
        <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-200">
          {s.referenceCheckHeader}
        </h3>
        <span className={chipClass}>{diffs.length}</span>
      </button>

      {open && (
        <>
          <p className={subtleTextClass}>{s.referenceCheckLegend}</p>
          <ul className="flex flex-col gap-2">
            {diffs.map((diff) => (
              <li key={`${diff.label}-${diff.language}`} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-gray-700 dark:text-gray-200">
                    {diff.label}
                  </span>
                  <span className={chipClass}>{diff.language}</span>
                  <span className={subtleTextClass} title={s.referenceCheckSimilarityTitle}>
                    {Math.round(diff.similarity * 100)}%
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap leading-relaxed">
                  {diff.parts.map((part, i) => {
                    const key = `${diff.label}-${diff.language}-${i}`;
                    if (part.removed) {
                      return (
                        <span
                          key={key}
                          className="line-through bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                          title={s.referenceCheckCanonical}
                        >
                          {part.value}
                        </span>
                      );
                    }
                    if (part.added) {
                      return (
                        <span
                          key={key}
                          className="bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-300"
                          title={s.referenceCheckAgent}
                        >
                          {part.value}
                        </span>
                      );
                    }
                    return <span key={key}>{part.value}</span>;
                  })}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export default SlideReferenceDiff;
