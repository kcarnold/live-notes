import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { BlockEditor } from './BlockEditor';
import { createBlock, getPosition, addBlockToYArray, createSequentialPositions, type BlockYMap } from './blockTypes';

const positions = createSequentialPositions(10);

describe('BlockEditor', () => {
  let ydoc: Y.Doc;
  let yArray: Y.Array<BlockYMap>;

  beforeEach(() => {
    ydoc = new Y.Doc();
    yArray = ydoc.getArray('blocks');
  });

  describe('Basic Rendering', () => {
    it('renders existing blocks from Yjs array', () => {
      const block1 = createBlock('First block', 'bullet', 0, positions[0]);
      const block2 = createBlock('Second block', 'heading', 0, positions[1]);

      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      render(<BlockEditor yArray={yArray} />);

      expect(screen.getByText('First block')).toBeInTheDocument();
      expect(screen.getByText('Second block')).toBeInTheDocument();
    });

    it('renders blocks with correct prefixes', () => {
      const positions = createSequentialPositions(2);
      const bullet = createBlock('Bullet item', 'bullet', 0, positions[0]);
      const heading = createBlock('Heading', 'heading', 0, positions[1]);

      addBlockToYArray(yArray, bullet);
      addBlockToYArray(yArray, heading);

      const { container } = render(<BlockEditor yArray={yArray} />);

      // Check for bullet prefix
      expect(container.textContent).toContain('- ');
      // Check for heading prefix
      expect(container.textContent).toContain('## ');
    });

    it('renders blocks with correct indentation', () => {
      const block1 = createBlock('Level 0', 'bullet', 0, getPosition(null, null));
      const block2 = createBlock('Level 1', 'bullet', 1, getPosition(block1, null));
      const block3 = createBlock('Level 2', 'bullet', 2, getPosition(block2, null));

      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);
      addBlockToYArray(yArray, block3);

      const { container } = render(<BlockEditor yArray={yArray} />);

      const blockDivs = container.querySelectorAll('.flex.items-start');
      expect(blockDivs[0]).toHaveStyle({ paddingLeft: '0px' });
      expect(blockDivs[1]).toHaveStyle({ paddingLeft: '12px' });
      expect(blockDivs[2]).toHaveStyle({ paddingLeft: '24px' });
    });

    it('does not render operation buttons when editable is false', () => {
      const positions = createSequentialPositions(1);
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} editable={false} />);

      expect(screen.queryByTitle(/Move up/i)).not.toBeInTheDocument();
      expect(screen.queryByTitle(/Move down/i)).not.toBeInTheDocument();
      expect(screen.queryByTitle(/Indent/i)).not.toBeInTheDocument();
    });
  });

  describe('Text Editing', () => {
    it('allows clicking a block to focus and edit it', async () => {
      const user = userEvent.setup();
      const positions = createSequentialPositions(1);
      const block = createBlock('Click me', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      const blockText = screen.getByText('Click me');
      await user.click(blockText);

      // Should now show a textarea
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveFocus();
    });

    it('syncs typed text to Yjs Y.Text', async () => {
      const user = userEvent.setup();
      const positions = createSequentialPositions(1);
      const block = createBlock('Initial', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Initial'));
      const textarea = screen.getByRole('textbox');

      // Clear and type new text
      await user.clear(textarea);
      await user.type(textarea, 'Updated text');

      // Check Yjs was updated
      await waitFor(() => {
        const yMap = yArray.get(0);
        const yText = yMap.get('content') as Y.Text;
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        expect(yText.toString()).toBe('Updated text');
      });
    });

    it('calls onTextChanged callback when content changes', async () => {
      const user = userEvent.setup();
      const onTextChanged = vi.fn<(markdown: string) => void>();
      const positions = createSequentialPositions(1);
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} onTextChanged={onTextChanged} />);

      await user.click(screen.getByText('Test'));
      const textarea = screen.getByRole('textbox');
      await user.type(textarea, ' more');

      await waitFor(() => {
        expect(onTextChanged).toHaveBeenCalled();
        const markdown = onTextChanged.mock.calls[onTextChanged.mock.calls.length - 1][0];
        expect(markdown).toContain('Test more');
      });
    });

    it('updates display when Yjs is modified externally', async () => {
      const block = createBlock('Original', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      expect(screen.getByText('Original')).toBeInTheDocument();

      // Modify Yjs externally
      act(() => {
        const yMap = yArray.get(0);
        const yText = yMap.get('content') as Y.Text;
        yText.delete(0, yText.length);
        yText.insert(0, 'Updated externally');
      });

      // Should update the display
      await waitFor(() => {
        expect(screen.getByText('Updated externally')).toBeInTheDocument();
      });
    });
  });

  describe('Keyboard Shortcuts - Enter Key', () => {
    it('splits block on Enter key', async () => {
      const user = userEvent.setup();
      const block = createBlock('Hello World', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Hello World'));
      const textarea: HTMLTextAreaElement = screen.getByRole('textbox');

      // Position cursor after "Hello "
      textarea.setSelectionRange(6, 6);
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(yArray.length).toBe(2);
        const block1 = yArray.get(0);
        const block2 = yArray.get(1);
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        expect((block1.get('content') as Y.Text).toString()).toBe('Hello ');
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        expect((block2.get('content') as Y.Text).toString()).toBe('World');
      });
    });

    it('creates new block with bullet at level 0 after a heading', async () => {
      const user = userEvent.setup();
      const positions = createSequentialPositions(1);
      const block = createBlock('Test', 'heading', 2, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(yArray.length).toBe(2);
        const newBlock = yArray.get(1);
        expect(newBlock.get('type')).toBe('bullet');
        expect(newBlock.get('level')).toBe(0);
      });
    });

    it('creates new block with same type and level after a bullet', async () => {
      const user = userEvent.setup();
      const positions = createSequentialPositions(1);
      const block = createBlock('Test', 'bullet', 2, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(yArray.length).toBe(2);
        const newBlock = yArray.get(1);
        expect(newBlock.get('type')).toBe('bullet');
        expect(newBlock.get('level')).toBe(2);
      });
    });

    it('triggers translation on Cmd+Enter', async () => {
      const user = userEvent.setup();
      const onTranslationTrigger = vi.fn();
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} onTranslationTrigger={onTranslationTrigger} />);

      await user.click(screen.getByText('Test'));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      await user.keyboard('{Meta>}{Enter}{/Meta}');

      expect(onTranslationTrigger).toHaveBeenCalled();
    });
  });

  describe('Keyboard Shortcuts - Backspace', () => {
    it('deletes empty block on Backspace at start', async () => {
      const user = userEvent.setup();
      const block1 = createBlock('First', 'bullet', 0, positions[0]);
      const block2 = createBlock('', 'bullet', 0, positions[1]);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText(/Click to edit/i));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      await user.keyboard('{Backspace}');

      await waitFor(() => {
        expect(yArray.length).toBe(1);
      });
    });

    it('does not delete last remaining block', async () => {
      const user = userEvent.setup();
      const block = createBlock('', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText(/Click to edit/i));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      await user.keyboard('{Backspace}');

      // Should still have 1 block
      await waitFor(() => {
        expect(yArray.length).toBe(1);
      });
    });

    it('dedents indented block on Backspace at start', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 2, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea: HTMLTextAreaElement = screen.getByRole('textbox');
      textarea.setSelectionRange(0, 0);
      await user.keyboard('{Backspace}');

      await waitFor(() => {
        const yMap = yArray.get(0);
        expect(yMap.get('level')).toBe(1);
      });
    });

    it('converts heading to bullet on Backspace at level 0', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'heading', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea: HTMLTextAreaElement = screen.getByRole('textbox');
      textarea.setSelectionRange(0, 0);
      await user.keyboard('{Backspace}');

      await waitFor(() => {
        const yMap = yArray.get(0);
        expect(yMap.get('type')).toBe('bullet');
      });
    });

    it('dedents heading before converting to bullet', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'heading', 2, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea: HTMLTextAreaElement = screen.getByRole('textbox');
      textarea.setSelectionRange(0, 0);
      await user.keyboard('{Backspace}');

      await waitFor(() => {
        const yMap = yArray.get(0);
        expect(yMap.get('type')).toBe('heading');
        expect(yMap.get('level')).toBe(1);
      });
    });
  });

  describe('Keyboard Shortcuts - Hashtag Promotion', () => {
    it('promotes bullet to heading on # at start', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea: HTMLTextAreaElement = screen.getByRole('textbox');
      textarea.setSelectionRange(0, 0);
      await user.keyboard('#');

      await waitFor(() => {
        const yMap = yArray.get(0);
        expect(yMap.get('type')).toBe('heading');
        expect(yMap.get('level')).toBe(0);
        // Content should not include the #
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        expect((yMap.get('content') as Y.Text).toString()).toBe('Test');
      });
    });

    it('increments heading level on # at start', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'heading', 1, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea: HTMLTextAreaElement = screen.getByRole('textbox');
      textarea.setSelectionRange(0, 0);
      await user.keyboard('#');

      await waitFor(() => {
        const yMap = yArray.get(0);
        expect(yMap.get('type')).toBe('heading');
        expect(yMap.get('level')).toBe(2);
      });
    });

    it('does not increment heading level beyond max', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'heading', 5, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea: HTMLTextAreaElement = screen.getByRole('textbox');
      textarea.setSelectionRange(0, 0);
      await user.keyboard('#');

      await waitFor(() => {
        const yMap = yArray.get(0);
        expect(yMap.get('level')).toBe(5);
        // Content should not include the #
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        expect((yMap.get('content') as Y.Text).toString()).toBe('Test');
      });
    });

    it('does not promote on # in middle of text', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea: HTMLTextAreaElement = screen.getByRole('textbox');
      // Position cursor at end
      textarea.setSelectionRange(4, 4);
      await user.keyboard('#');

      await waitFor(() => {
        const yMap = yArray.get(0);
        expect(yMap.get('type')).toBe('bullet');
        // Content should include the #
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        expect((yMap.get('content') as Y.Text).toString()).toBe('Test#');
      });
    });
  });

  describe('Keyboard Shortcuts - Indentation', () => {
    it('indents block on Tab', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      await user.keyboard('{Tab}');

      await waitFor(() => {
        const yMap = yArray.get(0);
        expect(yMap.get('level')).toBe(1);
      });
    });

    it('dedents block on Shift+Tab', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 2, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      await user.keyboard('{Shift>}{Tab}{/Shift}');

      await waitFor(() => {
        const yMap = yArray.get(0);
        expect(yMap.get('level')).toBe(1);
      });
    });

    it('does not indent beyond max level', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 5, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      await user.keyboard('{Tab}');

      await waitFor(() => {
        const yMap = yArray.get(0);
        expect(yMap.get('level')).toBe(5);
      });
    });

    it('does not dedent below level 0', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      await user.keyboard('{Shift>}{Tab}{/Shift}');

      await waitFor(() => {
        const yMap = yArray.get(0);
        expect(yMap.get('level')).toBe(0);
      });
    });
  });

  describe('Keyboard Shortcuts - Toggle Heading', () => {
    it('toggles bullet to heading on Cmd+H', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      await user.keyboard('{Meta>}h{/Meta}');

      await waitFor(() => {
        const yMap = yArray.get(0);
        expect(yMap.get('type')).toBe('heading');
      });
    });

    it('toggles heading to bullet on Cmd+H', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'heading', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      await user.keyboard('{Meta>}h{/Meta}');

      await waitFor(() => {
        const yMap = yArray.get(0);
        expect(yMap.get('type')).toBe('bullet');
      });
    });
  });

  describe('Keyboard Shortcuts - Move Blocks', () => {
    it('moves block up on Cmd+ArrowUp', async () => {
      const user = userEvent.setup();
      const block1 = createBlock('First', 'bullet', 0, positions[0]);
      const block2 = createBlock('Second', 'bullet', 0, positions[1]);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Second'));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      await user.keyboard('{Meta>}{ArrowUp}{/Meta}');

      await waitFor(() => {
        // Check that second block now has a position before first
        const blocks = yArray.toArray().map(yMap => ({
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          content: (yMap.get('content') as Y.Text).toString(),
          position: yMap.get('position') as string
        }));
        blocks.sort((a, b) => a.position < b.position ? -1 : 1);
        expect(blocks[0].content).toBe('Second');
        expect(blocks[1].content).toBe('First');
      });
    });

    it('moves block down on Cmd+ArrowDown', async () => {
      const user = userEvent.setup();
      const positions = createSequentialPositions(2);
      const block1 = createBlock('First', 'bullet', 0, positions[0]);
      const block2 = createBlock('Second', 'bullet', 0, positions[1]);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('First'));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      await user.keyboard('{Meta>}{ArrowDown}{/Meta}');

      await waitFor(() => {
        const blocks = yArray.toArray().map(yMap => ({
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          content: (yMap.get('content') as Y.Text).toString(),
          position: yMap.get('position') as string
        }));
        blocks.sort((a, b) => a.position < b.position ? -1 : 1);
        expect(blocks[0].content).toBe('Second');
        expect(blocks[1].content).toBe('First');
      });
    });

    it('does not move first block up', async () => {
      const user = userEvent.setup();
      const positions = createSequentialPositions(2);
      const block1 = createBlock('First', 'bullet', 0, positions[0]);
      const block2 = createBlock('Second', 'bullet', 0, positions[1]);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('First'));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      const originalPosition = (yArray.get(0).get('position') as string);

      await user.keyboard('{Meta>}{ArrowUp}{/Meta}');

      // Position should not change
      await waitFor(() => {
        expect(yArray.get(0).get('position')).toBe(originalPosition);
      });
    });

    it('does not move last block down', async () => {
      const user = userEvent.setup();
      const block1 = createBlock('First', 'bullet', 0, positions[0]);
      const block2 = createBlock('Second', 'bullet', 0, positions[1]);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Second'));
      const textarea = screen.getByRole('textbox');
      await user.click(textarea);
      const originalPosition = (yArray.get(1).get('position') as string);

      await user.keyboard('{Meta>}{ArrowDown}{/Meta}');

      // Position should not change
      await waitFor(() => {
        expect(yArray.get(1).get('position')).toBe(originalPosition);
      });
    });
  });

  describe('Keyboard Shortcuts - Navigation', () => {
    it('navigates to previous block on ArrowUp at start', async () => {
      const user = userEvent.setup();
      const block1 = createBlock('First', 'bullet', 0, positions[0]);
      const block2 = createBlock('Second', 'bullet', 0, positions[1]);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Second'));
      const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');

      // Move cursor to start
      textarea.setSelectionRange(0, 0);
      await user.keyboard('{ArrowUp}');

      // Should focus first block
      await waitFor(() => {
        const activeTextarea = screen.getByRole<HTMLTextAreaElement>('textbox');
        expect(activeTextarea.value).toBe('First');
      });
    });

    it('navigates to next block on ArrowDown at end', async () => {
      const user = userEvent.setup();
      const block1 = createBlock('First', 'bullet', 0, positions[0]);
      const block2 = createBlock('Second', 'bullet', 0, positions[1]);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('First'));
      const textarea = screen.getByRole<HTMLTextAreaElement>('textbox');

      // Move cursor to end
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      await user.keyboard('{ArrowDown}');

      // Should focus second block
      await waitFor(() => {
        const activeTextarea = screen.getByRole<HTMLTextAreaElement>('textbox');
        expect(activeTextarea.value).toBe('Second');
      });
    });
  });

  describe('Button Interactions', () => {
    it('toggles heading when prefix indicator is clicked', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      // Focus the block first to show the buttons
      await user.click(screen.getByText('Test'));

      const prefixButton = screen.getByTitle(/Click to toggle heading/i);
      await user.click(prefixButton);

      await waitFor(() => {
        const yMap = yArray.get(0);
        expect(yMap.get('type')).toBe('heading');
      });
    });

    it('moves block up when up button is clicked', async () => {
      const user = userEvent.setup();
      const block1 = createBlock('First', 'bullet', 0, positions[0]);
      const block2 = createBlock('Second', 'bullet', 0, positions[1]);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      render(<BlockEditor yArray={yArray} />);

      // Focus the second block first to show its buttons
      await user.click(screen.getByText('Second'));

      const upButtons = screen.getAllByTitle(/Move up/i);
      await user.click(upButtons[0]); // Click second block's up button (only visible button)

      await waitFor(() => {
        const blocks = yArray.toArray().map(yMap => ({
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          content: (yMap.get('content') as Y.Text).toString(),
          position: yMap.get('position') as string
        }));
        blocks.sort((a, b) => a.position < b.position ? -1 : 1);
        expect(blocks[0].content).toBe('Second');
      });
    });

    it('moves block down when down button is clicked', async () => {
      const user = userEvent.setup();
      const block1 = createBlock('First', 'bullet', 0, positions[0]);
      const block2 = createBlock('Second', 'bullet', 0, positions[1]);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      render(<BlockEditor yArray={yArray} />);

      // Focus the first block first to show its buttons
      await user.click(screen.getByText('First'));

      const downButtons = screen.getAllByTitle(/Move down/i);
      await user.click(downButtons[0]); // Click first block's down button

      await waitFor(() => {
        const blocks = yArray.toArray().map(yMap => ({
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          content: (yMap.get('content') as Y.Text).toString(),
          position: yMap.get('position') as string
        }));
        blocks.sort((a, b) => a.position < b.position ? -1 : 1);
        expect(blocks[0].content).toBe('Second');
      });
    });

    it('indents when indent button is clicked', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      // Focus the block first to show the buttons
      await user.click(screen.getByText('Test'));

      const indentButton = screen.getByTitle(/^Indent/i);
      await user.click(indentButton);

      await waitFor(() => {
        expect(yArray.get(0).get('level')).toBe(1);
      });
    });

    it('dedents when dedent button is clicked', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 2, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      // Focus the block first to show the buttons
      await user.click(screen.getByText('Test'));

      const dedentButton = screen.getByTitle(/Dedent/i);
      await user.click(dedentButton);

      await waitFor(() => {
        expect(yArray.get(0).get('level')).toBe(1);
      });
    });

    it('disables up button for first block', async () => {
      const user = userEvent.setup();
      const block1 = createBlock('First', 'bullet', 0, positions[0]);
      const block2 = createBlock('Second', 'bullet', 0, positions[1]);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      render(<BlockEditor yArray={yArray} />);

      // Focus the first block to show its buttons
      await user.click(screen.getByText('First'));

      const upButtons = screen.getAllByTitle(/Move up/i);
      expect(upButtons[0]).toBeDisabled();
    });

    it('disables down button for last block', async () => {
      const user = userEvent.setup();
      const block1 = createBlock('First', 'bullet', 0, positions[0]);
      const block2 = createBlock('Second', 'bullet', 0, positions[1]);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      render(<BlockEditor yArray={yArray} />);

      // Focus the second block to show its buttons
      await user.click(screen.getByText('Second'));

      const downButtons = screen.getAllByTitle(/Move down/i);
      expect(downButtons[0]).toBeDisabled();
    });

    it('disables indent button at max level', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 5, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      // Focus the block to show the buttons
      await user.click(screen.getByText('Test'));

      const indentButton = screen.getByTitle(/^Indent/i);
      expect(indentButton).toBeDisabled();
    });

    it('disables dedent button at level 0', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      // Focus the block to show the buttons
      await user.click(screen.getByText('Test'));

      const dedentButton = screen.getByTitle(/Dedent/i);
      expect(dedentButton).toBeDisabled();
    });
  });

  describe('Markdown Serialization', () => {
    it('generates correct markdown through onTextChanged', async () => {
      const onTextChanged = vi.fn<(markdown: string) => void>();

      const block1 = createBlock('Title', 'heading', 0, positions[0]);
      const block2 = createBlock('First point', 'bullet', 0, positions[1]);
      const block3 = createBlock('Nested point', 'bullet', 1, positions[2]);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);
      addBlockToYArray(yArray, block3);

      render(<BlockEditor yArray={yArray} onTextChanged={onTextChanged} />);

      // Wait for initial render callback
      await waitFor(() => {
        expect(onTextChanged).toHaveBeenCalled();
      });

      const markdown = onTextChanged.mock.calls[onTextChanged.mock.calls.length - 1][0];
      expect(markdown).toBe('## Title\n- First point\n  - Nested point');
    });

    it('skips empty blocks when serializing', async () => {
      const onTextChanged = vi.fn<(markdown: string) => void>();

      const block1 = createBlock('Title', 'heading', 0, positions[0]);
      const block2 = createBlock('', 'bullet', 0, positions[1]); // empty
      const block3 = createBlock('Point', 'bullet', 0, positions[2]);
      const block4 = createBlock('  ', 'bullet', 1, positions[3]); // whitespace only
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);
      addBlockToYArray(yArray, block3);
      addBlockToYArray(yArray, block4);

      render(<BlockEditor yArray={yArray} onTextChanged={onTextChanged} />);

      // Wait for initial render callback
      await waitFor(() => {
        expect(onTextChanged).toHaveBeenCalled();
      });

      const markdown = onTextChanged.mock.calls[onTextChanged.mock.calls.length - 1][0];
      // Should only contain Title and Point, skipping empty and whitespace-only blocks
      expect(markdown).toBe('## Title\n- Point');
    });
  });

  describe('Focus Management', () => {
    it('focuses textarea when block becomes focused', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));

      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveFocus();
    });

    it('unfocuses block when clicking away (onBlur)', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} />);

      await user.click(screen.getByText('Test'));
      expect(screen.getByRole('textbox')).toBeInTheDocument();

      // Blur the textarea
      const textarea = screen.getByRole('textbox');
      act(() => {
        textarea.blur();
      });

      // Should switch back to div display
      await waitFor(() => {
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        expect(screen.getByText('Test')).toBeInTheDocument();
      });
    });
  });

  describe('Non-editable Mode', () => {
    it('does not allow editing when editable is false', async () => {
      const user = userEvent.setup();
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} editable={false} />);

      await user.click(screen.getByText('Test'));

      // Should not create a textarea
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('does not process keyboard shortcuts when editable is false', async () => {
      const user = userEvent.setup();
      const positions = createSequentialPositions(1);
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      render(<BlockEditor yArray={yArray} editable={false} />);

      // Try to trigger keyboard events (they should be ignored)
      const blockDiv = screen.getByText('Test');
      await user.click(blockDiv);

      // No textarea means no keyboard shortcuts can be triggered
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });
  });

  describe('Yjs Integration', () => {
    it('maintains block order using fractional indices', () => {
      // Create blocks with explicit fractional index positions
      const block1 = createBlock('First', 'bullet', 0, 'a0');
      const block2 = createBlock('Second', 'bullet', 0, 'a1');
      const block3 = createBlock('Third', 'bullet', 0, 'a2');

      // Add in reverse order to Yjs
      addBlockToYArray(yArray, block3);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      const { container } = render(<BlockEditor yArray={yArray} />);

      // Should render in sorted order by position
      const texts = Array.from(container.querySelectorAll('.cursor-text')).map(
        el => el.textContent
      );

      expect(texts[0]).toBe('First');
      expect(texts[1]).toBe('Second');
      expect(texts[2]).toBe('Third');
    });

    it('handles external Yjs insertions', async () => {
      const positions = createSequentialPositions(2);
      const block1 = createBlock('First', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block1);

      render(<BlockEditor yArray={yArray} />);

      expect(screen.getByText('First')).toBeInTheDocument();

      // Add a block externally
      act(() => {
        const block2 = createBlock('Inserted', 'bullet', 0, positions[1]);
        addBlockToYArray(yArray, block2);
      });

      await waitFor(() => {
        expect(screen.getByText('Inserted')).toBeInTheDocument();
      });
    });

    it('handles external Yjs deletions', async () => {
      const positions = createSequentialPositions(2);
      const block1 = createBlock('First', 'bullet', 0, positions[0]);
      const block2 = createBlock('Second', 'bullet', 0, positions[1]);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      render(<BlockEditor yArray={yArray} />);

      expect(screen.getByText('Second')).toBeInTheDocument();

      // Delete a block externally
      act(() => {
        yArray.delete(1, 1);
      });

      await waitFor(() => {
        expect(screen.queryByText('Second')).not.toBeInTheDocument();
      });
    });
  });

  describe('Empty Area Click', () => {
    it('creates a block when clicking empty area with no blocks', async () => {
      const user = userEvent.setup();
      render(<BlockEditor yArray={yArray} />);

      expect(yArray.length).toBe(0);
      expect(screen.getByText('Click to start writing...')).toBeInTheDocument();

      await user.click(screen.getByText('Click to start writing...'));

      await waitFor(() => {
        expect(yArray.length).toBe(1);
        expect(screen.getByRole('textbox')).toBeInTheDocument();
      });
    });

    it('shows "No blocks yet" when editable is false and no blocks', () => {
      render(<BlockEditor yArray={yArray} editable={false} />);

      expect(screen.getByText('No blocks yet')).toBeInTheDocument();
      expect(screen.queryByText('Click to start writing...')).not.toBeInTheDocument();
    });

    it('focuses last block when clicking area below blocks', async () => {
      const user = userEvent.setup();
      const positions = createSequentialPositions(2);
      const block1 = createBlock('First', 'bullet', 0, positions[0]);
      const block2 = createBlock('Second', 'bullet', 0, positions[1]);
      addBlockToYArray(yArray, block1);
      addBlockToYArray(yArray, block2);

      const { container } = render(<BlockEditor yArray={yArray} />);

      // Click the empty area below the blocks
      const emptyArea = container.querySelector('.min-h-\\[2rem\\].cursor-text');
      expect(emptyArea).toBeInTheDocument();

      if (emptyArea) {
        await user.click(emptyArea);
      }

      // Should focus the last block (Second)
      await waitFor(() => {
        const textarea = screen.getByRole('textbox');
        expect(textarea).toHaveValue('Second');
      });
    });

    it('does not create block when clicking empty area with editable=false', async () => {
      const user = userEvent.setup();
      render(<BlockEditor yArray={yArray} editable={false} />);

      expect(yArray.length).toBe(0);
      const noBlocksText = screen.getByText('No blocks yet');
      await user.click(noBlocksText);

      // Should still have no blocks
      expect(yArray.length).toBe(0);
    });

    it('does not show empty area below blocks when editable=false', () => {
      const positions = createSequentialPositions(1);
      const block = createBlock('Test', 'bullet', 0, positions[0]);
      addBlockToYArray(yArray, block);

      const { container } = render(<BlockEditor yArray={yArray} editable={false} />);

      // Empty area below blocks should not exist
      const emptyArea = container.querySelector('.min-h-\\[2rem\\].cursor-text');
      expect(emptyArea).not.toBeInTheDocument();
    });
  });
});
