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

  const reviewed = (text: string): SlideTranslationEntry => ({
    text,
    status: 'reviewed',
    provenance: 'human',
    reviewedAt: 1,
  });
  const auto = (text: string): SlideTranslationEntry => ({
    text,
    status: 'auto',
    provenance: 'llm',
  });

  const SLIDE = 'Praise the Lord';

  it('returns the reviewed entry in the requested language without fallback', () => {
    const lookup = makeLookup({
      [slideTranslationKey('Haitian Creole', SLIDE)]: reviewed('Lwanj pou Senyè a'),
    });
    const result = resolveSlideTranslation('Haitian Creole', SLIDE, lookup);
    expect(result?.entry.text).toBe('Lwanj pou Senyè a');
    expect(result?.displayLanguage).toBe('Haitian Creole');
    expect(result?.isFallbackLanguage).toBe(false);
  });

  it('prefers a reviewed French text over an unreviewed Creole one', () => {
    const lookup = makeLookup({
      [slideTranslationKey('French', SLIDE)]: reviewed('Louez le Seigneur'),
      [slideTranslationKey('Haitian Creole', SLIDE)]: auto('Lwanj (otomatik)'),
    });
    const result = resolveSlideTranslation('Haitian Creole', SLIDE, lookup);
    expect(result?.entry.text).toBe('Louez le Seigneur');
    expect(result?.entry.status).toBe('reviewed');
    expect(result?.displayLanguage).toBe('French');
    expect(result?.isFallbackLanguage).toBe(true);
  });

  it('falls back to an auto entry in the requested language when no reviewed entry exists', () => {
    const lookup = makeLookup({
      [slideTranslationKey('Haitian Creole', SLIDE)]: auto('Lwanj (otomatik)'),
    });
    const result = resolveSlideTranslation('Haitian Creole', SLIDE, lookup);
    expect(result?.entry.status).toBe('auto');
    expect(result?.displayLanguage).toBe('Haitian Creole');
    expect(result?.isFallbackLanguage).toBe(false);
  });

  it('does not use an auto French entry as a fallback for a Creole viewer', () => {
    // Only auto French exists; we do not surface another language's *unreviewed* text.
    const lookup = makeLookup({
      [slideTranslationKey('French', SLIDE)]: auto('Louez (auto)'),
    });
    expect(resolveSlideTranslation('Haitian Creole', SLIDE, lookup)).toBeUndefined();
  });

  it('returns undefined when nothing is available', () => {
    expect(resolveSlideTranslation('Spanish', SLIDE, makeLookup({}))).toBeUndefined();
  });
});
