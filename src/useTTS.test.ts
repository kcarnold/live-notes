import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useTTS } from './useTTS';

// Store callbacks and mock Howl instance at module level
let howlCallbacks: {
  onend?: () => void;
  onloaderror?: (id: number, error: unknown) => void;
  onplayerror?: (id: number, error: unknown) => void;
};

// Factory to create a new mock Howl instance
const createMockHowl = () => ({
  play: vi.fn(),
  stop: vi.fn(),
  unload: vi.fn(),
});

let mockHowlInstance: ReturnType<typeof createMockHowl>;

// Mock Howler at module level
vi.mock('howler', () => {
  // Create a mock class that can be used with 'new'
  class MockHowl {
    constructor(config: {
      src: string[];
      html5?: boolean;
      onend?: () => void;
      onloaderror?: (id: number, error: unknown) => void;
      onplayerror?: (id: number, error: unknown) => void;
    }) {
      // Store callbacks globally
      howlCallbacks = {
        onend: config.onend,
        onloaderror: config.onloaderror,
        onplayerror: config.onplayerror,
      };

      // Copy methods from the mock instance
      Object.assign(this, mockHowlInstance);
    }
  }

  return {
    Howl: MockHowl,
  };
});

describe('useTTS', () => {
  beforeEach(() => {
    // Reset callbacks for each test
    howlCallbacks = {};

    // Create fresh mock Howl instance
    mockHowlInstance = createMockHowl();

    // Mock fetch for TTS API
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ audioUrl: 'http://example.com/audio.mp3' }),
    } as unknown as Response);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('basic functionality', () => {
    it('should start in idle state', () => {
      const { result } = renderHook(() => useTTS());

      expect(result.current.status).toBe('idle');
      expect(result.current.currentText).toBeNull();
      expect(result.current.errorMessage).toBeUndefined();
    });

    it('should transition to loading when speak is called', () => {
      const { result } = renderHook(() => useTTS());

      act(() => {
        result.current.speak('Hello world', 'French');
      });

      expect(result.current.status).toBe('loading');
      expect(result.current.currentText).toBe('Hello world');
    });

    it('should transition to playing when audio is ready', async () => {
      const { result } = renderHook(() => useTTS());

      act(() => {
        result.current.speak('Hello world', 'French');
      });

      await waitFor(() => {
        expect(result.current.status).toBe('playing');
      });

      expect(result.current.currentText).toBe('Hello world');
      expect(mockHowlInstance.play).toHaveBeenCalled();
    });

    it('should call onFinished when audio ends', async () => {
      const onFinished = vi.fn();
      const { result } = renderHook(() => useTTS({ onFinished }));

      act(() => {
        result.current.speak('Hello world', 'French');
      });

      await waitFor(() => {
        expect(result.current.status).toBe('playing');
      });

      // Simulate audio ending
      act(() => {
        if (howlCallbacks.onend) howlCallbacks.onend();
      });

      await waitFor(() => {
        expect(result.current.status).toBe('idle');
      });

      expect(onFinished).toHaveBeenCalledWith('Hello world');
      expect(result.current.currentText).toBeNull();
    });
  });

  describe('race conditions', () => {
    it('should cancel previous request when speak is called twice', async () => {
      const onFinished = vi.fn();
      const { result } = renderHook(() => useTTS({ onFinished }));

      // Start first request
      act(() => {
        result.current.speak('First text', 'French');
      });

      await waitFor(() => {
        expect(result.current.status).toBe('playing');
      });

      // Start second request before first finishes
      act(() => {
        result.current.speak('Second text', 'French');
      });

      await waitFor(() => {
        expect(result.current.currentText).toBe('Second text');
      });

      // First audio ending should not trigger onFinished
      act(() => {
        if (howlCallbacks.onend) howlCallbacks.onend();
      });

      // onFinished should not be called for cancelled request
      expect(onFinished).not.toHaveBeenCalledWith('First text');
    });

    it('should ignore fetch completion if request was superseded', async () => {
      const onFinished = vi.fn();

      // Make fetch slow
      let resolveFetch: (value: Response) => void;
      global.fetch = vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      );

      const { result } = renderHook(() => useTTS({ onFinished }));

      // Start first request
      act(() => {
        result.current.speak('First text', 'French');
      });

      expect(result.current.status).toBe('loading');

      // Start second request while first is still loading
      act(() => {
        result.current.speak('Second text', 'French');
      });

      // Resolve first fetch (should be ignored)
      act(() => {
        resolveFetch({
          ok: true,
          json: vi.fn().mockResolvedValue({ audioUrl: 'http://example.com/first.mp3' }),
        } as unknown as Response);
      });

      // Second request should still be loading
      expect(result.current.currentText).toBe('Second text');
    });

    it('should handle cancel during loading', async () => {
      const onFinished = vi.fn();

      // Make fetch slow
      global.fetch = vi.fn().mockImplementation(
        () => new Promise<Response>(() => {}) // Never resolves
      );

      const { result } = renderHook(() => useTTS({ onFinished }));

      act(() => {
        result.current.speak('Hello world', 'French');
      });

      expect(result.current.status).toBe('loading');

      act(() => {
        result.current.cancel();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.currentText).toBeNull();
    });

    it('should handle cancel during playback', async () => {
      const onFinished = vi.fn();
      const { result } = renderHook(() => useTTS({ onFinished }));

      act(() => {
        result.current.speak('Hello world', 'French');
      });

      await waitFor(() => {
        expect(result.current.status).toBe('playing');
      });

      act(() => {
        result.current.cancel();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.currentText).toBeNull();
      expect(mockHowlInstance.stop).toHaveBeenCalled();

      // Ending audio after cancel should not trigger onFinished
      act(() => {
        if (howlCallbacks.onend) howlCallbacks.onend();
      });

      expect(onFinished).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle fetch errors gracefully', async () => {
      const onError = vi.fn();
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useTTS({ onError }));

      act(() => {
        result.current.speak('Hello world', 'French');
      });

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });

      expect(result.current.errorMessage).toBe('Network error');
      expect(onError).toHaveBeenCalledWith('Network error', 'Hello world');
      expect(result.current.currentText).toBeNull();
    });

    it('should handle audio playback errors', async () => {
      const onError = vi.fn();
      const { result } = renderHook(() => useTTS({ onError }));

      act(() => {
        result.current.speak('Hello world', 'French');
      });

      await waitFor(() => {
        expect(result.current.status).toBe('playing');
      });

      // Simulate audio error
      act(() => {
        if (howlCallbacks.onplayerror) howlCallbacks.onplayerror(0, 'Audio playback error');
      });

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });

      expect(onError).toHaveBeenCalledWith('Audio playback error', 'Hello world');
    });

    it('should allow speaking again after error', async () => {
      const onError = vi.fn();
      global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useTTS({ onError }));

      // First attempt fails
      act(() => {
        result.current.speak('Hello world', 'French');
      });

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });

      // Mock successful fetch for second attempt
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ audioUrl: 'http://example.com/audio.mp3' }),
      } as unknown as Response);

      // Second attempt should work
      act(() => {
        result.current.speak('Hello again', 'French');
      });

      await waitFor(() => {
        expect(result.current.status).toBe('playing');
      });

      expect(result.current.currentText).toBe('Hello again');
    });
  });

  describe('callback updates', () => {
    it('should use latest onFinished callback', async () => {
      const onFinished1 = vi.fn();
      const onFinished2 = vi.fn();

      const { result, rerender } = renderHook(
        ({ onFinished }) => useTTS({ onFinished }),
        { initialProps: { onFinished: onFinished1 } }
      );

      act(() => {
        result.current.speak('Hello world', 'French');
      });

      await waitFor(() => {
        expect(result.current.status).toBe('playing');
      });

      // Update callback before audio ends
      rerender({ onFinished: onFinished2 });

      // Simulate audio ending
      act(() => {
        if (howlCallbacks.onend) howlCallbacks.onend();
      });

      await waitFor(() => {
        expect(result.current.status).toBe('idle');
      });

      // Should call the new callback
      expect(onFinished2).toHaveBeenCalledWith('Hello world');
      expect(onFinished1).not.toHaveBeenCalled();
    });
  });
});
