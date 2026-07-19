import { useMap } from '@y-sweet/react';
import { useStrings } from './useLocale';
import {
  resolveSlideTranslation,
  slideTranslationKey,
  type ResolvedSlideTranslation,
  type SlideTranslationEntry,
} from './slideTranslation';

export interface SlideTranslationViewerProps {
  /** Original-language source slides (for indexing/context). */
  slides: string[];
  currentIndex: number;
  /** The requested target language. */
  language: string;
  /** Resolved translation per slide (undefined = not translated yet). */
  resolvedBySlide: (ResolvedSlideTranslation | undefined)[];
  context?: number;
}

/**
 * Pure component showing the translation of the current slide.
 *
 * - An `auto` (machine, unreviewed) translation gets a subtle "unreviewed" badge.
 * - When the displayed language differs from the requested one (e.g. reviewed French
 *   shown to a Haitian Creole viewer), a small language tag is shown.
 */
export function SlideTranslationViewer({
  slides,
  currentIndex,
  resolvedBySlide,
  context = 0,
}: SlideTranslationViewerProps) {
  const s = useStrings();

  if (slides.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50 dark:bg-gray-900">
        <div className="text-gray-500 dark:text-gray-400">{s.noSlides}</div>
      </div>
    );
  }

  const startIdx = Math.max(0, currentIndex - context);
  const endIdx = Math.min(slides.length - 1, currentIndex + context);

  const visible: { index: number; isActive: boolean; resolved: ResolvedSlideTranslation | undefined }[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    visible.push({ index: i, isActive: i === currentIndex, resolved: resolvedBySlide[i] });
  }

  return (
    <div className="flex flex-col bg-black dark:bg-gray-950 text-white overflow-hidden">
      <div className="flex-1 overflow-y-auto px-1 py-1 space-y-3">
        {visible.map(({ index, isActive, resolved }) => {
          const isUnreviewed = resolved?.entry.status === 'auto';
          return (
            <div
              key={index}
              className={`transition-all duration-300 ${isActive ? 'opacity-100 scale-100' : 'opacity-40 scale-95'}`}
            >
              <div className="p-1">
                {(isUnreviewed || resolved?.isFallbackLanguage) && (
                  <div className="flex justify-center gap-2 mb-1">
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
                )}
                <div className="text-center space-y-2">
                  {resolved ? (
                    resolved.entry.text.replace(/\\n/g, '\n').split('\n').map((line, lineIdx) => (
                      <div
                        key={lineIdx}
                        className={`leading-normal ${isActive ? 'text-2xl' : 'text-xl font-light'}`}
                      >
                        {line || ' '}
                      </div>
                    ))
                  ) : (
                    <div className="text-xl font-light text-gray-500 italic">{s.notTranslated}</div>
                  )}
                </div>
              </div>
              {!isActive && (
                <div className="text-xs text-gray-500 dark:text-gray-600 mt-1 text-center">
                  {index < currentIndex ? s.previous : s.next}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
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
      context={0}
    />
  );
}
