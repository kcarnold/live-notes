import { describe, it, expect } from 'vitest';

import {
  extractLookups,
  computeLookupDiffs,
  LOOKUP_ADAPTERS,
  type CanonicalLookup,
} from './referenceLookupDiff';
import type { Content } from './slideTranslationApi';

/** A model turn that answers `name` with `response`, shaped like nlp.ts writes it. */
function toolResponse(name: string, response: Record<string, unknown>): Content {
  return { role: 'user', parts: [{ functionResponse: { name, response } }] };
}

describe('extractLookups', () => {
  it('pulls the canonical passages out of a Bible lookup response', () => {
    const messages: Content[] = [
      { role: 'user', parts: [{ text: 'translate these slides' }] },
      toolResponse('lookup_bible_passage', {
        reference: 'MAT 7:12-20',
        passages: { French: 'Tout ce que vous voulez', 'Haitian Creole': 'Tou sa nou vle' },
      }),
    ];
    expect(extractLookups(messages)).toEqual([
      {
        label: 'MAT 7:12-20',
        texts: { French: 'Tout ce que vous voulez', 'Haitian Creole': 'Tou sa nou vle' },
      },
    ]);
  });

  it('ignores tools with no registered adapter', () => {
    const messages = [toolResponse('set_translations', { ok: true })];
    expect(extractLookups(messages)).toEqual([]);
  });

  it('ignores a failed lookup, which carries a reference but no passages', () => {
    const messages = [
      toolResponse('lookup_bible_passage', {
        reference: 'PSA 151',
        error: 'No canonical text found for PSA 151',
      }),
    ];
    expect(extractLookups(messages)).toEqual([]);
  });

  it('drops empty passage strings, and the whole lookup when none survive', () => {
    const messages = [
      toolResponse('lookup_bible_passage', { reference: 'JHN 3:16', passages: { French: '   ' } }),
    ];
    expect(extractLookups(messages)).toEqual([]);
  });

  it('merges repeated lookups of one label instead of duplicating them', () => {
    const messages = [
      toolResponse('lookup_bible_passage', { reference: 'PSA 23', passages: { French: 'fr text' } }),
      toolResponse('lookup_bible_passage', {
        reference: 'PSA 23',
        passages: { 'Haitian Creole': 'ht text' },
      }),
    ];
    expect(extractLookups(messages)).toEqual([
      { label: 'PSA 23', texts: { French: 'fr text', 'Haitian Creole': 'ht text' } },
    ]);
  });

  it('dispatches by tool name, so a newly registered adapter is picked up', () => {
    LOOKUP_ADAPTERS.lookup_creed = (response) =>
      typeof response.title === 'string' && typeof response.text === 'string'
        ? { label: response.title, texts: { French: response.text } }
        : null;
    try {
      const messages = [
        toolResponse('lookup_creed', { title: 'Apostles’ Creed', text: 'Je crois en Dieu' }),
      ];
      expect(extractLookups(messages)).toEqual([
        { label: 'Apostles’ Creed', texts: { French: 'Je crois en Dieu' } },
      ]);
    } finally {
      delete LOOKUP_ADAPTERS.lookup_creed;
    }
  });
});

describe('computeLookupDiffs', () => {
  const lookup = (texts: Record<string, string>): CanonicalLookup[] => [{ label: 'PSA 23', texts }];

  it('returns a diff when the agent closely follows the canonical text', () => {
    const diffs = computeLookupDiffs(
      lookup({ French: 'Le Seigneur est mon berger, je ne manquerai de rien.' }),
      { French: ['Le Seigneur est mon pasteur, je ne manquerai de rien.'] },
      ['French'],
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].label).toBe('PSA 23');
    expect(diffs[0].similarity).toBeGreaterThan(0.4);
    // The base is canonical, so the word only the canonical has is `removed`.
    expect(diffs[0].parts.some((part) => part.removed && part.value.includes('berger'))).toBe(true);
    expect(diffs[0].parts.some((part) => part.added && part.value.includes('pasteur'))).toBe(true);
  });

  it('drops pairs whose overlap is below the threshold', () => {
    const diffs = computeLookupDiffs(
      lookup({ French: 'Le Seigneur est mon berger, je ne manquerai de rien.' }),
      { French: ['Bienvenue à notre culte de ce matin, nous sommes heureux de vous voir ici.'] },
      ['French'],
    );
    expect(diffs).toEqual([]);
  });

  it('reports similarity 1 and no changed parts for an exact match', () => {
    const diffs = computeLookupDiffs(
      lookup({ French: 'Le Seigneur est mon berger.' }),
      { French: ['Le Seigneur est mon berger.'] },
      ['French'],
    );
    expect(diffs[0].similarity).toBe(1);
    expect(diffs[0].parts.every((part) => !part.added && !part.removed)).toBe(true);
  });

  it('compares against all of a language’s slides joined, skipping blanks', () => {
    const diffs = computeLookupDiffs(
      lookup({ French: 'Le Seigneur est mon berger, je ne manquerai de rien.' }),
      { French: ['Le Seigneur est mon berger,', '', 'je ne manquerai de rien.'] },
      ['French'],
    );
    expect(diffs[0].similarity).toBe(1);
  });

  it('treats literal \\n escapes in stored drafts as line breaks, not as content', () => {
    const diffs = computeLookupDiffs(
      lookup({ French: 'Le Seigneur est mon berger,\nje ne manquerai de rien.' }),
      { French: ['Le Seigneur est mon berger,\\nje ne manquerai de rien.'] },
      ['French'],
    );
    expect(diffs[0].similarity).toBe(1);
  });

  it('skips languages the lookup has no canonical text for', () => {
    const diffs = computeLookupDiffs(
      lookup({ French: 'Le Seigneur est mon berger.' }),
      { French: ['Le Seigneur est mon berger.'], Spanish: ['El Señor es mi pastor.'] },
      ['French', 'Spanish'],
    );
    expect(diffs.map((diff) => diff.language)).toEqual(['French']);
  });

  it('skips languages the agent has not drafted yet', () => {
    const diffs = computeLookupDiffs(
      lookup({ French: 'Le Seigneur est mon berger.' }),
      { French: ['', ''] },
      ['French'],
    );
    expect(diffs).toEqual([]);
  });

  it('returns nothing when there are no lookups at all', () => {
    expect(computeLookupDiffs([], { French: ['anything'] }, ['French'])).toEqual([]);
  });
});
