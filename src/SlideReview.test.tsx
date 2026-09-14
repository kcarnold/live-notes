import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SlideReview } from './SlideReview';

const baseProps = {
  slides: ['Praise the Lord', 'Forever'],
  languages: ['French'] as const,
  notes: { French: [null, null] as (string | null)[] },
  editable: true,
  busy: false,
};

describe('SlideReview', () => {
  it('shows a placeholder when there are no slides', () => {
    render(
      <SlideReview
        {...baseProps}
        slides={[]}
        drafts={{ French: [] }}
        savedTexts={{ French: [] }}
        notes={{ French: [] }}
        onDraftChange={vi.fn()}
        onSaveCell={vi.fn()}
      />,
    );
    expect(screen.getByText(/Enter or load an item/i)).toBeInTheDocument();
  });

  it('renders source text and an editable cell per slide', () => {
    render(
      <SlideReview
        {...baseProps}
        drafts={{ French: ['Louez le Seigneur', ''] }}
        savedTexts={{ French: [null, null] }}
        onDraftChange={vi.fn()}
        onSaveCell={vi.fn()}
      />,
    );
    expect(screen.getByText('Praise the Lord')).toBeInTheDocument();
    expect(screen.getByLabelText('French slide 1')).toHaveValue('Louez le Seigneur');
  });

  it('calls onDraftChange when typing into a cell', () => {
    const onDraftChange = vi.fn();
    render(
      <SlideReview
        {...baseProps}
        drafts={{ French: ['', ''] }}
        savedTexts={{ French: [null, null] }}
        onDraftChange={onDraftChange}
        onSaveCell={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('French slide 1'), { target: { value: 'Bonjour' } });
    expect(onDraftChange).toHaveBeenCalledWith('French', 0, 'Bonjour');
  });

  it('enables Save only for unsaved non-empty drafts and reports the cell on click', () => {
    const onSaveCell = vi.fn();
    render(
      <SlideReview
        {...baseProps}
        drafts={{ French: ['Louez le Seigneur', ''] }}
        savedTexts={{ French: [null, null] }}
        onDraftChange={vi.fn()}
        onSaveCell={onSaveCell}
      />,
    );
    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    expect(saveButtons[0]).toBeEnabled();
    expect(saveButtons[1]).toBeDisabled(); // empty draft
    fireEvent.click(saveButtons[0]);
    expect(onSaveCell).toHaveBeenCalledWith('French', 0);
  });

  it('marks a cell saved and disables Save when the draft matches the saved text', () => {
    render(
      <SlideReview
        {...baseProps}
        drafts={{ French: ['Louez le Seigneur', ''] }}
        savedTexts={{ French: ['Louez le Seigneur', null] }}
        onDraftChange={vi.fn()}
        onSaveCell={vi.fn()}
      />,
    );
    expect(screen.getByText(/Saved/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Save' })[0]).toBeDisabled();
  });

  it('shows the translator note above the cell it belongs to, and marks the row', () => {
    render(
      <SlideReview
        {...baseProps}
        drafts={{ French: ['Louez le Seigneur', 'Toujours'] }}
        savedTexts={{ French: [null, null] }}
        notes={{ French: [null, 'Ambiguous: "forever" here could be liturgical.'] }}
        onDraftChange={vi.fn()}
        onSaveCell={vi.fn()}
      />,
    );
    expect(screen.getByText(/Ambiguous: "forever"/)).toBeInTheDocument();
    // Exactly one row is flagged — the one the note belongs to.
    expect(screen.getAllByLabelText('Translator notes')).toHaveLength(1);
  });

  it('disables editing when not editable', () => {
    render(
      <SlideReview
        {...baseProps}
        editable={false}
        drafts={{ French: ['Louez le Seigneur', ''] }}
        savedTexts={{ French: [null, null] }}
        onDraftChange={vi.fn()}
        onSaveCell={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('French slide 1')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
