import { useStrings } from './useLocale';
import { normalizeSlideText } from './slideTranslation';

export interface SlideReviewProps {
  slides: string[];
  languages: readonly string[];
  /** Current editable draft text, keyed by language then slide index. */
  drafts: Record<string, string[]>;
  /** The translation currently saved as reviewed in the library (null if none). */
  savedTexts: Record<string, (string | null)[]>;
  editable: boolean;
  /** True while a network action (suggest/save) is in flight. */
  busy: boolean;
  onDraftChange: (language: string, slideIndex: number, value: string) => void;
  onSaveCell: (language: string, slideIndex: number) => void;
}

type CellState = 'reviewed' | 'unsaved' | 'empty';

function cellState(draft: string, savedText: string | null): CellState {
  if (draft.trim() === '') return 'empty';
  if (savedText !== null && normalizeSlideText(savedText) === normalizeSlideText(draft)) {
    return 'reviewed';
  }
  return 'unsaved';
}

/**
 * Pure grid for reviewing/editing slide translations: one row per slide, one column
 * per target language, plus the source text. Each cell shows the draft translation,
 * a saved/unsaved status chip, and a per-cell Save button. All data and persistence
 * are owned by the container.
 */
export function SlideReview({
  slides,
  languages,
  drafts,
  savedTexts,
  editable,
  busy,
  onDraftChange,
  onSaveCell,
}: SlideReviewProps) {
  const s = useStrings();

  if (slides.length === 0) {
    return <div className="p-4 text-gray-500 dark:text-gray-400 italic">{s.noSlidesToReview}</div>;
  }

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
              className="border-t border-gray-200 dark:border-gray-700 align-top"
            >
              <td className="p-2 whitespace-pre-wrap text-gray-700 dark:text-gray-300">{slide}</td>
              {languages.map((language) => {
                const draft = drafts[language]?.[slideIndex] ?? '';
                const savedText = savedTexts[language]?.[slideIndex] ?? null;
                const state = cellState(draft, savedText);
                return (
                  <td key={language} className="p-2">
                    <textarea
                      aria-label={`${language} slide ${slideIndex + 1}`}
                      className="w-full min-h-[3rem] rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 p-1 text-sm resize-y disabled:opacity-60"
                      value={draft}
                      disabled={!editable}
                      onChange={(e) => onDraftChange(language, slideIndex, e.target.value)}
                    />
                    <div className="mt-1 flex items-center gap-2">
                      {state === 'reviewed' && (
                        <span className="text-xs font-medium text-green-700 dark:text-green-400">
                          ✓ {s.statusReviewed}
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
