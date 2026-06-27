import { describe, it, expect } from 'vitest';
import { SlideConversationStore, slidesHash } from './slideConversationStore.ts';

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

describe('SlideConversationStore', () => {
  it('upserts and reads back by itemId, stamping updatedAt', () => {
    const store = new SlideConversationStore();
    expect(store.get('i1')).toBeUndefined();

    const stored = store.upsert(baseConversation());
    expect(stored.updatedAt).toBeGreaterThan(0);
    expect(store.get('i1')?.itemTitle).toBe('Psalm 23');
  });

  it('appends messages to an existing conversation only', () => {
    const store = new SlideConversationStore();
    store.upsert(baseConversation());

    store.appendMessage('i1', { role: 'model', parts: [{ text: 'reply' }] });
    expect(store.get('i1')?.messages).toHaveLength(2);
    expect(store.get('i1')?.messages[1].role).toBe('model');

    // Unknown item is a no-op (returns undefined), not a throw.
    expect(store.appendMessage('nope', { role: 'user', parts: [] })).toBeUndefined();
  });

  it('tracks status transitions', () => {
    const store = new SlideConversationStore();
    store.upsert(baseConversation());
    store.setStatus('i1', 'running');
    expect(store.get('i1')?.status).toBe('running');
    store.setStatus('i1', 'idle');
    expect(store.get('i1')?.status).toBe('idle');
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
