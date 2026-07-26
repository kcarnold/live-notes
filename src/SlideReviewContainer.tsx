import { useCallback, useMemo, useState } from 'react';
import { useMap } from '@y-sweet/react';
import { useAtomValue } from 'jotai';

import { isEditorAtom, languages } from './configAtoms';
import { useStrings } from './useLocale';
import { normalizeSlideText, slideTranslationKey } from './slideTranslation';
import { SlideReview } from './SlideReview';
import { SlideConversationPanel } from './SlideConversationPanel';
import { SlideReferenceDiff } from './SlideReferenceDiff';
import { computeLookupDiffs, extractLookups } from './referenceLookupDiff';
import { inputClass, secondaryButtonClass, subtleTextClass } from './slideReviewStyles';
import {
  lookupLibrary,
  upsertLibraryEntry,
  translateItem,
  sendConversationMessage,
  postConversationNote,
  type SlideConversation,
} from './slideTranslationApi';

type StringArrays = Record<string, string[]>;
type NullableStringArrays = Record<string, (string | null)[]>;

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
 * The screen is selection-driven: pick a service item (or load the on-air one) and its
 * slides, the agent's drafts, and the agent's conversation all follow. The Proclaim service
 * translates on-air items on its own, so the reviewer's job is to *correct*, not to
 * originate — "Save" promotes a draft to a reviewed library entry, and "Re-translate" is the
 * fallback for an item the service never got to (or got wrong enough to restart).
 */
export function SlideReviewContainer() {
  const s = useStrings();
  const isEditor = useAtomValue(isEditorAtom);
  const statusMap = useMap('proclaimStatus');
  const presentationsMap = useMap('proclaimPresentations');
  const translationsMap = useMap('slideTranslations');
  const serviceOrderMap = useMap('proclaimServiceOrder');
  // The agent conversation lives in the per-day doc (server-written), so we read it live.
  const conversationsMap = useMap('slideConversations');

  const [slides, setSlides] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<StringArrays>(() => emptyArrays(0));
  const [savedTexts, setSavedTexts] = useState<NullableStringArrays>(() => emptyNullableArrays(0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The currently selected service item, the conversation key the server is using for it, and
  // the agent conversation we've pulled down.
  const [selectedItemId, setSelectedItemId] = useState<string>('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Derived live from Yjs: the server writes the conversation into `slideConversations`, and
  // useMap re-renders on change, so status/messages/tool-calls stream in as the agent runs.
  const conversation =
    (conversationId ? (conversationsMap.get(conversationId) as SlideConversation | undefined) : undefined) ?? null;

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

  // Slides always come from the service item itself, read fresh at the moment they're needed,
  // so a Proclaim edit between selecting an item and re-translating it can't leave us working
  // from a stale copy.
  const readItemSlides = useCallback(
    (itemId: string): string[] => {
      const presentation = itemId
        ? (presentationsMap.get(itemId) as { slides?: string[] } | undefined)
        : undefined;
      return (presentation?.slides ?? []).filter((slide) => slide.trim() !== '');
    },
    [presentationsMap],
  );

  const commitSlides = useCallback(
    async (slideList: string[]) => {
      setError(null);
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

  // Load a service item's slides and pull down its agent conversation (if the Proclaim service
  // or an earlier re-translate already produced one). Used by both the picker and the "load
  // on-air" button — the only two ways slides enter this screen.
  const handleSelectItem = useCallback(
    (itemId: string) => {
      const itemSlides = readItemSlides(itemId);
      if (itemSlides.length === 0) {
        setError(s.waitingForProclaim);
        return;
      }
      setSelectedItemId(itemId);
      // The conversation (if any) is read live from `slideConversations` keyed by itemId.
      setConversationId(itemId);
      void commitSlides(itemSlides);
    },
    [readItemSlides, commitSlides, s.waitingForProclaim],
  );

  const handleLoadOnAir = useCallback(() => {
    const itemId = statusMap.get('itemId') as string | undefined;
    if (!itemId) {
      setError(s.waitingForProclaim);
      return;
    }
    handleSelectItem(itemId);
  }, [statusMap, handleSelectItem, s.waitingForProclaim]);

  /**
   * Re-run the drafting agent over the selected item.
   *
   * The Proclaim service already does this for on-air items, so this is the fallback: an item
   * the service never reached, or one whose draft is wrong enough that correcting it by hand
   * costs more than starting over.
   */
  const handleReTranslate = useCallback(async () => {
    if (!selectedItemId) return;
    const slideList = readItemSlides(selectedItemId);
    setSlides(slideList);
    if (slideList.length === 0) {
      setError(s.waitingForProclaim);
      return;
    }
    // The item title (often a Bible citation like "Psalm 23") is the model's lookup cue.
    const itemTitle = (presentationsMap.get(selectedItemId) as { title?: string } | undefined)?.title;
    setBusy(true);
    setError(null);
    try {
      const { translations, conversationId: newId } = await translateItem(
        slideList,
        [...languages],
        itemTitle?.trim() || undefined,
        selectedItemId,
      );
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
      // The server stored the agent conversation under this key; we read it live from Yjs.
      setConversationId(newId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selectedItemId, readItemSlides, presentationsMap, s.waitingForProclaim]);

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
        // Send the current drafts so the agent can make targeted edits against what the
        // reviewer is actually looking at. The updated conversation streams in live via Yjs;
        // we only need the side outputs.
        const result = await sendConversationMessage(conversationId, text, drafts);
        applyUpdates(result.updatedTranslations);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [conversationId, applyUpdates, drafts],
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

  // The canonical texts the agent looked up are already in the conversation, so the reference
  // check is entirely client-side. Recompute only when the conversation or drafts move.
  const referenceDiffs = useMemo(
    () => computeLookupDiffs(extractLookups(conversation?.messages ?? []), drafts, [...languages]),
    [conversation, drafts],
  );

  // An item the Proclaim service never translated: slides loaded, but nothing to review yet.
  const hasAnyDraft = languages.some((language) =>
    (drafts[language] ?? []).some((text) => text.trim() !== ''),
  );
  const untranslated = slides.length > 0 && !conversation && !hasAnyDraft;

  return (
    <div className="flex flex-col gap-3 h-full overflow-auto p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="font-semibold text-gray-700 dark:text-gray-200">{s.slideReviewTitle}</h2>
        {!isEditor && (
          <span className="text-xs text-amber-700 dark:text-amber-400">{s.editorOnlyReview}</span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {serviceOrder.length > 0 && (
          <label className={`flex items-center gap-1 ${subtleTextClass}`}>
            {s.selectItemLabel}
            <select
              className={inputClass}
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
        {/* The Proclaim service drafts on-air items on its own; this is the fallback, so it
            stays secondary and only lights up once an item is selected. */}
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={() => void handleReTranslate()}
          disabled={busy || !selectedItemId || !isEditor}
        >
          {busy ? s.reTranslating : s.reTranslate}
        </button>
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </div>

      {sourceChanged && (
        <span className="text-xs text-amber-700 dark:text-amber-400">{s.sourceChangedWarning}</span>
      )}

      {untranslated && (
        <span className="text-xs text-amber-700 dark:text-amber-400">{s.notTranslatedYet}</span>
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

      <SlideReferenceDiff diffs={referenceDiffs} />

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
