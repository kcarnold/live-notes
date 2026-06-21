import { useCallback, useState } from 'react';
import { useMap } from '@y-sweet/react';
import { useAtomValue } from 'jotai';

import { isEditorAtom, languages } from './configAtoms';
import { useStrings } from './useLocale';
import { slideTranslationKey } from './slideTranslation';
import { SlideReview } from './SlideReview';
import {
  parseSlidesInput,
  lookupLibrary,
  upsertLibraryEntry,
  translateItem,
} from './slideTranslationApi';

type StringArrays = Record<string, string[]>;
type NullableStringArrays = Record<string, (string | null)[]>;

const SLIDE_DELIMITER = '\n--\n';

function emptyArrays(length: number): StringArrays {
  return Object.fromEntries(languages.map((language) => [language, Array<string>(length).fill('')]));
}

function emptyNullableArrays(length: number): NullableStringArrays {
  return Object.fromEntries(
    languages.map((language) => [language, Array<string | null>(length).fill(null)]),
  );
}

/**
 * Yjs/network connector for the slide-translation review screen.
 *
 * Holds the editable item (pasted or loaded from the on-air Proclaim item), the
 * per-language draft translations, and the library state. "Suggest" pre-fills drafts
 * from the LLM (reusing reviewed library entries); "Save" promotes a draft to a
 * reviewed library entry.
 */
export function SlideReviewContainer() {
  const s = useStrings();
  const isEditor = useAtomValue(isEditorAtom);
  const statusMap = useMap('proclaimStatus');
  const presentationsMap = useMap('proclaimPresentations');
  const translationsMap = useMap('slideTranslations');

  const [slidesText, setSlidesText] = useState('');
  const [slides, setSlides] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<StringArrays>(() => emptyArrays(0));
  const [savedTexts, setSavedTexts] = useState<NullableStringArrays>(() => emptyNullableArrays(0));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Look up reviewed library entries for these slides and seed drafts from them.
  const loadSavedFor = useCallback(async (slideList: string[]) => {
    const nextSaved = emptyNullableArrays(slideList.length);
    const nextDrafts = emptyArrays(slideList.length);
    await Promise.all(
      languages.map(async (language) => {
        const entries = await lookupLibrary(language, slideList);
        nextSaved[language] = entries.map((entry) => entry?.text ?? null);
        nextDrafts[language] = entries.map((entry) => entry?.text ?? '');
      }),
    );
    setSavedTexts(nextSaved);
    setDrafts(nextDrafts);
  }, []);

  const commitSlides = useCallback(
    async (slideList: string[]) => {
      setError(null);
      setMessage(null);
      setSlides(slideList);
      setDrafts(emptyArrays(slideList.length));
      setSavedTexts(emptyNullableArrays(slideList.length));
      if (slideList.length === 0) return;
      setBusy(true);
      try {
        await loadSavedFor(slideList);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [loadSavedFor],
  );

  const handleCommitFromText = useCallback(() => {
    void commitSlides(parseSlidesInput(slidesText));
  }, [commitSlides, slidesText]);

  const handleLoadOnAir = useCallback(() => {
    const itemId = statusMap.get('itemId') as string | undefined;
    const presentation = itemId
      ? (presentationsMap.get(itemId) as { slides?: string[] } | undefined)
      : undefined;
    const itemSlides = (presentation?.slides ?? []).filter((slide) => slide.trim() !== '');
    if (itemSlides.length === 0) {
      setError(s.waitingForProclaim);
      return;
    }
    setSlidesText(itemSlides.join(SLIDE_DELIMITER));
    void commitSlides(itemSlides);
  }, [statusMap, presentationsMap, commitSlides, s.waitingForProclaim]);

  const handleSuggest = useCallback(async () => {
    // Parse fresh from the textarea so we never translate a stale slide set.
    const slideList = parseSlidesInput(slidesText);
    setSlides(slideList);
    if (slideList.length === 0) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const translations = await translateItem(slideList, [...languages]);
      const nextDrafts = emptyArrays(slideList.length);
      const nextSaved = emptyNullableArrays(slideList.length);
      for (const language of languages) {
        const perSlide = translations[language] ?? [];
        nextDrafts[language] = slideList.map((_, i) => perSlide[i]?.text ?? '');
        // Reviewed suggestions already exist in the library; reflect that as saved.
        nextSaved[language] = slideList.map((_, i) =>
          perSlide[i]?.status === 'reviewed' ? perSlide[i].text : null,
        );
      }
      setDrafts(nextDrafts);
      setSavedTexts(nextSaved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [slidesText]);

  const handleSaveCell = useCallback(
    async (language: string, slideIndex: number) => {
      const text = drafts[language]?.[slideIndex] ?? '';
      const sourceText = slides[slideIndex];
      if (!sourceText || text.trim() === '') return;
      setBusy(true);
      setError(null);
      try {
        const record = await upsertLibraryEntry({ language, sourceText, text });
        // Push the reviewed entry into the live (per-day) slideTranslations map so the
        // viewer updates immediately. Keys are content-addressed, so this lands on any
        // on-screen slide with matching text. Otherwise the only writer is the Proclaim
        // service, which won't re-push an item whose slide content hasn't changed.
        translationsMap.set(slideTranslationKey(language, sourceText), {
          text: record.text,
          status: record.status,
          provenance: record.provenance,
          reviewedAt: record.reviewedAt,
        });
        setSavedTexts((prev) => {
          const next = { ...prev, [language]: [...(prev[language] ?? [])] };
          next[language][slideIndex] = record.text;
          return next;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [drafts, slides, translationsMap],
  );

  const handleDraftChange = useCallback(
    (language: string, slideIndex: number, value: string) => {
      setDrafts((prev) => {
        const next = { ...prev, [language]: [...(prev[language] ?? [])] };
        next[language][slideIndex] = value;
        return next;
      });
    },
    [],
  );

  const buttonClass =
    'px-3 py-1 rounded text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40';
  const secondaryButtonClass =
    'px-3 py-1 rounded text-sm font-medium bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600 disabled:opacity-40';

  return (
    <div className="flex flex-col gap-3 h-full overflow-auto p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="font-semibold text-gray-700 dark:text-gray-200">{s.slideReviewTitle}</h2>
        {!isEditor && (
          <span className="text-xs text-amber-700 dark:text-amber-400">{s.editorOnlyReview}</span>
        )}
      </div>

      <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
        {s.slidesInputLabel}
        <textarea
          className="w-full min-h-[5rem] rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 text-sm font-mono"
          value={slidesText}
          onChange={(e) => setSlidesText(e.target.value)}
          onBlur={handleCommitFromText}
        />
      </label>

      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" className={secondaryButtonClass} onClick={handleLoadOnAir} disabled={busy}>
          {s.loadOnAirItem}
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => void handleSuggest()}
          disabled={busy || slides.length === 0}
        >
          {busy ? s.suggesting : s.suggestTranslations}
        </button>
        {message && <span className="text-xs text-green-700 dark:text-green-400">{message}</span>}
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </div>

      <SlideReview
        slides={slides}
        languages={languages}
        drafts={drafts}
        savedTexts={savedTexts}
        editable={isEditor}
        busy={busy}
        onDraftChange={handleDraftChange}
        onSaveCell={(language, slideIndex) => void handleSaveCell(language, slideIndex)}
      />
    </div>
  );
}

export default SlideReviewContainer;
