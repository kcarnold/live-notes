import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import { yTextToString, setYTextFromString, useAsPlainText } from './yjsUtils';

// ── useText seam ────────────────────────────────────────────────────────────
// useAsPlainText subscribes to a Y.Text obtained from @y-sweet/react's useText.
// Back it with a real Y.Doc we control; doc.getText(name) is stable per name, so
// the hook sees a new Y.Text only when `name` changes.
let doc: Y.Doc;
vi.mock('@y-sweet/react', () => ({
  useText: (name: string) => doc.getText(name),
}));

beforeEach(() => {
  doc = new Y.Doc();
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('setYTextFromString', () => {
  it('sets the text from empty', () => {
    const t = doc.getText('a');
    setYTextFromString(t, 'hello');
    expect(yTextToString(t)).toBe('hello');
  });

  it('is a no-op when the text is unchanged (emits no update)', () => {
    const t = doc.getText('a');
    setYTextFromString(t, 'hello');

    const onUpdate = vi.fn();
    doc.on('update', onUpdate);
    setYTextFromString(t, 'hello');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('applies a minimal delta rather than clearing and reinserting', () => {
    const t = doc.getText('a');
    setYTextFromString(t, 'hello world');

    // Capture the delta produced by editing the middle of the string.
    const deltas: unknown[] = [];
    t.observe((event) => deltas.push(event.changes.delta));
    setYTextFromString(t, 'hello brave world');

    expect(yTextToString(t)).toBe('hello brave world');
    // Minimal edit: retain the shared prefix, insert only the new word — no delete.
    expect(deltas).toEqual([[{ retain: 6 }, { insert: 'brave ' }]]);
  });

  it('handles deletion in the middle', () => {
    const t = doc.getText('a');
    setYTextFromString(t, 'hello brave world');
    setYTextFromString(t, 'hello world');
    expect(yTextToString(t)).toBe('hello world');
  });

  it('round-trips unicode / multi-line content', () => {
    const t = doc.getText('a');
    setYTextFromString(t, 'café\n\n😀 line');
    expect(yTextToString(t)).toBe('café\n\n😀 line');
    setYTextFromString(t, 'café\n\n😀 lines!');
    expect(yTextToString(t)).toBe('café\n\n😀 lines!');
  });
});

// ── useAsPlainText hook ─────────────────────────────────────────────────────
// These pin the observable behavior so the setState-in-effect lint fix (or an
// eslint-disable) can be verified to preserve it.

describe('useAsPlainText', () => {
  it('returns the current Y.Text contents on mount', () => {
    doc.getText('note').insert(0, 'initial');
    const { result } = renderHook(() => useAsPlainText('note'));
    expect(result.current[0]).toBe('initial');
  });

  it('updates when the Y.Text changes externally', () => {
    const { result } = renderHook(() => useAsPlainText('note'));
    expect(result.current[0]).toBe('');

    act(() => {
      doc.getText('note').insert(0, 'typed by a peer');
    });
    expect(result.current[0]).toBe('typed by a peer');
  });

  it('setter writes through to the Y.Text and state converges via the observer', () => {
    const { result } = renderHook(() => useAsPlainText('note'));

    act(() => {
      result.current[1]('written locally');
    });

    expect(yTextToString(doc.getText('note'))).toBe('written locally');
    expect(result.current[0]).toBe('written locally');
  });

  it('re-syncs state when the name changes', () => {
    doc.getText('a').insert(0, 'text A');
    doc.getText('b').insert(0, 'text B');

    const { result, rerender } = renderHook(({ name }) => useAsPlainText(name), {
      initialProps: { name: 'a' },
    });
    expect(result.current[0]).toBe('text A');

    rerender({ name: 'b' });
    expect(result.current[0]).toBe('text B');
  });

  it('unobserves on unmount (no updates after teardown)', () => {
    const yText = doc.getText('note');
    const unobserveSpy = vi.spyOn(yText, 'unobserve');

    const { result, unmount } = renderHook(() => useAsPlainText('note'));
    unmount();
    expect(unobserveSpy).toHaveBeenCalled();

    // Mutating after unmount must not throw or affect the last-rendered value.
    expect(() =>
      act(() => {
        yText.insert(0, 'late');
      }),
    ).not.toThrow();
    expect(result.current[0]).toBe('');
  });
});
