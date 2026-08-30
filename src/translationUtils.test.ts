/**
 * Tests for the block translation pipeline — the path every set of notes takes on its way
 * to a viewer.
 *
 * The behaviour that matters here is *incrementality*: an editor types one new bullet into
 * a page of already-translated notes, and the model should see that bullet plus enough
 * neighbouring context to translate it consistently — not the whole page again, and not
 * the bullet stripped of its surroundings. That bargain lives in the interaction between
 * the cache lookup, the 3-line context window, and the contiguous-run grouping, so most of
 * these tests exercise `buildBlockTranslationRequests` on a realistic mixed page rather
 * than each helper alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  findContiguousBlocks,
  translationCacheKey,
  updateTranslationCache,
  getBlockTranslationTodos,
  buildBlockTranslationRequests,
  fetchAndCacheTranslations,
  type TranslationBlock,
  type TranslationCache,
  type TranslationTodo,
} from './translationUtils.ts';
import { apiFetch } from './writeKey.ts';

// The cache is a Y.Map in production; the pipeline only ever uses get/set/has, so a real
// Map behind that interface is a faithful stand-in and keeps Yjs out of these tests.
function makeCache(entries: Record<string, string> = {}): TranslationCache & { map: Map<string, string> } {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    has: (key) => map.has(key),
  };
}

/** A cache already holding `Fr(<content>)` for each of the given blocks. */
function cacheFor(language: string, contents: string[]): ReturnType<typeof makeCache> {
  const entries: Record<string, string> = {};
  for (const content of contents) {
    entries[translationCacheKey(language, content)] = `${language}(${content})`;
  }
  return makeCache(entries);
}

function bullet(content: string, level = 0): TranslationBlock {
  return { type: 'bullet', level, content };
}

function heading(content: string, level = 0): TranslationBlock {
  return { type: 'heading', level, content };
}

describe('findContiguousBlocks', () => {
  it('returns no ranges for an empty array', () => {
    expect(findContiguousBlocks([])).toEqual([]);
  });

  it('returns no ranges when every value is falsy', () => {
    expect(findContiguousBlocks([0, 0, 0])).toEqual([]);
  });

  it('finds a single-element run', () => {
    expect(findContiguousBlocks([1])).toEqual([[0, 0]]);
  });

  it('closes a run that ends at the last element', () => {
    expect(findContiguousBlocks([0, 1, 1])).toEqual([[1, 2]]);
  });

  it('closes a run that ends before the last element', () => {
    expect(findContiguousBlocks([1, 1, 0])).toEqual([[0, 1]]);
  });

  it('separates runs split by a falsy value', () => {
    expect(findContiguousBlocks([1, 0, 1, 1, 0, 1])).toEqual([[0, 0], [2, 3], [5, 5]]);
  });

  it('treats every non-zero chunk status as part of a run', () => {
    // The pipeline feeds it 0 = skip, 1 = translate, 2 = context. Context lines have to
    // ride along in the same request as the block they are context for, which only works
    // because 2 is truthy.
    expect(findContiguousBlocks([0, 2, 2, 1, 0])).toEqual([[1, 3]]);
  });
});

describe('translationCacheKey', () => {
  it('combines language and content', () => {
    expect(translationCacheKey('French', 'Hello')).toBe('French:Hello');
  });

  it('keeps the same text in different languages apart', () => {
    expect(translationCacheKey('French', 'Hello')).not.toBe(translationCacheKey('Spanish', 'Hello'));
  });
});

describe('getBlockTranslationTodos', () => {
  it('drops empty and whitespace-only blocks', () => {
    const blocks = [bullet('Real'), bullet(''), bullet('   \n  '), bullet('Also real')];
    const { contents, isTranslationNeeded } = getBlockTranslationTodos('French', blocks, makeCache());
    expect(contents).toEqual(['Real', 'Also real']);
    expect(isTranslationNeeded).toEqual([true, true]);
  });

  it('reports content trimmed', () => {
    const { contents } = getBlockTranslationTodos('French', [bullet('  padded  ')], makeCache());
    expect(contents).toEqual(['padded']);
  });

  it('looks the cache up under the trimmed text', () => {
    // An editor adding a trailing space must not invalidate an existing translation —
    // otherwise idle typing re-bills the whole page.
    const cache = cacheFor('French', ['Grace and peace']);
    const { isTranslationNeeded } = getBlockTranslationTodos(
      'French',
      [bullet('  Grace and peace  ')],
      cache,
    );
    expect(isTranslationNeeded).toEqual([false]);
  });

  it('marks only the blocks missing from the cache', () => {
    const cache = cacheFor('French', ['One', 'Three']);
    const blocks = [bullet('One'), bullet('Two'), bullet('Three')];
    const { contents, isTranslationNeeded } = getBlockTranslationTodos('French', blocks, cache);
    expect(contents).toEqual(['One', 'Two', 'Three']);
    expect(isTranslationNeeded).toEqual([false, true, false]);
  });

  it('is language-specific', () => {
    const cache = cacheFor('French', ['One']);
    const { isTranslationNeeded } = getBlockTranslationTodos('Spanish', [bullet('One')], cache);
    expect(isTranslationNeeded).toEqual([true]);
  });
});

describe('buildBlockTranslationRequests', () => {
  it('asks for nothing when every block is already cached', () => {
    const blocks = [bullet('One'), bullet('Two')];
    const cache = cacheFor('French', ['One', 'Two']);
    expect(buildBlockTranslationRequests('French', blocks, cache)).toEqual([]);
  });

  it('asks for nothing when there are no blocks', () => {
    expect(buildBlockTranslationRequests('French', [], makeCache())).toEqual([]);
  });

  it('groups a fully untranslated page into one request', () => {
    const blocks = [bullet('One'), bullet('Two'), bullet('Three')];
    const todos = buildBlockTranslationRequests('French', blocks, makeCache());
    expect(todos).toHaveLength(1);
    expect(todos[0].chunks).toEqual(['One', 'Two', 'Three']);
    expect(todos[0].isTranslationNeeded).toEqual([true, true, true]);
    expect(todos[0].offset).toBe(0);
  });

  it('carries at most the 3 preceding cached blocks as context', () => {
    const blocks = [bullet('C0'), bullet('C1'), bullet('C2'), bullet('C3'), bullet('New')];
    const cache = cacheFor('French', ['C0', 'C1', 'C2', 'C3']);
    const todos = buildBlockTranslationRequests('French', blocks, cache);

    expect(todos).toHaveLength(1);
    // C0 is the 4th block back, so it is left out entirely.
    expect(todos[0].chunks).toEqual(['C1', 'C2', 'C3', 'New']);
    expect(todos[0].isTranslationNeeded).toEqual([false, false, false, true]);
    expect(todos[0].offset).toBe(1);
  });

  it('takes fewer context blocks when the page has fewer to give', () => {
    const blocks = [bullet('C0'), bullet('New')];
    const todos = buildBlockTranslationRequests('French', blocks, cacheFor('French', ['C0']));
    expect(todos[0].chunks).toEqual(['C0', 'New']);
    expect(todos[0].isTranslationNeeded).toEqual([false, true]);
  });

  it('sends the cached translation as context, rendered back to markdown', () => {
    // The model needs the heading/bullet structure to keep register and indentation
    // consistent, so context is re-rendered rather than sent as bare text.
    const blocks = [heading('Title'), bullet('Point', 1), bullet('New')];
    const cache = cacheFor('French', ['Title', 'Point']);
    const todos = buildBlockTranslationRequests('French', blocks, cache);

    expect(todos[0].translatedContext).toBe('## French(Title)\n  - French(Point)\n');
  });

  it('deepens heading hashes with level and caps them at 6', () => {
    const blocks = [heading('H1', 0), heading('H2', 2), heading('H3', 9), bullet('New')];
    const cache = cacheFor('French', ['H1', 'H2', 'H3']);
    // Only 3 blocks of context are taken, which is exactly the three headings.
    const todos = buildBlockTranslationRequests('French', blocks, cache);

    expect(todos[0].translatedContext.split('\n').slice(0, 3)).toEqual([
      '## French(H1)',
      '#### French(H2)',
      '###### French(H3)',
    ]);
  });

  it('leaves a blank context line for the blocks it is asking about', () => {
    const blocks = [bullet('Cached'), bullet('New')];
    const todos = buildBlockTranslationRequests('French', blocks, cacheFor('French', ['Cached']));
    expect(todos[0].translatedContext).toBe('- French(Cached)\n');
  });

  it('splits distant edits into separate requests', () => {
    // Two edits far apart on a long page: each gets its own request with its own
    // neighbourhood, rather than one request dragging the whole page along.
    const cached = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
    const blocks = [
      bullet('EditA'),
      ...cached.map((c) => bullet(c)),
      bullet('EditB'),
    ];
    const todos = buildBlockTranslationRequests('French', blocks, cacheFor('French', cached));

    expect(todos).toHaveLength(2);
    expect(todos[0].chunks).toEqual(['EditA']);
    expect(todos[0].offset).toBe(0);
    // EditB is at index 8; its 3 context blocks are C4, C5, C6 at indices 5-7.
    expect(todos[1].chunks).toEqual(['C4', 'C5', 'C6', 'EditB']);
    expect(todos[1].isTranslationNeeded).toEqual([false, false, false, true]);
    expect(todos[1].offset).toBe(5);
  });

  it('merges nearby edits into one request', () => {
    const blocks = [bullet('EditA'), bullet('C0'), bullet('EditB')];
    const todos = buildBlockTranslationRequests('French', blocks, cacheFor('French', ['C0']));

    expect(todos).toHaveLength(1);
    expect(todos[0].chunks).toEqual(['EditA', 'C0', 'EditB']);
    expect(todos[0].isTranslationNeeded).toEqual([true, false, true]);
  });

  it('indexes offsets against the non-empty blocks, not the raw page', () => {
    // Empty blocks are dropped before grouping, so an offset is a position in the
    // filtered list. Anything reading offsets has to filter the same way.
    const blocks = [bullet(''), bullet('Cached'), bullet('  '), bullet('New')];
    const todos = buildBlockTranslationRequests('French', blocks, cacheFor('French', ['Cached']));

    expect(todos).toHaveLength(1);
    expect(todos[0].chunks).toEqual(['Cached', 'New']);
    expect(todos[0].offset).toBe(0);
  });

  it('sends trimmed chunks', () => {
    const todos = buildBlockTranslationRequests('French', [bullet('  padded  ')], makeCache());
    expect(todos[0].chunks).toEqual(['padded']);
  });
});

describe('updateTranslationCache', () => {
  it('stores each result under its language and source text', () => {
    const cache = makeCache();
    updateTranslationCache(
      {
        ok: true,
        results: [
          [
            { sourceText: 'One', translatedText: 'Un', language: 'French' },
            { sourceText: 'Two', translatedText: 'Deux', language: 'French' },
          ],
          [{ sourceText: 'One', translatedText: 'Uno', language: 'Spanish' }],
        ],
      },
      cache,
    );

    expect(cache.get('French:One')).toBe('Un');
    expect(cache.get('French:Two')).toBe('Deux');
    expect(cache.get('Spanish:One')).toBe('Uno');
  });

  it('trims stray whitespace off both sides of the entry', () => {
    // A model that returns a trailing newline must not create a cache entry that the next
    // lookup (which trims) can never hit.
    const cache = makeCache();
    updateTranslationCache(
      { ok: true, results: [[{ sourceText: ' One ', translatedText: ' Un \n', language: 'French' }]] },
      cache,
    );

    expect(cache.map.has('French:One')).toBe(true);
    expect(cache.get('French:One')).toBe('Un');
  });

  it('accepts an empty result set', () => {
    const cache = makeCache();
    updateTranslationCache({ ok: true, results: [] }, cache);
    expect(cache.map.size).toBe(0);
  });
});

vi.mock('./writeKey.ts', () => ({ apiFetch: vi.fn() }));

describe('fetchAndCacheTranslations', () => {
  const mockApiFetch = vi.mocked(apiFetch);

  /** A `fetch`-shaped response carrying `body` as JSON. */
  function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.statusText ?? 'OK',
      json: () => Promise.resolve(body),
    } as Response;
  }

  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes no request when everything is already cached', async () => {
    await fetchAndCacheTranslations('French', [bullet('One')], cacheFor('French', ['One']));
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('posts the todos and the language, and caches what comes back', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        ok: true,
        results: [[{ sourceText: 'One', translatedText: 'Un', language: 'French' }]],
      }),
    );

    const cache = makeCache();
    await fetchAndCacheTranslations('French', [bullet('One')], cache);

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockApiFetch.mock.calls[0];
    expect(url).toBe('/api/requestTranslatedBlocks');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as {
      language: string;
      translationTodos: TranslationTodo[];
    };
    expect(body.language).toBe('French');
    expect(body.translationTodos).toHaveLength(1);
    expect(body.translationTodos[0].chunks).toEqual(['One']);

    expect(cache.get('French:One')).toBe('Un');
  });

  it('surfaces the error the server reported', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({ ok: false, error: 'quota exhausted', results: [] }, { ok: false, status: 429 }),
    );

    await expect(fetchAndCacheTranslations('French', [bullet('One')], makeCache())).rejects.toThrow(
      'Translation error (429): quota exhausted',
    );
  });

  it('fails on an ok:false body even when the HTTP status is 200', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ ok: false, error: 'model refused', results: [] }));

    await expect(fetchAndCacheTranslations('French', [bullet('One')], makeCache())).rejects.toThrow(
      'model refused',
    );
  });

  it('falls back to the status text when the body carries no error', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({ ok: false, results: [] }, { ok: false, status: 500, statusText: 'Internal Server Error' }),
    );

    await expect(fetchAndCacheTranslations('French', [bullet('One')], makeCache())).rejects.toThrow(
      'Translation error (500): Internal Server Error',
    );
  });

  it('reports a non-JSON failure rather than throwing a parse error', async () => {
    // A proxy or a crashed server returns HTML; the editor should see the status, not
    // "Unexpected token < in JSON".
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as unknown as Response);

    await expect(fetchAndCacheTranslations('French', [bullet('One')], makeCache())).rejects.toThrow(
      'Translation error (502): Bad Gateway',
    );
  });

  it('leaves the cache untouched when the request fails', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({ ok: false, error: 'nope', results: [] }, { ok: false, status: 500 }),
    );

    const cache = makeCache();
    await expect(fetchAndCacheTranslations('French', [bullet('One')], cache)).rejects.toThrow();
    expect(cache.map.size).toBe(0);
  });
});
