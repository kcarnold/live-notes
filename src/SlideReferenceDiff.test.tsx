import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SlideReferenceDiff } from './SlideReferenceDiff';
import { computeLookupDiffs } from './referenceLookupDiff';

/** Build real diffs through the util, so the component is tested against real `Change` parts. */
function diffsFor(canonical: string, agent: string) {
  return computeLookupDiffs([{ label: 'PSA 23', texts: { French: canonical } }], { French: [agent] }, [
    'French',
  ]);
}

describe('SlideReferenceDiff', () => {
  it('renders nothing when there are no qualifying diffs', () => {
    const { container } = render(<SlideReferenceDiff diffs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the reference label, language, and similarity', () => {
    render(
      <SlideReferenceDiff
        diffs={diffsFor(
          'Le Seigneur est mon berger, je ne manquerai de rien.',
          'Le Seigneur est mon pasteur, je ne manquerai de rien.',
        )}
      />,
    );
    expect(screen.getByText('PSA 23')).toBeInTheDocument();
    expect(screen.getByText('French')).toBeInTheDocument();
    expect(screen.getByText(/%$/)).toBeInTheDocument();
  });

  it('marks canonical-only wording as removed and the translation’s wording as added', () => {
    render(
      <SlideReferenceDiff
        diffs={diffsFor(
          'Le Seigneur est mon berger, je ne manquerai de rien.',
          'Le Seigneur est mon pasteur, je ne manquerai de rien.',
        )}
      />,
    );
    const removed = screen.getByText('berger', { exact: false, selector: 'span.line-through' });
    expect(removed).toBeInTheDocument();
    // Shared wording is rendered plainly, not as a change.
    expect(screen.getByText(/Seigneur/, { selector: 'span:not(.line-through)' })).toBeInTheDocument();
  });

  it('collapses and re-expands the panel', async () => {
    const user = userEvent.setup();
    render(<SlideReferenceDiff diffs={diffsFor('Le Seigneur est mon berger.', 'Le Seigneur est mon pasteur.')} />);

    const toggle = screen.getByRole('button', { name: /reference check/i });
    expect(screen.getByText('PSA 23')).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.queryByText('PSA 23')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(screen.getByText('PSA 23')).toBeInTheDocument();
  });
});
