import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  CONVERSATIONS_MAP,
  readConversation,
  writeConversation,
  appendMessageTo,
  setStatusIn,
  slidesHash,
  type SlideConversation,
} from './slideConversationStore.ts';

function conversationsMap() {
  return new Y.Doc().getMap<SlideConversation>(CONVERSATIONS_MAP);
}

function baseConversation() {
  return {
    itemId: 'i1',
    itemTitle: 'Psalm 23',
    slides: ['The Lord is my shepherd'],
    slidesHash: slidesHash(['The Lord is my shepherd']),
    languages: ['French'],
    messages: [{ role: 'user' as const, parts: [{ text: 'prompt' }] }],
    status: 'idle' as const,
  };
}

describe('slideConversations Y.Map helpers', () => {
  it('writes and reads back by id, stamping updatedAt', () => {
    const map = conversationsMap();
    expect(readConversation(map, 'i1')).toBeUndefined();

    const stored = writeConversation(map, baseConversation());
    expect(stored.updatedAt).toBeGreaterThan(0);
    expect(readConversation(map, 'i1')?.itemTitle).toBe('Psalm 23');
  });

  it('appends messages to an existing conversation only', () => {
    const map = conversationsMap();
    writeConversation(map, baseConversation());

    appendMessageTo(map, 'i1', { role: 'model', parts: [{ text: 'reply' }] });
    expect(readConversation(map, 'i1')?.messages).toHaveLength(2);
    expect(readConversation(map, 'i1')?.messages[1].role).toBe('model');

    // Unknown id is a no-op (returns undefined), not a throw.
    expect(appendMessageTo(map, 'nope', { role: 'user', parts: [] })).toBeUndefined();
  });

  it('appends without mutating the stored snapshot in place', () => {
    const map = conversationsMap();
    writeConversation(map, baseConversation());
    const before = readConversation(map, 'i1');

    appendMessageTo(map, 'i1', { role: 'model', parts: [{ text: 'reply' }] });
    // The earlier read must not have grown — each write replaces with a fresh object.
    expect(before?.messages).toHaveLength(1);
    expect(readConversation(map, 'i1')?.messages).toHaveLength(2);
  });

  it('tracks status transitions; unknown id is a no-op', () => {
    const map = conversationsMap();
    writeConversation(map, baseConversation());
    setStatusIn(map, 'i1', 'running');
    expect(readConversation(map, 'i1')?.status).toBe('running');
    setStatusIn(map, 'i1', 'idle');
    expect(readConversation(map, 'i1')?.status).toBe('idle');

    setStatusIn(map, 'nope', 'error');
    expect(readConversation(map, 'nope')).toBeUndefined();
  });
});

describe('slidesHash', () => {
  it('is stable and sensitive to content (mirrors the Python slides_hash)', () => {
    expect(slidesHash(['a', 'b'])).toBe(slidesHash(['a', 'b']));
    expect(slidesHash(['a', 'b'])).not.toBe(slidesHash(['a', 'b', 'c']));
    // The NUL separator means ['a','b'] and ['ab'] differ.
    expect(slidesHash(['a', 'b'])).not.toBe(slidesHash(['ab']));
  });
});
