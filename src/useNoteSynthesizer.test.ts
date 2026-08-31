import { describe, it, expect } from 'vitest';
import { pendingTranscript, hasEnoughToSynthesize } from './useNoteSynthesizer';

describe('pendingTranscript', () => {
  it('returns the tail after the cursor', () => {
    expect(pendingTranscript('hello world', 6)).toBe('world');
  });

  it('returns empty when the cursor is at/after the end', () => {
    expect(pendingTranscript('hello', 5)).toBe('');
    expect(pendingTranscript('hello', 99)).toBe('');
  });

  it('clamps a negative cursor to the start', () => {
    expect(pendingTranscript('hello', -3)).toBe('hello');
  });
});

describe('hasEnoughToSynthesize', () => {
  const opts = { minChars: 140, minSentenceChars: 40, minIntervalMs: 12000 };
  const now = 1_000_000;

  it('waits until the minimum interval has elapsed', () => {
    const longText = 'x'.repeat(200);
    expect(hasEnoughToSynthesize(longText, now - 5000, now, opts)).toBe(false);
    expect(hasEnoughToSynthesize(longText, now - 12000, now, opts)).toBe(true);
  });

  it('is false for empty / whitespace pending text', () => {
    expect(hasEnoughToSynthesize('   \n  ', 0, now, opts)).toBe(false);
  });

  it('is true once enough characters accumulate', () => {
    expect(hasEnoughToSynthesize('x'.repeat(140), 0, now, opts)).toBe(true);
    expect(hasEnoughToSynthesize('x'.repeat(139), 0, now, opts)).toBe(false);
  });

  it('fires earlier when a completed sentence (paragraph break) is present', () => {
    const oneSentence = 'This is a complete first thought worth noting.\n\n';
    expect(oneSentence.trim().length).toBeGreaterThanOrEqual(40);
    expect(hasEnoughToSynthesize(oneSentence, 0, now, opts)).toBe(true);
    // A short fragment with a break is still too little.
    expect(hasEnoughToSynthesize('Um.\n\n', 0, now, opts)).toBe(false);
  });
});
