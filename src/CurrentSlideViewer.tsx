import { useMap } from '@y-sweet/react';

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
  title,
  slides,
  currentIndex,
  context = 0
}: CurrentSlideViewerProps) {
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
      <div className="flex items-center justify-center h-full bg-gray-50">
        <div className="text-gray-500">No slides available</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-black text-white overflow-hidden">
      {/* Header with title and progress */}
      <div className="bg-gray-800 px-6 py-3 border-b border-gray-700 shrink-0">
        <div className="text-sm text-gray-400">
          Slide {currentIndex + 1} of {slides.length}
        </div>
        <div className="text-lg font-semibold">{title}</div>
      </div>

      {/* Slides with context */}
      <div className="flex-1 overflow-y-auto px-8 py-6 space-y-6">
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
              className={`rounded-lg p-6 ${
                slide.isActive
                  ? 'bg-gray-800 border-2 border-blue-500'
                  : 'bg-gray-900 border border-gray-700'
              }`}
            >
              <div className="text-center space-y-2">
                {slide.text.split('\n').map((line, lineIdx) => (
                  <div
                    key={lineIdx}
                    className={`leading-relaxed ${
                      slide.isActive ? 'text-3xl font-light' : 'text-xl font-light'
                    }`}
                  >
                    {line || '\u00A0'}
                  </div>
                ))}
              </div>
            </div>
            {!slide.isActive && (
              <div className="text-xs text-gray-500 mt-1 text-center">
                {startIdx + idx < currentIndex ? 'Previous' : 'Next'}
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
  const statusMap = useMap('proclaimStatus');
  const presentationsMap = useMap('proclaimPresentations');

  try {
    // Read current status
    const itemId = statusMap.get('itemId') as string | undefined;
    if (!itemId) {
      throw new Error('No itemId in statusMap');
    }
    const slideIndex = (statusMap.get('slideIndex') as number) ?? 0;

    // Read presentation data
    const presentation = presentationsMap.get(itemId) as { title: string; slides: string[] } | undefined;
    if (!presentation) {
      throw new Error('Presentation not found');
    }

    const title = presentation.title || 'Untitled Presentation';
    const slidesArray = presentation.slides || [];
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
        <div className="flex items-center justify-center h-full bg-gray-50">
          <div className="text-gray-500">
            Waiting for Proclaim data...
            <div className="text-xs mt-2">Is the Proclaim service running?</div>
          </div>
        </div>
      );
  }
}
