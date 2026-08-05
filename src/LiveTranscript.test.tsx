// The transcript's rendering half: given segments carrying gap timings, does a long
// silence actually become a visible break in the right place? The measuring half
// (which gaps exist at all) is covered in live-audio/transcript-writer.test.ts, and
// the threshold itself in transcriptKeys.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { fontSizeAtom } from './configAtoms';
import { TRANSCRIPT_PAUSE_MS, type TranscriptSegment } from './transcriptKeys';

const segments = vi.hoisted(() => ({ current: [] as TranscriptSegment[] }));

// Stub the Yjs read so this stays a test of the component, not of the doc plumbing.
vi.mock('./useTranscriptSegments', () => ({
  useTranscriptSegments: () => segments.current,
}));

import { LiveTranscript } from './LiveTranscript';

/** A separator's accessible name is its aria-label: "Pause · 2m". */
const pauseLabels = () => screen.queryAllByRole('separator').map((el) => el.getAttribute('aria-label'));

beforeEach(() => {
  segments.current = [];
});

describe('LiveTranscript pause indicators', () => {
  it('shows no break when utterances follow each other closely', () => {
    segments.current = [
      { text: 'Let us pray.', startedAt: 1000 },
      { text: 'Amen.', startedAt: 4000, gapMs: 3000 },
    ];

    render(<LiveTranscript langCode="en" />);

    expect(screen.getByText('Amen.')).toBeTruthy();
    expect(pauseLabels()).toEqual([]);
  });

  it('breaks before an utterance that follows a long silence, and says how long', () => {
    segments.current = [
      { text: 'Let us pray.', startedAt: 1000 },
      { text: 'Please be seated.', startedAt: 121_000, gapMs: 120_000 },
    ];

    render(<LiveTranscript langCode="en" />);

    expect(pauseLabels()).toEqual(['Pause · 2m']);
  });

  it('breaks at the threshold but not just below it', () => {
    segments.current = [
      { text: 'One.', startedAt: 0 },
      { text: 'Two.', startedAt: 1, gapMs: TRANSCRIPT_PAUSE_MS - 1 },
      { text: 'Three.', startedAt: 2, gapMs: TRANSCRIPT_PAUSE_MS },
    ];

    render(<LiveTranscript langCode="en" />);

    // Only the third utterance gets a break; all three still render.
    expect(pauseLabels()).toHaveLength(1);
    expect(screen.getByText('Two.')).toBeTruthy();
    expect(screen.getByText('Three.')).toBeTruthy();
  });

  it('never breaks before the first utterance, which has no preceding silence', () => {
    segments.current = [{ text: 'Good morning.', startedAt: 1000 }];

    render(<LiveTranscript langCode="en" />);

    expect(pauseLabels()).toEqual([]);
  });

  it('renders a pre-segments transcript, which carries no timings at all', () => {
    segments.current = [{ text: 'The Lord is my shepherd.' }, { text: 'I shall not want.' }];

    render(<LiveTranscript langCode="en" />);

    expect(screen.getByText('I shall not want.')).toBeTruthy();
    expect(pauseLabels()).toEqual([]);
  });

  it('shows the waiting message when the transcript is empty', () => {
    render(<LiveTranscript langCode="en" />);

    expect(screen.getByText('Waiting for translated speech…')).toBeTruthy();
    expect(pauseLabels()).toEqual([]);
  });
});

// The transcript reads the same `fontSizeAtom` the translated/bilingual views do, so
// the −/+ controls in any pane's header resize it too.
describe('LiveTranscript font size', () => {
  const renderAtSize = (px: number) => {
    const store = createStore();
    store.set(fontSizeAtom, px);
    return render(
      <Provider store={store}>
        <LiveTranscript langCode="en" />
      </Provider>
    );
  };

  it('renders the text column at the shared reading size', () => {
    segments.current = [{ text: 'Good morning.' }];

    renderAtSize(28);

    const column = screen.getByText('Good morning.').parentElement;
    expect(column?.style.fontSize).toBe('28px');
  });

  it('follows the atom when the size changes', () => {
    segments.current = [{ text: 'Good morning.' }];

    const store = createStore();
    store.set(fontSizeAtom, 16);
    const { rerender } = render(
      <Provider store={store}>
        <LiveTranscript langCode="en" />
      </Provider>
    );
    expect(screen.getByText('Good morning.').parentElement?.style.fontSize).toBe('16px');

    store.set(fontSizeAtom, 30);
    rerender(
      <Provider store={store}>
        <LiveTranscript langCode="en" />
      </Provider>
    );
    expect(screen.getByText('Good morning.').parentElement?.style.fontSize).toBe('30px');
  });
});
