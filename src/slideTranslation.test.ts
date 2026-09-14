import { describe, it, expect } from 'vitest';
import {
  normalizeSlideText,
  slideTextLines,
  slideTranslationKey,
  fallbackChain,
  resolveSlideTranslation,
  type SlideTranslationEntry,
  type SlideTranslationLookup,
} from './slideTranslation';

describe('normalizeSlideText', () => {
  it('preserves internal line breaks but trims surrounding blank lines', () => {
    expect(normalizeSlideText('\n\nLine one\nLine two\n\n')).toBe('Line one\nLine two');
  });

  it('strips trailing whitespace per line and normalizes CRLF', () => {
    expect(normalizeSlideText('Line one  \r\nLine two\t')).toBe('Line one\nLine two');
  });

  it('applies NFC Unicode normalization', () => {
    // "é" as e + combining accent should normalize to the single code point.
    const decomposed = 'Crédo';
    expect(normalizeSlideText(decomposed)).toBe('Crédo'.normalize('NFC'));
  });
});

describe('slideTextLines', () => {
  it('splits on real line breaks', () => {
    expect(slideTextLines('Sainte nuit\nNuit paisible')).toEqual(['Sainte nuit', 'Nuit paisible']);
  });

  it('rescues entries stored with a literal backslash-n instead of a line break', () => {
    expect(slideTextLines('Sainte nuit\\nNuit paisible')).toEqual([
      'Sainte nuit',
      'Nuit paisible',
    ]);
  });

  it('leaves an escaped backslash as literal text rather than breaking the line', () => {
    expect(slideTextLines('path C:\\\\next')).toEqual(['path C:\\next']);
  });
});

describe('slideTranslationKey', () => {
  it('combines language with normalized text', () => {
    expect(slideTranslationKey('French', '  Bonjour  ')).toBe('French:Bonjour');
  });

  it('produces equal keys for text differing only in trailing whitespace', () => {
    expect(slideTranslationKey('French', 'Bonjour\n')).toBe(slideTranslationKey('French', 'Bonjour'));
  });
});

describe('fallbackChain', () => {
  it('returns the configured chain for Haitian Creole', () => {
    expect(fallbackChain('Haitian Creole')).toEqual(['Haitian Creole', 'French']);
  });

  it('defaults to the language itself when not configured', () => {
    expect(fallbackChain('Spanish')).toEqual(['Spanish']);
  });
});

describe('resolveSlideTranslation', () => {
  function makeLookup(entries: Record<string, SlideTranslationEntry>): SlideTranslationLookup {
    return (language, slideText) => entries[slideTranslationKey(language, slideText)];
  }

  const entry = (text: string): SlideTranslationEntry => ({ text, provenance: 'human' });

  const SLIDE = 'Praise the Lord';

  it('returns the entry in the requested language without fallback', () => {
    const lookup = makeLookup({
      [slideTranslationKey('French', SLIDE)]: entry('Louez le Seigneur'),
      [slideTranslationKey('Haitian Creole', SLIDE)]: entry('Lwanj pou Senyè a'),
    });
    const result = resolveSlideTranslation('Haitian Creole', SLIDE, lookup);
    expect(result?.entry.text).toBe('Lwanj pou Senyè a');
    expect(result?.displayLanguage).toBe('Haitian Creole');
    expect(result?.isFallbackLanguage).toBe(false);
  });

  it('falls back down the chain when the requested language has nothing', () => {
    const lookup = makeLookup({
      [slideTranslationKey('French', SLIDE)]: entry('Louez le Seigneur'),
    });
    const result = resolveSlideTranslation('Haitian Creole', SLIDE, lookup);
    expect(result?.entry.text).toBe('Louez le Seigneur');
    expect(result?.displayLanguage).toBe('French');
    expect(result?.isFallbackLanguage).toBe(true);
  });

  it('does not fall back for a language with no chain configured', () => {
    const lookup = makeLookup({
      [slideTranslationKey('French', SLIDE)]: entry('Louez le Seigneur'),
    });
    expect(resolveSlideTranslation('Spanish', SLIDE, lookup)).toBeUndefined();
  });

  it('returns undefined when nothing is available', () => {
    expect(resolveSlideTranslation('Spanish', SLIDE, makeLookup({}))).toBeUndefined();
  });
});
