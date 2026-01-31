
export function findContiguousBlocks(arr: any[]) {
    const blocks = [];
    let start = -1;

    for (let i = 0; i < arr.length; i++) {
        // If we find a truthy value and we're not already in a block, mark the start
        if (arr[i] && start === -1) {
            start = i;
        }

        // If we find a falsy value and we were in a block, or we're at the end of the array and in a block
        if ((!arr[i] || i === arr.length - 1) && start !== -1) {
            // If we're at the end of the array and the last element is truthy, we need to include it
            const end = arr[i] ? i : i - 1;
            blocks.push([start, end]);
            start = -1; // Reset start to indicate we're not in a block
        }
    }

    return blocks;
}

export interface DecomposedChunk {
    format: string;
    content: string;
    trailingWhitespace: string;
};

export function decompose(chunk: string): DecomposedChunk {
    const content = chunk.trimEnd();
    const trailingWhitespace = chunk.slice(content.length);
    // formatting content is: leading whitespace, -, *, or # / ## / ...
    // content is: everything else
    const splits = /^([\s\d\-\*\#\.]*)(.*)$/.exec(content);
    if (splits) {
        return { format: splits[1], content: splits[2], trailingWhitespace };
    } else {
        console.warn('Failed to decompose chunk:', chunk);
        return { format: '', content: content, trailingWhitespace };
    }
}


export interface TranslationTodo {
    chunks: string[]; // the "content" part of the chunk; the formatting part is added back later
    offset: number;
    isTranslationNeeded: boolean[];
    translatedContext: string;
}


export function getDecomposedChunks(text: string) {
    // Split the input into chunks (for first pass, just do by line)
    let chunks = text.split('\n');

    // Whitespace is annoying, so consolidate any whitespace-only chunk into the previous chunk.
    chunks = chunks.reduce((acc: string[], chunk: string) => {
        if (acc.length === 0) {
            // First chunk, just add it
            acc.push(chunk);
            return acc;
        }
        if (chunk.trim() === '') {
            acc[acc.length - 1] += '\n' + chunk;
        }
        else {
            // It's possible that the first chunk was whitespace-only.
            // In that case, we need to add it to the previous chunk.
            if (acc[acc.length - 1].trim() === '') {
                acc[acc.length - 1] += '\n' + chunk;
            } else {
                // Otherwise, just add it as a new chunk
                acc.push(chunk);
            }
        }
        return acc;
    }, []);

    // Assert that all chunks are non-empty
    for (const chunk of chunks) {
        if (chunk.trim() === '') {
            console.error('Empty chunk found:', chunk);
        }
    }

    // Decompose chunks into formatting and content sections
    const decomposedChunks = chunks.map(decompose);
    return decomposedChunks;
}

// We need a type that is a map of string to string. The translation cache is actually a YMap, which has a slightly different
// type signature, but we don't want to lose the type information entirely, so we use this type to represent it.
export interface TranslationCache {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    has(key: string): boolean;
}

export interface GenericMap {
    get(key: string): any;
    set(key: string, value: any): void;
    has(key: string): boolean;
}

export function translationCacheKey(language: string, chunkText: string) {
    // The translation cache key is a combination of the language and the chunk text.
    // This is to avoid collisions between different languages.
    return `${language}:${chunkText}`;
}

export function getTranslationTodos(language: string, decomposedChunks: DecomposedChunk[], translationCache: TranslationCache) {
    // Make an array where each entry is:
    // 0: don't include
    // 1: need to translate
    // 2: included only for context
    // The keys of the translation cache are always the trimmed chunks.
    const chunkStatus = decomposedChunks.map((chunk) => {
        return (chunk.content === "" || translationCache.has(translationCacheKey(language, chunk.content))) ? 0 : 1;
    });

    // Mark a few lines before each "need to translate" chunk as "context"
    for (let i = 0; i < chunkStatus.length; i++) {
        if (chunkStatus[i] === 1) {
            // Mark the previous few lines as context
            for (let j = 1; j <= 3; j++) {
                if (i - j >= 0 && chunkStatus[i - j] === 0) {
                    // @ts-ignore
                    chunkStatus[i - j] = 2;
                }
            }
        }
    }

    // Create contiguous blocks of text to translate
    const translationTodoBlocks = findContiguousBlocks(chunkStatus);

    // Now make a to-do list for all translations to request. Translations will get requested in blocks, where
    // each block is a contiguous range of chunks that need to be translated.

    const translationTodos: TranslationTodo[] = [];
    for (const block of translationTodoBlocks) {
        const [start, end] = block;
        const chunksInContext = decomposedChunks.slice(start, end + 1);
        const statusesInContext = chunkStatus.slice(start, end + 1);
        const translatedContext = chunksInContext.map((chunk) => {
            const key = translationCacheKey(language, chunk.content);
            const cachedTranslation = translationCache.get(key);
            if (cachedTranslation) {
                return chunk.format + cachedTranslation + chunk.trailingWhitespace;
            }
            return '';
        }).join('\n');
        const isTranslationNeeded = statusesInContext.map(x => x === 1);
        translationTodos.push({
            chunks: chunksInContext.map((chunk) => chunk.content),
            offset: start,
            isTranslationNeeded,
            translatedContext,
        });
    }
    return translationTodos;

}

export function updateTranslationCache(serverResponse: any, translationCache: TranslationCache) {
    // For each block, the server gave us a list of updated chunks, which we can use to update the translation cache.
    const translationResults = serverResponse.results as { sourceText: string; translatedText: string; language: string}[][];
    for (const block of translationResults) {
    for (const result of block) {
        const { sourceText, translatedText, language } = result;
        // There shouldn't be anything to trim, but just in case, trim the source and translated text.
        const trimmedSourceText = sourceText.trim();
        const trimmedTranslatedText = translatedText.trim();
        if (sourceText !== trimmedSourceText) {
        console.warn('Source text was trimmed:', [sourceText, trimmedSourceText]);
        }
        if (translatedText !== trimmedTranslatedText) {
        console.warn('Translated text was trimmed:', [translatedText, trimmedTranslatedText]);
        }
        // Update the translation cache with the new translation
        translationCache.set(translationCacheKey(language, trimmedSourceText), trimmedTranslatedText);
    }
    }
}

export function constructTranslatedText(language: string, decomposedChunks: DecomposedChunk[], translationCache: TranslationCache) {
    const translatedText = decomposedChunks.map((chunk) => {
        const key = translationCacheKey(language, chunk.content);
      const cachedTranslation = translationCache.get(key);
      let content: string;
      if (cachedTranslation) {
        content = cachedTranslation;
      } else {
        if (chunk.content.trim() !== '')
          // It's ok if we ended up with an empty chunk.
          console.warn('No cached translation for', key);
        // Fallback to the original content
        content = chunk.content;
      }
      return chunk.format + content + chunk.trailingWhitespace;
    }).join('\n');
    return translatedText;
}

export async function getUpdatedTranslation(language: string, translationCache: TranslationCache, text: string) {
    const decomposedChunks = getDecomposedChunks(text);
    const translationTodos = getTranslationTodos(language, decomposedChunks, translationCache as GenericMap as TranslationCache);

    if (translationTodos.length > 0) {
    const response = await fetch('/api/requestTranslatedBlocks', {
        method: 'POST',
        headers: {
        'Content-Type': 'application/json',
        },
        body: JSON.stringify({
        translationTodos,
        language: language,
        }),
    });

    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
        // If we have a JSON result with error details, include them in the error message
        if (result?.error) {
        throw new Error(`Translation error (${response.status}): ${result.error}`);
        } else {
        throw new Error(`Translation error (${response.status}): ${response.statusText}`);
        }
    }
    updateTranslationCache(result, translationCache);
    }
    const translatedText = constructTranslatedText(language, decomposedChunks, translationCache as GenericMap as TranslationCache);
    return translatedText;
}

export const translatedTextKeyForLanguage = (language: string) => `translatedText-${language}`;

// ============================================================================
// Block-based translation (no markdown serialization round-trip)
// ============================================================================

export interface TranslationBlock {
    type: 'heading' | 'bullet';
    level: number;
    content: string;
}

/**
 * Get translation todos from blocks, checking cache for each.
 * Returns parallel arrays of content strings and whether translation is needed.
 */
export function getBlockTranslationTodos(
    language: string,
    blocks: TranslationBlock[],
    translationCache: TranslationCache
): { contents: string[]; isTranslationNeeded: boolean[] } {
    const contents: string[] = [];
    const isTranslationNeeded: boolean[] = [];

    for (const block of blocks) {
        const trimmed = block.content.trim();
        if (trimmed === '') continue;

        contents.push(trimmed);
        const cacheKey = translationCacheKey(language, trimmed);
        isTranslationNeeded.push(!translationCache.has(cacheKey));
    }

    return { contents, isTranslationNeeded };
}

/**
 * Build translation todos with context from cached translations.
 * Groups contiguous untranslated blocks and adds context lines before each group.
 */
export function buildBlockTranslationRequests(
    language: string,
    blocks: TranslationBlock[],
    translationCache: TranslationCache
): TranslationTodo[] {
    // Filter to non-empty blocks and get their status
    const nonEmptyBlocks = blocks.filter(b => b.content.trim() !== '');
    const chunkStatus = nonEmptyBlocks.map((block) => {
        const trimmed = block.content.trim();
        return translationCache.has(translationCacheKey(language, trimmed)) ? 0 : 1;
    });

    // Mark context lines (3 lines before each untranslated block)
    for (let i = 0; i < chunkStatus.length; i++) {
        if (chunkStatus[i] === 1) {
            for (let j = 1; j <= 3; j++) {
                if (i - j >= 0 && chunkStatus[i - j] === 0) {
                    chunkStatus[i - j] = 2; // context
                }
            }
        }
    }

    // Find contiguous blocks
    const contiguousBlocks = findContiguousBlocks(chunkStatus);

    // Build translation todos
    const translationTodos: TranslationTodo[] = [];
    for (const [start, end] of contiguousBlocks) {
        const blocksInContext = nonEmptyBlocks.slice(start, end + 1);
        const statusesInContext = chunkStatus.slice(start, end + 1);

        // Build context string from cached translations
        const translatedContext = blocksInContext.map((block) => {
            const trimmed = block.content.trim();
            const cached = translationCache.get(translationCacheKey(language, trimmed));
            if (cached) {
                return blockToMarkdownLine(block.type, block.level, cached);
            }
            return '';
        }).join('\n');

        translationTodos.push({
            chunks: blocksInContext.map(b => b.content.trim()),
            offset: start,
            isTranslationNeeded: statusesInContext.map(x => x === 1),
            translatedContext,
        });
    }

    return translationTodos;
}

/**
 * Convert block type/level to markdown line prefix + content.
 */
function blockToMarkdownLine(type: 'heading' | 'bullet', level: number, content: string): string {
    if (type === 'heading') {
        const hashes = '#'.repeat(Math.min(level + 2, 6));
        return `${hashes} ${content}`;
    } else {
        const indent = '  '.repeat(level);
        return `${indent}- ${content}`;
    }
}

/**
 * Reconstruct markdown from blocks using cached translations.
 */
export function constructMarkdownFromBlocks(
    language: string,
    blocks: TranslationBlock[],
    translationCache: TranslationCache
): string {
    return blocks
        .filter(block => block.content.trim() !== '')
        .map(block => {
            const trimmed = block.content.trim();
            const cacheKey = translationCacheKey(language, trimmed);
            const translation = translationCache.get(cacheKey) ?? trimmed;
            return blockToMarkdownLine(block.type, block.level, translation);
        })
        .join('\n');
}

/**
 * Main entry point: translate blocks and return markdown string.
 */
export async function getUpdatedTranslationFromBlocks(
    language: string,
    blocks: TranslationBlock[],
    translationCache: TranslationCache
): Promise<string> {
    const translationTodos = buildBlockTranslationRequests(language, blocks, translationCache);

    if (translationTodos.length > 0) {
        const response = await fetch('/api/requestTranslatedBlocks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ translationTodos, language }),
        });

        const result = await response.json().catch(() => null);
        if (!response.ok || !result?.ok) {
            if (result?.error) {
                throw new Error(`Translation error (${response.status}): ${result.error}`);
            } else {
                throw new Error(`Translation error (${response.status}): ${response.statusText}`);
            }
        }
        updateTranslationCache(result, translationCache);
    }

    return constructMarkdownFromBlocks(language, blocks, translationCache);
}
