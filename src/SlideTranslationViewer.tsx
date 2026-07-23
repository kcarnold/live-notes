import { useMap } from '@y-sweet/react';
import { useStrings } from './useLocale';
import { SlideText } from './SlideText';
import {
  resolveSlideTranslation,
  slideTranslationKey,
  type ResolvedSlideTranslation,
  type SlideTranslationEntry,
} from './slideTranslation';

export interface SlideTranslationViewerProps {
  /** Original-language source slides (for indexing). */
  slides: string[];
  currentIndex: number;
  /** The requested target language. */
  language: string;
  /** Resolved translation per slide (undefined = not translated yet). */
  resolvedBySlide: (ResolvedSlideTranslation | undefined)[];
}

/**
 * Pure component showing the translation of the current slide, auto-scaled to fit.
 *
 * - An `auto` (machine, unreviewed) translation gets a subtle "unreviewed" badge.
 * - When the displayed language differs from the requested one (e.g. reviewed French
 *   shown to a Haitian Creole viewer), a small language tag is shown.
 */
export function SlideTranslationViewer({
  slides,
  currentIndex,
  resolvedBySlide,
}: SlideTranslationViewerProps) {
  const s = useStrings();

  if (slides.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50 dark:bg-gray-900">
        <div className="text-gray-500 dark:text-gray-400">{s.noSlides}</div>
      </div>
    );
  }

  // Clamp: Proclaim publishes status and presentation separately, so the index
  // can transiently point past the slides.
  const clampedIndex = Math.min(Math.max(currentIndex, 0), slides.length - 1);
  const resolved = resolvedBySlide[clampedIndex];
  const isUnreviewed = resolved?.entry.status === 'auto';

  const header =
    isUnreviewed || resolved?.isFallbackLanguage ? (
      <div className="flex justify-center gap-2">
        {resolved?.isFallbackLanguage && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-200">
            {resolved.displayLanguage}
          </span>
        )}
        {isUnreviewed && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-700/80 text-amber-50 opacity-20">
            {s.unreviewedBadge}
          </span>
        )}
      </div>
    ) : undefined;

  if (!resolved) {
    return (
      <SlideText
        header={header}
        placeholder={<span className="text-gray-500 italic">{s.notTranslated}</span>}
      />
    );
  }

  return <SlideText lines={resolved.entry.text.split('\n')} header={header} />;
}

/** Yjs connector: reads the source slides + per-day slideTranslations and resolves. */
export function SlideTranslationViewerContainer({ language }: { language: string }) {
  const s = useStrings();
  const statusMap = useMap('proclaimStatus');
  const presentationsMap = useMap('proclaimPresentations');
  const translationsMap = useMap('slideTranslations');

  let view: { slides: string[]; slideIndex: number; resolvedBySlide: (ResolvedSlideTranslation | undefined)[] } | null = null;
  try {
    const itemId = statusMap.get('itemId') as string | undefined;
    if (!itemId) throw new Error('No itemId in statusMap');
    const slideIndex = (statusMap.get('slideIndex') as number) ?? 0;

    const presentation = presentationsMap.get(itemId) as { slides?: string[] } | undefined;
    if (!presentation) throw new Error('Presentation not found');

    const slides = (presentation.slides ?? []).filter((slide): slide is string => typeof slide === 'string');

    const lookup = (lang: string, slideText: string) =>
      translationsMap.get(slideTranslationKey(lang, slideText)) as SlideTranslationEntry | undefined;

    const resolvedBySlide = slides.map((slideText) =>
      slideText.trim() === '' ? undefined : resolveSlideTranslation(language, slideText, lookup),
    );

    view = { slides, slideIndex, resolvedBySlide };
  } catch {
    view = null;
  }

  if (!view) {
    return (
      <div className="flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-gray-500 dark:text-gray-400">
          {s.waitingForProclaim}
          <div className="text-xs mt-2">{s.isProclaimRunning}</div>
        </div>
      </div>
    );
  }

  return (
    <SlideTranslationViewer
      slides={view.slides}
      currentIndex={view.slideIndex}
      language={language}
      resolvedBySlide={view.resolvedBySlide}
    />
  );
}
