import { describe, it, expect } from 'vitest';
import { listenFavorites, LISTEN_LANGUAGE_CODES } from './listenLanguages';

describe('listenFavorites', () => {
  it('drops English for an English-spoken session', () => {
    expect(listenFavorites('en')).toEqual(['fr', 'es']);
  });

  it('adds English when the session is spoken in another language', () => {
    expect(listenFavorites('fr')).toContain('en');
  });

  it('never offers the spoken language as a favorite', () => {
    for (const code of ['en', 'fr', 'es', 'ht']) {
      expect(listenFavorites(code)).not.toContain(code);
    }
  });

  it('offers only supported listen languages', () => {
    for (const code of listenFavorites('fr')) {
      expect(LISTEN_LANGUAGE_CODES).toContain(code);
    }
  });
});
