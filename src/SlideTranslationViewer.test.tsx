import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SlideTranslationViewer } from './SlideTranslationViewer';
import type { ResolvedSlideTranslation } from './slideTranslation';

function resolved(
  text: string,
  status: 'reviewed' | 'auto',
  displayLanguage: string,
  requestedLanguage: string,
): ResolvedSlideTranslation {
  return {
    entry: { text, status, provenance: status === 'reviewed' ? 'human' : 'llm' },
    displayLanguage,
    requestedLanguage,
    isFallbackLanguage: displayLanguage !== requestedLanguage,
  };
}

describe('SlideTranslationViewer', () => {
  it('shows a reviewed translation with no badges', () => {
    render(
      <SlideTranslationViewer
        slides={['Praise the Lord']}
        currentIndex={0}
        language="French"
        resolvedBySlide={[resolved('Louez le Seigneur', 'reviewed', 'French', 'French')]}
      />,
    );
    expect(screen.getByText('Louez le Seigneur')).toBeInTheDocument();
    expect(screen.queryByText('unreviewed')).not.toBeInTheDocument();
  });

  it('shows an unreviewed badge for an auto translation', () => {
    render(
      <SlideTranslationViewer
        slides={['Praise the Lord']}
        currentIndex={0}
        language="French"
        resolvedBySlide={[resolved('Louez (auto)', 'auto', 'French', 'French')]}
      />,
    );
    expect(screen.getByText('unreviewed')).toBeInTheDocument();
  });

  it('tags the display language when it falls back (reviewed French for a Creole viewer)', () => {
    render(
      <SlideTranslationViewer
        slides={['Praise the Lord']}
        currentIndex={0}
        language="Haitian Creole"
        resolvedBySlide={[resolved('Louez le Seigneur', 'reviewed', 'French', 'Haitian Creole')]}
      />,
    );
    expect(screen.getByText('French')).toBeInTheDocument();
    expect(screen.queryByText('unreviewed')).not.toBeInTheDocument();
  });

  it('shows a not-translated placeholder when the current slide has no resolution', () => {
    render(
      <SlideTranslationViewer
        slides={['Praise the Lord']}
        currentIndex={0}
        language="French"
        resolvedBySlide={[undefined]}
      />,
    );
    expect(screen.getByText('(not translated)')).toBeInTheDocument();
  });

  it('renders a placeholder when there are no slides', () => {
    render(
      <SlideTranslationViewer
        slides={[]}
        currentIndex={0}
        language="French"
        resolvedBySlide={[]}
      />,
    );
    expect(screen.getByText('No slides available')).toBeInTheDocument();
  });
});
