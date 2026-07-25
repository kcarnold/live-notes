import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CurrentSlideViewer, CurrentSlideViewerContainer } from './CurrentSlideViewer';

// ── Container Yjs seam ──────────────────────────────────────────────────────
// The container reads two Y.Maps via @y-sweet/react's useMap. A plain JS Map is
// get-compatible with the code under test, so we back each hook with one we
// control per test.
const maps = new Map<string, Map<string, unknown>>();
vi.mock('@y-sweet/react', () => ({
  useMap: (name: string) => {
    let m = maps.get(name);
    if (!m) {
      m = new Map<string, unknown>();
      maps.set(name, m);
    }
    return m;
  },
}));

function setStatus(fields: Record<string, unknown>) {
  const m = new Map<string, unknown>(Object.entries(fields));
  maps.set('proclaimStatus', m);
}

function setPresentation(itemId: string, presentation: unknown) {
  let m = maps.get('proclaimPresentations');
  if (!m) {
    m = new Map<string, unknown>();
    maps.set('proclaimPresentations', m);
  }
  m.set(itemId, presentation);
}

// ── Pure component ──────────────────────────────────────────────────────────

describe('CurrentSlideViewer (pure)', () => {
  it('renders the empty state when there are no slides', () => {
    render(<CurrentSlideViewer title="T" slides={[]} currentIndex={0} />);
    expect(screen.getByText('No slides available')).toBeInTheDocument();
  });

  it('shows only the current slide', () => {
    render(<CurrentSlideViewer title="T" slides={['a', 'b', 'c']} currentIndex={1} />);
    expect(screen.getByText('b')).toBeInTheDocument();
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.queryByText('c')).not.toBeInTheDocument();
  });

  it('splits multi-line slide text and renders blank lines as a non-breaking space', () => {
    render(<CurrentSlideViewer title="T" slides={['line1\n\nline3']} currentIndex={0} />);
    expect(screen.getByText('line1')).toBeInTheDocument();
    expect(screen.getByText('line3')).toBeInTheDocument();
    // The blank middle line renders as a non-breaking space (identity normalizer
    // so testing-library doesn't collapse it away).
    expect(screen.getByText('\u00A0', { normalizer: (s) => s })).toBeInTheDocument();
  });

  // Regression: Proclaim publishes status and presentation as two separate writes,
  // so currentIndex can transiently point past the known slides. The viewer must
  // show a real slide, not a blank container.
  it('clamps an out-of-range currentIndex to the last slide', () => {
    render(<CurrentSlideViewer title="T" slides={['a', 'b', 'c']} currentIndex={5} />);
    expect(screen.getByText('c')).toBeInTheDocument();
    expect(screen.queryByText('a')).not.toBeInTheDocument();
    expect(screen.queryByText('b')).not.toBeInTheDocument();
  });

  it('clamps a negative currentIndex to the first slide', () => {
    render(<CurrentSlideViewer title="T" slides={['a', 'b', 'c']} currentIndex={-1} />);
    expect(screen.getByText('a')).toBeInTheDocument();
    expect(screen.queryByText('c')).not.toBeInTheDocument();
  });
});

// ── Container ───────────────────────────────────────────────────────────────

describe('CurrentSlideViewerContainer', () => {
  beforeEach(() => {
    maps.clear();
  });

  it('renders the waiting state when there is no itemId', () => {
    setStatus({});
    render(<CurrentSlideViewerContainer />);
    expect(screen.getByText('Waiting for Proclaim data...')).toBeInTheDocument();
  });

  it('renders the waiting state when the presentation is missing', () => {
    setStatus({ itemId: 'item-1', slideIndex: 0 });
    // no presentation registered for item-1
    render(<CurrentSlideViewerContainer />);
    expect(screen.getByText('Waiting for Proclaim data...')).toBeInTheDocument();
  });

  it('renders the current slide on the happy path', () => {
    setStatus({ itemId: 'item-1', slideIndex: 1 });
    setPresentation('item-1', { title: 'Sermon', slides: ['first', 'second', 'third'] });
    render(<CurrentSlideViewerContainer />);
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('defaults slideIndex to 0 when absent', () => {
    setStatus({ itemId: 'item-1' });
    setPresentation('item-1', { title: 'Sermon', slides: ['first', 'second'] });
    render(<CurrentSlideViewerContainer />);
    expect(screen.getByText('first')).toBeInTheDocument();
  });

  it('filters out non-string slide entries', () => {
    setStatus({ itemId: 'item-1', slideIndex: 0 });
    setPresentation('item-1', { title: 'Sermon', slides: ['ok', null, 42, 'also-ok'] });
    render(<CurrentSlideViewerContainer />);
    // With the bad entries dropped, index 0 is 'ok' and there is no throw/blank.
    expect(screen.getByText('ok')).toBeInTheDocument();
  });
});
