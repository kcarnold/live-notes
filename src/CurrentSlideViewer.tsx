import { useEffect, useState } from 'react';

interface ProclaimStatus {
  slideIndex: number;
  currentSlide: string;
  totalSlides: number;
  title: string;
}

interface ProclaimPresentation {
  itemId: string;
  title: string;
  slides: string[];
}

interface ProclaimState {
  presentation: ProclaimPresentation | null;
  status: ProclaimStatus | null;
  lastUpdate: number;
}

interface CurrentSlideViewerProps {
  docId: string;
}

/**
 * Component that displays the current slide from Proclaim
 *
 * Polls the Express server for the latest slide data
 */
export function CurrentSlideViewer({ docId }: CurrentSlideViewerProps) {
  const [state, setState] = useState<ProclaimState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const fetchState = async () => {
      try {
        const response = await fetch(`/api/proclaim/state/${docId}`);

        if (!response.ok) {
          if (response.status === 404) {
            setError('No Proclaim data available. Is the Proclaim service running?');
          } else {
            throw new Error(`HTTP ${response.status}`);
          }
          return;
        }

        const data = await response.json();
        if (mounted) {
          setState(data);
          setError(null);
          setIsLoading(false);
        }
      } catch (err) {
        console.error('Error fetching Proclaim state:', err);
        if (mounted) {
          setError('Failed to fetch Proclaim data');
        }
      }
    };

    // Initial fetch
    fetchState();

    // Poll every second
    const interval = setInterval(fetchState, 1000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [docId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50">
        <div className="text-gray-500">Loading Proclaim data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50">
        <div className="text-red-500">{error}</div>
      </div>
    );
  }

  if (!state || !state.status) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50">
        <div className="text-gray-500">No slide data available</div>
      </div>
    );
  }

  const { status } = state;

  return (
    <div className="flex flex-col h-full bg-black text-white">
      {/* Header with title and progress */}
      <div className="bg-gray-800 px-6 py-3 border-b border-gray-700">
        <div className="text-sm text-gray-400">
          Slide {status.slideIndex + 1} of {status.totalSlides}
        </div>
        <div className="text-lg font-semibold">{status.title}</div>
      </div>

      {/* Current slide content */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          {status.currentSlide.split('\n').map((line, index) => (
            <div key={index} className="text-4xl leading-relaxed font-light">
              {line || '\u00A0'} {/* Non-breaking space for empty lines */}
            </div>
          ))}
        </div>
      </div>

      {/* Footer with update timestamp */}
      <div className="bg-gray-800 px-6 py-2 border-t border-gray-700 text-xs text-gray-500">
        Last update: {new Date(state.lastUpdate).toLocaleTimeString()}
      </div>
    </div>
  );
}
