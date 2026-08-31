// The −/+ pair that sets the reading font size, shared by every pane that shows
// text a viewer reads at a distance: the translated/bilingual outline views and the
// live transcript. One control, one `fontSizeAtom` (persisted per device), so
// bumping the size in one pane bumps it everywhere — a viewer sets their reading
// size once, not per pane.
//
// Rendered inside a flex header row; the leading spacer pushes the buttons to the
// right of whatever titles/selectors precede them.
import { useAtom } from "jotai";
import { fontSizeAtom } from "./configAtoms";
import { useStrings } from "./useLocale";

export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 32;
const FONT_SIZE_STEP = 2;

export function FontSizeControls() {
  const s = useStrings();
  const [fontSize, setFontSize] = useAtom(fontSizeAtom);

  return (
    <>
      <div className="flex-1" />
      <button
        type="button"
        aria-label={s.decreaseFontSize}
        onClick={() => setFontSize(Math.max(MIN_FONT_SIZE, (fontSize || 16) - FONT_SIZE_STEP))}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" role="img" aria-label={s.decreaseFontSize}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={s.increaseFontSize}
        onClick={() => setFontSize(Math.min(MAX_FONT_SIZE, (fontSize || 16) + FONT_SIZE_STEP))}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" role="img" aria-label={s.increaseFontSize}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
      </button>
    </>
  );
}
