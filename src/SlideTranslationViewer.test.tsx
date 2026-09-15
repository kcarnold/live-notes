import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SlideTranslationViewer } from './SlideTranslationViewer';
import type { ResolvedSlideTranslation } from './slideTranslation';

function resolved(
  text: string,
  displayLanguage: string,
  requestedLanguage: string,
): ResolvedSlideTranslation {
  return {
    entry: { text, provenance: 'human' },
    displayLanguage,
    requestedLanguage,
    isFallbackLanguage: displayLanguage !== requestedLanguage,
  };
}

describe('SlideTranslationViewer', () => {
  it('shows a translation with no badges', () => {
    render(
      <SlideTranslationViewer
        slides={['Praise the Lord']}
        currentIndex={0}
        language="French"
        resolvedBySlide={[resolved('Louez le Seigneur', 'French', 'French')]}
      />,
    );
    expect(screen.getByText('Louez le Seigneur')).toBeInTheDocument();
    expect(screen.queryByText('French')).not.toBeInTheDocument();
  });

  it('tags the display language when it falls back (French for a Creole viewer)', () => {
    render(
      <SlideTranslationViewer
        slides={['Praise the Lord']}
        currentIndex={0}
        language="Haitian Creole"
        resolvedBySlide={[resolved('Louez le Seigneur', 'French', 'Haitian Creole')]}
      />,
    );
    expect(screen.getByText('French')).toBeInTheDocument();
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

  it('renders a blank slide blank, not as untranslated', () => {
    render(
      <SlideTranslationViewer
        slides={['Praise the Lord', '   ']}
        currentIndex={1}
        language="French"
        resolvedBySlide={[resolved('Louez le Seigneur', 'French', 'French'), undefined]}
      />,
    );
    expect(screen.queryByText('(not translated)')).not.toBeInTheDocument();
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
