import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  DEFAULT_SOURCE_LANGUAGE,
  LIVE_AUDIO_CONFIG_KEY,
  SOURCE_LANGUAGE_FIELD,
  normalizeSourceLanguage,
  readSourceLanguage,
  writeSourceLanguage,
} from './liveAudioConfig';

describe('readSourceLanguage', () => {
  it('reads English for a doc that never declared one', () => {
    // Every session recorded before this setting existed. They were all English, so the
    // fallback isn't a guess — it's what keeps old exports and old sessions correct.
    expect(readSourceLanguage(new Y.Doc())).toBe(DEFAULT_SOURCE_LANGUAGE);
  });

  it('round-trips a declared language', () => {
    const doc = new Y.Doc();
    writeSourceLanguage(doc, 'es');
    expect(readSourceLanguage(doc)).toBe('es');
  });

  it('falls back rather than trusting a junk value', () => {
    const doc = new Y.Doc();
    doc.getMap(LIVE_AUDIO_CONFIG_KEY).set(SOURCE_LANGUAGE_FIELD, 42);
    expect(readSourceLanguage(doc)).toBe(DEFAULT_SOURCE_LANGUAGE);
  });
});

describe('writeSourceLanguage', () => {
  it('does not touch the doc when the language is unchanged', () => {
    // A broadcaster re-declaring the same language on every reconnect would otherwise
    // put an update on the wire for a fact that hasn't changed.
    const doc = new Y.Doc();
    writeSourceLanguage(doc, 'es');
    let updates = 0;
    doc.on('update', () => updates++);
    writeSourceLanguage(doc, 'es');
    expect(updates).toBe(0);
    writeSourceLanguage(doc, 'ht');
    expect(updates).toBe(1);
  });

  it('trims a code before storing it', () => {
    const doc = new Y.Doc();
    writeSourceLanguage(doc, ' es ');
    expect(readSourceLanguage(doc)).toBe('es');
  });
});

describe('normalizeSourceLanguage', () => {
  it('turns anything unusable into the default', () => {
    expect(normalizeSourceLanguage(undefined)).toBe(DEFAULT_SOURCE_LANGUAGE);
    expect(normalizeSourceLanguage('')).toBe(DEFAULT_SOURCE_LANGUAGE);
    expect(normalizeSourceLanguage('   ')).toBe(DEFAULT_SOURCE_LANGUAGE);
    expect(normalizeSourceLanguage(null)).toBe(DEFAULT_SOURCE_LANGUAGE);
  });
});
