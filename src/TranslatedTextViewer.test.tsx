import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TranslatedTextViewer from './TranslatedTextViewer';
import * as useTTSModule from './useTTS';
import type { UseTTSResult } from './useTTS';

// Mock the useTTS hook
vi.mock('./useTTS');

// Mock Remark to just render the text directly
vi.mock('react-remark', () => ({
  Remark: ({ children }: { children: string }) => <div>{children}</div>,
}));

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
    it('should render all lines', () => {
      const lines = ['Line 1', 'Line 2', 'Line 3'];

      render(<TranslatedTextViewer lines={lines} language="French" />);

      lines.forEach((line) => {
        expect(screen.getByText(line)).toBeInTheDocument();
      });
    });

    it('should show auto-speak button for TTS-enabled languages', () => {
      render(<TranslatedTextViewer lines={['Test']} language="French" />);

      expect(screen.getByRole('button', { name: /auto text-to-speech/i })).toBeInTheDocument();
    });

    it('should not show auto-speak button for non-TTS languages', () => {
      render(<TranslatedTextViewer lines={['Test']} language="German" />);

      expect(screen.queryByRole('button', { name: /auto text-to-speech/i })).not.toBeInTheDocument();
    });

    it('should show error message when TTS errors', () => {
      mockTTS.status = 'error';
      mockTTS.errorMessage = 'Network error';

      render(<TranslatedTextViewer lines={['Test']} language="French" />);

      expect(screen.getByText(/Error: Network error/i)).toBeInTheDocument();
    });
  });

  describe('manual playback', () => {
    it('should speak line when clicked', async () => {
      const user = userEvent.setup();
      const lines = ['Line 1', 'Line 2', 'Line 3'];

      render(<TranslatedTextViewer lines={lines} language="French" />);

      await user.click(screen.getByText('Line 2'));

      expect(mockTTS.speak).toHaveBeenCalledWith('Line 2', 'French');
    });

    it('should cancel when clicking currently playing line', async () => {
      const user = userEvent.setup();
      mockTTS.currentText = 'Line 2';
      mockTTS.status = 'playing';

      const lines = ['Line 1', 'Line 2', 'Line 3'];

      render(<TranslatedTextViewer lines={lines} language="French" />);

      await user.click(screen.getByText('Line 2'));

      expect(mockTTS.cancel).toHaveBeenCalled();
    });

    it('should not speak when clicking line in non-TTS language', async () => {
      const user = userEvent.setup();
      const lines = ['Line 1', 'Line 2'];

      render(<TranslatedTextViewer lines={lines} language="German" />);

      await user.click(screen.getByText('Line 1'));

      expect(mockTTS.speak).not.toHaveBeenCalled();
    });
  });

  describe('auto-play mode', () => {
    it('should enable auto-play when button is clicked', async () => {
      const user = userEvent.setup();
      const lines = ['Line 1', 'Line 2', 'Line 3'];

      render(<TranslatedTextViewer lines={lines} language="French" />);

      const button = screen.getByRole('button', { name: /enable auto text-to-speech/i });
      await user.click(button);

      // Should start playing from the beginning (playhead is -1)
      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 1', 'French');
      });
    });

    it('should play next line when current line finishes', async () => {
      const user = userEvent.setup();
      const lines = ['Line 1', 'Line 2', 'Line 3'];

      // Mock the onFinished callback to simulate line completion
      let onFinishedCallback: ((text: string) => void) | undefined;
      vi.mocked(useTTSModule.useTTS).mockImplementation((options) => {
        onFinishedCallback = options?.onFinished;
        return mockTTS;
      });

      const { rerender } = render(<TranslatedTextViewer lines={lines} language="French" />);

      // Enable auto-play
      const button = screen.getByRole('button', { name: /enable auto text-to-speech/i });
      await user.click(button);

      // First line should start
      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 1', 'French');
      });

      // Simulate first line finishing
      mockTTS.status = 'idle';
      if (onFinishedCallback) {
        onFinishedCallback('Line 1');
      }

      // Rerender to trigger the effect
      rerender(<TranslatedTextViewer lines={lines} language="French" />);

      // Second line should start
      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 2', 'French');
      });
    });

    it('should not auto-play when disabled', () => {
      mockTTS.status = 'idle';
      const lines = ['Line 1', 'Line 2'];

      render(<TranslatedTextViewer lines={lines} language="French" />);

      // Should not speak automatically
      expect(mockTTS.speak).not.toHaveBeenCalled();
    });

    it('should not auto-play when TTS is busy', async () => {
      const user = userEvent.setup();
      mockTTS.status = 'playing';
      const lines = ['Line 1', 'Line 2'];

      render(<TranslatedTextViewer lines={lines} language="French" />);

      const button = screen.getByRole('button', { name: /enable auto text-to-speech/i });
      await user.click(button);

      // Should not start new playback while busy
      expect(mockTTS.speak).not.toHaveBeenCalled();
    });
  });

  describe('playhead behavior', () => {
    it('should advance playhead when line finishes', async () => {
      const user = userEvent.setup();
      const lines = ['Line 1', 'Line 2', 'Line 3'];

      let onFinishedCallback: ((text: string) => void) | undefined;
      vi.mocked(useTTSModule.useTTS).mockImplementation((options) => {
        onFinishedCallback = options?.onFinished;
        return mockTTS;
      });

      const { rerender } = render(
        <TranslatedTextViewer lines={lines} language="French" />
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
      rerender(<TranslatedTextViewer lines={lines} language="French" />);

      // Line 1 should now have the playhead marker (green border)
      await waitFor(() => {
        const line1Element = screen.getByText('Line 1').parentElement;
        expect(line1Element?.className).toContain('border-green-500');
      });
    });

    it('should play from playhead + 1 when new lines added', async () => {
      const user = userEvent.setup();
      let lines = ['Line 1', 'Line 2'];

      let onFinishedCallback: ((text: string) => void) | undefined;
      vi.mocked(useTTSModule.useTTS).mockImplementation((options) => {
        onFinishedCallback = options?.onFinished;
        return mockTTS;
      });

      const { rerender } = render(<TranslatedTextViewer lines={lines} language="French" />);

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
      rerender(<TranslatedTextViewer lines={lines} language="French" />);

      // Should play Line 2
      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 2', 'French');
      });

      // Add new lines while Line 2 is playing
      lines = ['Line 1', 'Line 2', 'Line 3', 'Line 4'];
      mockTTS.status = 'playing';
      rerender(<TranslatedTextViewer lines={lines} language="French" />);

      // Finish Line 2
      mockTTS.status = 'idle';
      if (onFinishedCallback) {
        onFinishedCallback('Line 2');
      }
      rerender(<TranslatedTextViewer lines={lines} language="French" />);

      // Should play Line 3 (playhead was at 1, now at 2, so play index 3)
      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 3', 'French');
      });
    });
  });

  describe('toggle auto-speak during playback', () => {
    it('should stop auto-playing when toggled off', async () => {
      const user = userEvent.setup();
      const lines = ['Line 1', 'Line 2', 'Line 3'];

      let onFinishedCallback: ((text: string) => void) | undefined;
      vi.mocked(useTTSModule.useTTS).mockImplementation((options) => {
        onFinishedCallback = options?.onFinished;
        return mockTTS;
      });

      const { rerender } = render(<TranslatedTextViewer lines={lines} language="French" />);

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
      rerender(<TranslatedTextViewer lines={lines} language="French" />);

      // Should NOT play Line 2 because auto-play is disabled
      expect(mockTTS.speak).toHaveBeenCalledTimes(1);
      expect(mockTTS.speak).not.toHaveBeenCalledWith('Line 2', 'French');
    });

    it('should resume auto-playing from playhead when toggled back on', async () => {
      const user = userEvent.setup();
      const lines = ['Line 1', 'Line 2', 'Line 3'];

      let onFinishedCallback: ((text: string) => void) | undefined;
      vi.mocked(useTTSModule.useTTS).mockImplementation((options) => {
        onFinishedCallback = options?.onFinished;
        return mockTTS;
      });

      const { rerender } = render(<TranslatedTextViewer lines={lines} language="French" />);

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
      rerender(<TranslatedTextViewer lines={lines} language="French" />);

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
      rerender(<TranslatedTextViewer lines={lines} language="French" />);

      // Re-enable auto-play
      button = screen.getByRole('button', { name: /enable auto text-to-speech/i });
      await user.click(button);
      rerender(<TranslatedTextViewer lines={lines} language="French" />);

      // Should resume from playhead + 1 (Line 3)
      await waitFor(() => {
        expect(mockTTS.speak).toHaveBeenCalledWith('Line 3', 'French');
      });
    });
  });
});
