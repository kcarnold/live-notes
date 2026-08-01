import { useMap } from '@y-sweet/react';
import { useStrings } from './useLocale';
import { SlideText } from './SlideText';

interface CurrentSlideViewerProps {
  title: string;
  slides: string[];
  currentIndex: number;
}

/**
 * Pure component that displays the current slide, auto-scaled to fit.
 */
export function CurrentSlideViewer({ slides, currentIndex }: CurrentSlideViewerProps) {
  const s = useStrings();

  if (slides.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50 dark:bg-gray-900">
        <div className="text-gray-500 dark:text-gray-400">{s.noSlides}</div>
      </div>
    );
  }

  // Clamp the index into range: Proclaim publishes status and presentation as
  // separate writes, so currentIndex can transiently point past the slides.
  const clampedIndex = Math.min(Math.max(currentIndex, 0), slides.length - 1);

  return <SlideText lines={slides[clampedIndex].split('\n')} />;
}

/**
 * Container component that reads from Yjs and passes data to pure component
 */
export function CurrentSlideViewerContainer() {
  const s = useStrings();
  const statusMap = useMap('proclaimStatus');
  const presentationsMap = useMap('proclaimPresentations');

  // Read current status and presentation data.
  const itemId = statusMap.get('itemId') as string | undefined;
  const presentation = itemId
    ? (presentationsMap.get(itemId) as { title: string; slides: string[] } | undefined)
    : undefined;

  // Without a current item or its presentation, we have nothing to show yet.
  if (!itemId || !presentation) {
    return (
      <div className="flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-gray-500 dark:text-gray-400">
          {s.waitingForProclaim}
          <div className="text-xs mt-2">{s.isProclaimRunning}</div>
        </div>
      </div>
    );
  }

  const slideIndex = (statusMap.get('slideIndex') as number) ?? 0;
  const title = presentation.title || s.untitledPresentation;
  const slides = (presentation.slides || []).filter(
    (slide): slide is string => typeof slide === 'string',
  );

  return <CurrentSlideViewer title={title} slides={slides} currentIndex={slideIndex} />;
}
