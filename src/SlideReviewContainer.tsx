import { useCallback, useState } from 'react';
import { useMap } from '@y-sweet/react';
import { useAtomValue } from 'jotai';

import { isEditorAtom, languages } from './configAtoms';
import { useStrings } from './useLocale';
import { normalizeSlideText, slideTranslationKey } from './slideTranslation';
import { SlideReview } from './SlideReview';
import { SlideConversationPanel } from './SlideConversationPanel';
import {
  parseSlidesInput,
  lookupLibrary,
  upsertLibraryEntry,
  translateItem,
  fetchConversation,
  sendConversationMessage,
  postConversationNote,
  type BibleToolCall,
  type SlideConversation,
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
  const serviceOrderMap = useMap('proclaimServiceOrder');

  const [slidesText, setSlidesText] = useState('');
  // Title of the loaded on-air item (e.g. a Bible citation like "Psalm 23"). Passed to the
  // model as a lookup cue; cleared when the operator edits the slide text by hand.
  const [itemTitle, setItemTitle] = useState('');
  const [slides, setSlides] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<StringArrays>(() => emptyArrays(0));
  const [savedTexts, setSavedTexts] = useState<NullableStringArrays>(() => emptyNullableArrays(0));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bibleLookups, setBibleLookups] = useState<BibleToolCall[]>([]);
  // The currently selected service item (empty for an ad-hoc paste), the conversation key the
  // server is using for this item, and the agent conversation we've pulled down.
  const [selectedItemId, setSelectedItemId] = useState<string>('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<SlideConversation | null>(null);

  // The full service order (for the item picker) and a staleness flag for the selected item.
  const serviceOrder = (serviceOrderMap.get('order') as string[] | undefined) ?? [];
  const livePresentation = selectedItemId
    ? (presentationsMap.get(selectedItemId) as { slidesHash?: string } | undefined)
    : undefined;
  const sourceChanged = Boolean(
    conversation && livePresentation?.slidesHash &&
      conversation.slidesHash !== livePresentation.slidesHash,
  );

  // Seed the grid for these slides: `savedTexts` marks reviewed library entries; `drafts`
  // pre-fill from the reviewed entry, else from the live slideTranslations cache (so an item
  // the work-ahead worker auto-translated shows its text immediately, with no model call).
  const loadSavedFor = useCallback(async (slideList: string[]) => {
    const nextSaved = emptyNullableArrays(slideList.length);
    const nextDrafts = emptyArrays(slideList.length);
    await Promise.all(
      languages.map(async (language) => {
        const entries = await lookupLibrary(language, slideList);
        nextSaved[language] = entries.map((entry) => entry?.text ?? null);
        nextDrafts[language] = entries.map((entry, i) => {
          if (entry?.text) return entry.text;
          const cached = translationsMap.get(slideTranslationKey(language, slideList[i])) as
            | { text?: string }
            | undefined;
          return cached?.text ?? '';
        });
      }),
    );
    setSavedTexts(nextSaved);
    setDrafts(nextDrafts);
  }, [translationsMap]);

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

  // Load a service item's slides into the editor and pull down its agent conversation (if the
  // Proclaim service or a prior Suggest already produced one). Used by both the picker and the
  // "load on-air" button.
  const handleSelectItem = useCallback(
    (itemId: string) => {
      const presentation = itemId
        ? (presentationsMap.get(itemId) as { slides?: string[]; title?: string } | undefined)
        : undefined;
      const itemSlides = (presentation?.slides ?? []).filter((slide) => slide.trim() !== '');
      if (itemSlides.length === 0) {
        setError(s.waitingForProclaim);
        return;
      }
      setSelectedItemId(itemId);
      setConversationId(itemId);
      setItemTitle(presentation?.title ?? '');
      setSlidesText(itemSlides.join(SLIDE_DELIMITER));
      void commitSlides(itemSlides);
      void fetchConversation(itemId)
        .then(setConversation)
        .catch(() => setConversation(null));
    },
    [presentationsMap, commitSlides, s.waitingForProclaim],
  );

  const handleLoadOnAir = useCallback(() => {
    const itemId = statusMap.get('itemId') as string | undefined;
    if (!itemId) {
      setError(s.waitingForProclaim);
      return;
    }
    handleSelectItem(itemId);
  }, [statusMap, handleSelectItem, s.waitingForProclaim]);

  const handleSuggest = useCallback(async () => {
    // Parse fresh from the textarea so we never translate a stale slide set.
    const slideList = parseSlidesInput(slidesText);
    setSlides(slideList);
    if (slideList.length === 0) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    setBibleLookups([]);
    try {
      const { translations, bibleLookups: lookups, conversationId: newId } = await translateItem(
        slideList,
        [...languages],
        itemTitle.trim() || undefined,
        selectedItemId || undefined,
      );
      setBibleLookups(lookups);
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
      // Pull down the agent conversation the server just stored under this key.
      setConversationId(newId);
      const conv = await fetchConversation(newId);
      setConversation(conv);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [slidesText, itemTitle, selectedItemId]);

  // Apply translations the agent revised during a follow-up: write them live to the
  // slideTranslations map (content-addressed, so they land on the matching slides) and reflect
  // them in the editable drafts.
  const applyUpdates = useCallback(
    (updates: Array<{ language: string; sourceText: string; text: string }>) => {
      if (updates.length === 0) return;
      for (const update of updates) {
        translationsMap.set(slideTranslationKey(update.language, update.sourceText), {
          text: update.text,
          status: 'auto',
          provenance: 'llm-agent',
        });
      }
      setDrafts((prev) => {
        const next: StringArrays = { ...prev };
        for (const update of updates) {
          const idx = slides.findIndex(
            (slide) => normalizeSlideText(slide) === normalizeSlideText(update.sourceText),
          );
          if (idx < 0) continue;
          next[update.language] = [...(next[update.language] ?? [])];
          next[update.language][idx] = update.text;
        }
        return next;
      });
    },
    [translationsMap, slides],
  );

  const handleSendFollowup = useCallback(
    async (text: string) => {
      if (!conversationId) return;
      setBusy(true);
      setError(null);
      try {
        const result = await sendConversationMessage(conversationId, text);
        setConversation(result.conversation);
        if (result.bibleLookups.length > 0) setBibleLookups(result.bibleLookups);
        applyUpdates(result.updatedTranslations);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [conversationId, applyUpdates],
  );

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
        // Surface the manual edit back to the agent as a note, so a later follow-up has the
        // reviewer's wording in context. Best-effort; never blocks the save.
        if (conversationId) {
          void postConversationNote(
            conversationId,
            `Manual edit — ${language} slide ${slideIndex + 1}: ${record.text}`,
          ).catch(() => {});
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [drafts, slides, translationsMap, conversationId],
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
          onChange={(e) => {
            // A hand-edit means the loaded item title (a Bible citation) no longer applies.
            setItemTitle('');
            setSlidesText(e.target.value);
          }}
          onBlur={handleCommitFromText}
        />
      </label>

      <div className="flex items-center gap-2 flex-wrap">
        {serviceOrder.length > 0 && (
          <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
            {s.selectItemLabel}
            <select
              className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 p-1 text-sm"
              value={selectedItemId}
              onChange={(e) => {
                if (e.target.value) handleSelectItem(e.target.value);
              }}
            >
              <option value="" />
              {serviceOrder.map((id) => (
                <option key={id} value={id}>
                  {(presentationsMap.get(id) as { title?: string } | undefined)?.title ?? id}
                </option>
              ))}
            </select>
          </label>
        )}
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

      {bibleLookups.length > 0 && (
        <div className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
          <span className="font-medium">{s.bibleLookupsLabel}</span>
          <ul className="flex flex-wrap gap-2">
            {bibleLookups.map((lookup) => (
              <li
                key={`${lookup.reference}-${lookup.foundLanguages.join(',')}-${lookup.missingLanguages.join(',')}`}
                className={`px-2 py-0.5 rounded border ${
                  lookup.ok
                    ? 'border-green-300 text-green-700 dark:border-green-700 dark:text-green-400'
                    : 'border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400'
                }`}
                title={
                  lookup.ok
                    ? `${s.bibleLookupFound}: ${lookup.foundLanguages.join(', ')}`
                    : s.bibleLookupMissing
                }
              >
                {lookup.ok ? '✓' : '⚠'} {lookup.reference}
              </li>
            ))}
          </ul>
        </div>
      )}

      {sourceChanged && (
        <span className="text-xs text-amber-700 dark:text-amber-400">{s.sourceChangedWarning}</span>
      )}

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

      <SlideConversationPanel
        conversation={conversation}
        busy={busy}
        editable={isEditor}
        onSend={(text) => void handleSendFollowup(text)}
      />
    </div>
  );
}

export default SlideReviewContainer;
