import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TranslatedTextViewer from './TranslatedTextViewer';
import * as useTTSModule from './useTTS';
import type { UseTTSResult } from './useTTS';
import type { Block } from './blockTypes';
import { generateKeyBetween } from 'fractional-indexing';

// Mock the useTTS hook
vi.mock('./useTTS');

// Helper function to create test blocks with translations
function createTestBlocks(texts: string[], language: string = 'French'): Block[] {
  let prevPos: string | null = null;

  return texts.map((text, i) => {
    const pos = generateKeyBetween(prevPos, null);
    prevPos = pos;

    return {
      id: `block-${i}`,
      content: text,
      type: 'bullet' as const,
      level: 0,
      position: pos,
      translations: {
        [language]: text, // For tests, translated text = original text
      },
      translationSources: {
        [language]: text,
      },
    };
  });
}

describe('TranslatedTextViewer', () => {
  let mockTTS: UseTTSResult;

  beforeEach(() => {
    // Create a default mock TTS result
    mockTTS = {
      status: 'idle',
      currentText: null,
      speak: vi.fn(),
      cancel: vi.fn(),
    };

    vi.mocked(useTTSModule.useTTS).mockReturnValue(mockTTS);
  });

  describe('rendering', () => {
    it('should render all blocks', () => {
      const blocks = createTestBlocks(['Line 1', 'Line 2', 'Line 3']);

      render(<TranslatedTextViewer blocks={blocks} language="French" />);

      blocks.forEach((block) => {
        expect(screen.getByText(block.content)).toBeInTheDocument();
      });
    });

    it('should show auto-speak button for TTS-enabled languages', () => {
      const blocks = createTestBlocks(['Test']);

      render(<TranslatedTextViewer blocks={blocks} language="French" />);

      expect(screen.getByRole('button', { name: /auto text-to-speech/i })).toBeInTheDocument();
    });

    it('should not show auto-speak button for non-TTS languages', () => {
      const blocks = createTestBlocks(['Test'], 'German');

      render(<TranslatedTextViewer blocks={blocks} language="German" />);

      expect(screen.queryByRole('button', { name: /auto text-to-speech/i })).not.toBeInTheDocument();
    });

    it('should show error message when TTS errors', () => {
      mockTTS.status = 'error';
      mockTTS.errorMessage = 'Network error';
      const blocks = createTestBlocks(['Test']);

      render(<TranslatedTextViewer blocks={blocks} language="French" />);

      expect(screen.getByText(/Error: Network error/i)).toBeInTheDocument();
    });
  });

  describe('manual playback', () => {
    it('should speak block when clicked', async () => {
      const user = userEvent.setup();
      const blocks = createTestBlocks(['Line 1', 'Line 2', 'Line 3']);

      render(<TranslatedTextViewer blocks={blocks} language="French" />);

      await user.click(screen.getByText('Line 2'));

      expect(mockTTS.speak).toHaveBeenCalledWith('Line 2', 'French');
    });

    it('should cancel when clicking currently playing block', async () => {
      const user = userEvent.setup();
      mockTTS.currentText = 'Line 2';
      mockTTS.status = 'playing';

      const blocks = createTestBlocks(['Line 1', 'Line 2', 'Line 3']);

      render(<TranslatedTextViewer blocks={blocks} language="French" />);

      await user.click(screen.getByText('Line 2'));

      expect(mockTTS.cancel).toHaveBeenCalled();
    });

    it('should not speak when clicking block in non-TTS language', async () => {
      const user = userEvent.setup();
      const blocks = createTestBlocks(['Line 1', 'Line 2'], 'German');

      render(<TranslatedTextViewer blocks={blocks} language="German" />);

      await user.click(screen.getByText('Line 1'));

      expect(mockTTS.speak).not.toHaveBeenCalled();
    });
  });

  describe('auto-play mode', () => {
    it('should enable auto-play when button is clicked', async () => {
      const user = userEvent.setup();
      const blocks = createTestBlocks(['Line 1', 'Line 2', 'Line 3']);

      render(<TranslatedTextViewer blocks={blocks} language="French" />);

      const button = screen.getByRole('button', { name: /enable auto text-to-speech/i });
      await user.click(button);

      // Should start playing from the beginning (playhead is -1)
      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 1', 'French');
      });
    });

    it('should play next block when current block finishes', async () => {
      const user = userEvent.setup();
      const blocks = createTestBlocks(['Line 1', 'Line 2', 'Line 3']);

      // Mock the onFinished callback to simulate block completion
      let onFinishedCallback: ((text: string) => void) | undefined;
      vi.mocked(useTTSModule.useTTS).mockImplementation((options) => {
        onFinishedCallback = options?.onFinished;
        return mockTTS;
      });

      const { rerender } = render(<TranslatedTextViewer blocks={blocks} language="French" />);

      // Enable auto-play
      const button = screen.getByRole('button', { name: /enable auto text-to-speech/i });
      await user.click(button);

      // First block should start
      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 1', 'French');
      });

      // Simulate first block finishing
      mockTTS.status = 'idle';
      if (onFinishedCallback) {
        onFinishedCallback('Line 1');
      }

      // Rerender to trigger the effect
      rerender(<TranslatedTextViewer blocks={blocks} language="French" />);

      // Second block should start
      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 2', 'French');
      });
    });

    it('should not auto-play when disabled', () => {
      mockTTS.status = 'idle';
      const blocks = createTestBlocks(['Line 1', 'Line 2']);

      render(<TranslatedTextViewer blocks={blocks} language="French" />);

      // Should not speak automatically
      expect(mockTTS.speak).not.toHaveBeenCalled();
    });

    it('should not auto-play when TTS is busy', async () => {
      const user = userEvent.setup();
      mockTTS.status = 'playing';
      const blocks = createTestBlocks(['Line 1', 'Line 2']);

      render(<TranslatedTextViewer blocks={blocks} language="French" />);

      const button = screen.getByRole('button', { name: /enable auto text-to-speech/i });
      await user.click(button);

      // Should not start new playback while busy
      expect(mockTTS.speak).not.toHaveBeenCalled();
    });
  });

  describe('playhead behavior', () => {
    it('should advance playhead when block finishes', async () => {
      const user = userEvent.setup();
      const blocks = createTestBlocks(['Line 1', 'Line 2', 'Line 3']);

      let onFinishedCallback: ((text: string) => void) | undefined;
      vi.mocked(useTTSModule.useTTS).mockImplementation((options) => {
        onFinishedCallback = options?.onFinished;
        return mockTTS;
      });

      const { rerender } = render(
        <TranslatedTextViewer blocks={blocks} language="French" />
      );

      // Enable auto-play
      const button = screen.getByRole('button', { name: /enable auto text-to-speech/i });
      await user.click(button);

      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 1', 'French');
      });

      // Finish Line 1
      mockTTS.status = 'idle';
      if (onFinishedCallback) {
        onFinishedCallback('Line 1');
      }
      rerender(<TranslatedTextViewer blocks={blocks} language="French" />);

      // Line 1 should now have the playhead marker (green border)
      await waitFor(() => {
        const line1Element = screen.getByText('Line 1').parentElement;
        expect(line1Element?.className).toContain('border-green-500');
      });
    });

    it('should play from playhead + 1 when new blocks added', async () => {
      const user = userEvent.setup();
      let blocks = createTestBlocks(['Line 1', 'Line 2']);

      let onFinishedCallback: ((text: string) => void) | undefined;
      vi.mocked(useTTSModule.useTTS).mockImplementation((options) => {
        onFinishedCallback = options?.onFinished;
        return mockTTS;
      });

      const { rerender } = render(<TranslatedTextViewer blocks={blocks} language="French" />);

      // Enable auto-play
      const button = screen.getByRole('button', { name: /enable auto text-to-speech/i });
      await user.click(button);

      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 1', 'French');
      });

      // Finish Line 1
      mockTTS.status = 'idle';
      if (onFinishedCallback) {
        onFinishedCallback('Line 1');
      }
      rerender(<TranslatedTextViewer blocks={blocks} language="French" />);

      // Should play Line 2
      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 2', 'French');
      });

      // Add new blocks while Line 2 is playing
      blocks = createTestBlocks(['Line 1', 'Line 2', 'Line 3', 'Line 4']);
      mockTTS.status = 'playing';
      rerender(<TranslatedTextViewer blocks={blocks} language="French" />);

      // Finish Line 2
      mockTTS.status = 'idle';
      if (onFinishedCallback) {
        onFinishedCallback('Line 2');
      }
      rerender(<TranslatedTextViewer blocks={blocks} language="French" />);

      // Should play Line 3 (playhead was at 1, now at 2, so play index 3)
      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 3', 'French');
      });
    });
  });

  describe('toggle auto-speak during playback', () => {
    it('should stop auto-playing when toggled off', async () => {
      const user = userEvent.setup();
      const blocks = createTestBlocks(['Line 1', 'Line 2', 'Line 3']);

      let onFinishedCallback: ((text: string) => void) | undefined;
      vi.mocked(useTTSModule.useTTS).mockImplementation((options) => {
        onFinishedCallback = options?.onFinished;
        return mockTTS;
      });

      const { rerender } = render(<TranslatedTextViewer blocks={blocks} language="French" />);

      // Enable auto-play
      const button = screen.getByRole('button', { name: /enable auto text-to-speech/i });
      await user.click(button);

      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 1', 'French');
      });

      // Disable auto-play while Line 1 is playing
      mockTTS.status = 'playing';
      const disableButton = screen.getByRole('button', { name: /disable auto text-to-speech/i });
      await user.click(disableButton);

      // Finish Line 1
      mockTTS.status = 'idle';
      if (onFinishedCallback) {
        onFinishedCallback('Line 1');
      }
      rerender(<TranslatedTextViewer blocks={blocks} language="French" />);

      // Should NOT play Line 2 because auto-play is disabled
      expect(mockTTS.speak).toHaveBeenCalledTimes(1);
      expect(mockTTS.speak).not.toHaveBeenCalledWith('Line 2', 'French');
    });

    it('should resume auto-playing from playhead when toggled back on', async () => {
      const user = userEvent.setup();
      const blocks = createTestBlocks(['Line 1', 'Line 2', 'Line 3']);

      let onFinishedCallback: ((text: string) => void) | undefined;
      vi.mocked(useTTSModule.useTTS).mockImplementation((options) => {
        onFinishedCallback = options?.onFinished;
        return mockTTS;
      });

      const { rerender } = render(<TranslatedTextViewer blocks={blocks} language="French" />);

      // Enable auto-play
      let button = screen.getByRole('button', { name: /enable auto text-to-speech/i });
      await user.click(button);

      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 1', 'French');
      });

      // Finish Line 1
      mockTTS.status = 'idle';
      if (onFinishedCallback) {
        onFinishedCallback('Line 1');
      }
      rerender(<TranslatedTextViewer blocks={blocks} language="French" />);

      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 2', 'French');
      });

      // Disable auto-play
      button = screen.getByRole('button', { name: /disable auto text-to-speech/i });
      await user.click(button);

      // Finish Line 2 (playhead should be at index 1)
      mockTTS.status = 'idle';
      if (onFinishedCallback) {
        onFinishedCallback('Line 2');
      }
      rerender(<TranslatedTextViewer blocks={blocks} language="French" />);

      // Re-enable auto-play
      button = screen.getByRole('button', { name: /enable auto text-to-speech/i });
      await user.click(button);
      rerender(<TranslatedTextViewer blocks={blocks} language="French" />);

      // Should resume from playhead + 1 (Line 3)
      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 3', 'French');
      });
    });
  });
});
