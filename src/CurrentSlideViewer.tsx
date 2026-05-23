import { useMap } from '@y-sweet/react';
import { useStrings } from './useLocale';

interface Slide {
  text: string;
  isActive: boolean;
}

interface CurrentSlideViewerProps {
  title: string;
  slides: string[];
  currentIndex: number;
  context?: number; // How many slides before/after to show (default: 0)
}

/**
 * Pure component that displays current slide with context (prev/next slides)
 */
export function CurrentSlideViewer({
  slides,
  currentIndex,
  context = 0
}: CurrentSlideViewerProps) {
  const s = useStrings();
  // Build array of slides to display with context
  const startIdx = Math.max(0, currentIndex - context);
  const endIdx = Math.min(slides.length - 1, currentIndex + context);

  const visibleSlides: Slide[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    visibleSlides.push({
      text: slides[i],
      isActive: i === currentIndex,
    });
  }

  if (slides.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50 dark:bg-gray-900">
        <div className="text-gray-500 dark:text-gray-400">{s.noSlides}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col bg-black dark:bg-gray-950 text-white overflow-hidden">
      {/* Slides with context */}
      <div className="flex-1 overflow-y-auto px-1 py-1 space-y-3">
        {visibleSlides.map((slide, idx) => (
          <div
            key={startIdx + idx}
            className={`transition-all duration-300 ${
              slide.isActive
                ? 'opacity-100 scale-100'
                : 'opacity-40 scale-95'
            }`}
          >
            <div
              className={`p-1`}
            >
              <div className="text-center space-y-2">
                {slide.text.split('\n').map((line, lineIdx) => (
                  <div
                    key={lineIdx}
                    className={`leading-normal ${
                      slide.isActive ? 'text-2xl' : 'text-xl font-light'
                    }`}
                  >
                    {line || '\u00A0'}
                  </div>
                ))}
              </div>
            </div>
            {!slide.isActive && (
              <div className="text-xs text-gray-500 dark:text-gray-600 mt-1 text-center">
                {startIdx + idx < currentIndex ? s.previous : s.next}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Container component that reads from Yjs and passes data to pure component
 */
export function CurrentSlideViewerContainer() {
  const s = useStrings();
  const statusMap = useMap('proclaimStatus');
  const serviceItemsMap = useMap('proclaimServiceItems');

  try {
    // Read current status
    const itemId = statusMap.get('itemId') as string | undefined;
    if (!itemId) {
      throw new Error('No itemId in statusMap');
    }
    const slideIndex = (statusMap.get('slideIndex') as number) ?? 0;

    // Read service item data
    const serviceItem = serviceItemsMap.get(itemId) as { title: string; slides: string[] } | undefined;
    if (!serviceItem) {
      throw new Error('Service item not found');
    }

    const title = serviceItem.title || s.untitledPresentation;
    const slidesArray = serviceItem.slides || [];
    const slides: string[] = [];

    if (slidesArray.length > 0) {
      for (let i = 0; i < slidesArray.length; i++) {
        const slide = slidesArray[i];
        if (typeof slide === 'string') {
          slides.push(slide);
        }
      }
    }

    return (
      <CurrentSlideViewer
        title={title}
        slides={slides}
        currentIndex={slideIndex}
        context={0}
      />
    );
  } catch {
      return (
        <div className="flex items-center justify-center bg-gray-50 dark:bg-gray-900">
          <div className="text-gray-500 dark:text-gray-400">
            {s.waitingForProclaim}
            <div className="text-xs mt-2">{s.isProclaimRunning}</div>
          </div>
        </div>
      );
  }
}
