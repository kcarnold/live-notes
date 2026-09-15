import { useStrings } from './useLocale';
import { normalizeSlideText } from './slideTranslation';

export interface SlideReviewProps {
  slides: string[];
  languages: readonly string[];
  /** Current editable draft text, keyed by language then slide index. */
  drafts: Record<string, string[]>;
  /** The translation currently saved in the library (null if none). */
  savedTexts: Record<string, (string | null)[]>;
  /**
   * The translator's caveat for a cell, keyed by language then slide index (null = none).
   * These are the reason to be on this screen at all, so they read before the text.
   */
  notes: Record<string, (string | null)[]>;
  editable: boolean;
  /** True while a network action (suggest/save) is in flight. */
  busy: boolean;
  onDraftChange: (language: string, slideIndex: number, value: string) => void;
  onSaveCell: (language: string, slideIndex: number) => void;
}

type CellState = 'saved' | 'unsaved' | 'empty';

function cellState(draft: string, savedText: string | null): CellState {
  if (draft.trim() === '') return 'empty';
  if (savedText !== null && normalizeSlideText(savedText) === normalizeSlideText(draft)) {
    return 'saved';
  }
  return 'unsaved';
}

/**
 * Pure grid for reviewing/editing slide translations: one row per slide, one column
 * per target language, plus the source text. A cell whose translation the translator
 * flagged leads with that note; the row is marked too, so a long item can be skimmed
 * for the handful of slides that actually want attention. All data and persistence
 * are owned by the container.
 */
export function SlideReview({
  slides,
  languages,
  drafts,
  savedTexts,
  notes,
  editable,
  busy,
  onDraftChange,
  onSaveCell,
}: SlideReviewProps) {
  const s = useStrings();

  if (slides.length === 0) {
    return <div className="p-4 text-gray-500 dark:text-gray-400 italic">{s.noSlidesToReview}</div>;
  }

  const rowHasNote = slides.map((_, slideIndex) =>
    languages.some((language) => notes[language]?.[slideIndex]),
  );

  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <th className="p-2 align-bottom w-1/4">{s.reviewSourceHeader}</th>
            {languages.map((language) => (
              <th key={language} className="p-2 align-bottom">{language}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slides.map((slide, slideIndex) => (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: slide order is stable within a render
              key={slideIndex}
              className={`border-t border-gray-200 dark:border-gray-700 align-top ${
                rowHasNote[slideIndex] ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''
              }`}
            >
              <td className="p-2 whitespace-pre-wrap text-gray-700 dark:text-gray-300">
                {rowHasNote[slideIndex] && (
                  <span className="mr-1" title={s.reviewNotesHint} aria-label={s.reviewNotesLabel}>
                    📝
                  </span>
                )}
                {slide}
              </td>
              {languages.map((language) => {
                const draft = drafts[language]?.[slideIndex] ?? '';
                const savedText = savedTexts[language]?.[slideIndex] ?? null;
                const note = notes[language]?.[slideIndex] ?? null;
                const state = cellState(draft, savedText);
                return (
                  <td key={language} className="p-2">
                    {note && (
                      <p className="mb-1 rounded border-l-2 border-amber-500 bg-amber-100 px-2 py-1 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                        {note}
                      </p>
                    )}
                    <textarea
                      aria-label={`${language} slide ${slideIndex + 1}`}
                      className="w-full min-h-[3rem] rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 p-1 text-sm resize-y disabled:opacity-60"
                      value={draft}
                      disabled={!editable}
                      onChange={(e) => onDraftChange(language, slideIndex, e.target.value)}
                    />
                    <div className="mt-1 flex items-center gap-2">
                      {state === 'saved' && (
                        <span className="text-xs font-medium text-green-700 dark:text-green-400">
                          ✓ {s.statusSaved}
                        </span>
                      )}
                      {state === 'unsaved' && (
                        <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
                          {s.statusUnsaved}
                        </span>
                      )}
                      {editable && (
                        <button
                          type="button"
                          className="ml-auto px-2 py-0.5 rounded bg-blue-500 text-white text-xs hover:bg-blue-600 disabled:opacity-40"
                          disabled={busy || state !== 'unsaved'}
                          onClick={() => onSaveCell(language, slideIndex)}
                        >
                          {s.save}
                        </button>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default SlideReview;
