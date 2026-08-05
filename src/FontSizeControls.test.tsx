// The shared −/+ control: it writes the one `fontSizeAtom` every reading pane
// (translated text, bilingual, live transcript) renders at, and clamps to a range
// that stays legible without blowing the pane apart.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider, createStore } from 'jotai';
import { fontSizeAtom } from './configAtoms';
import { FontSizeControls, MIN_FONT_SIZE, MAX_FONT_SIZE } from './FontSizeControls';

const renderAt = (px: number) => {
  const store = createStore();
  store.set(fontSizeAtom, px);
  render(
    <Provider store={store}>
      <FontSizeControls />
    </Provider>
  );
  return store;
};

const bigger = () => screen.getByRole('button', { name: 'Increase font size' });
const smaller = () => screen.getByRole('button', { name: 'Decrease font size' });

describe('FontSizeControls', () => {
  it('steps the shared size up and down', async () => {
    const store = renderAt(20);

    await userEvent.click(bigger());
    expect(store.get(fontSizeAtom)).toBe(22);

    await userEvent.click(smaller());
    await userEvent.click(smaller());
    expect(store.get(fontSizeAtom)).toBe(18);
  });

  it('will not grow past the maximum', async () => {
    const store = renderAt(MAX_FONT_SIZE);

    await userEvent.click(bigger());

    expect(store.get(fontSizeAtom)).toBe(MAX_FONT_SIZE);
  });

  it('will not shrink past the minimum', async () => {
    const store = renderAt(MIN_FONT_SIZE);

    await userEvent.click(smaller());

    expect(store.get(fontSizeAtom)).toBe(MIN_FONT_SIZE);
  });
});
