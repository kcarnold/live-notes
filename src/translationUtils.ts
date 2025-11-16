// ===== Shared utility functions =====

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

// ===== Legacy markdown-based translation (deprecated) =====
// The following functions are from the old markdown-based translation system.
// They are kept for backward compatibility but new code should use block-based functions.

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

// ===== Block-based translation functions =====

export interface BlockTranslationInput {
    blockId: string;
    content: string;
    existingTranslation?: string; // Current translation if it exists
    translationSource?: string; // Source content snapshot from when translation was created
}

export interface BlockTranslationTodo {
    blocks: BlockTranslationInput[];
    isTranslationNeeded: boolean[];
    translatedContext: string;
}

/**
 * Get translation todos for blocks (without cache)
 *
 * Checks each block's existing translation to determine what needs translating.
 * Translation is needed if:
 * - Block has no translation, OR
 * - Block content has changed since translation (content !== translationSource)
 */
export function getBlockTranslationTodos(
    language: string,
    blocks: BlockTranslationInput[]
): BlockTranslationTodo[] {
    // Determine which blocks need translation
    const blockStatus = blocks.map((block) => {
        // Skip empty blocks
        if (block.content === "") return 0;

        // No translation exists = need to translate
        if (!block.existingTranslation) return 1;

        // Translation exists but no source snapshot = treat as stale (legacy data)
        // This handles old blocks from before we tracked source snapshots
        if (block.translationSource === undefined) {
            return 1;
        }

        // Translation exists but content has changed = need to re-translate
        if (block.content !== block.translationSource) {
            return 1;
        }

        // Translation exists and content hasn't changed = don't translate
        return 0;
    });

    // Mark a few lines before each "need to translate" block as "context"
    for (let i = 0; i < blockStatus.length; i++) {
        if (blockStatus[i] === 1) {
            for (let j = 1; j <= 3; j++) {
                if (i - j >= 0 && blockStatus[i - j] === 0) {
                    // @ts-ignore
                    blockStatus[i - j] = 2;
                }
            }
        }
    }

    // Create contiguous blocks of text to translate
    const translationTodoBlocks = findContiguousBlocks(blockStatus);

    const translationTodos: BlockTranslationTodo[] = [];
    for (const block of translationTodoBlocks) {
        const [start, end] = block;
        const blocksInContext = blocks.slice(start, end + 1);
        const statusesInContext = blockStatus.slice(start, end + 1);

        // Build translated context from already-translated blocks
        const translatedContext = blocksInContext.map((block) => {
            return block.existingTranslation || '';
        }).join('\n');

        const isTranslationNeeded = statusesInContext.map(x => x === 1);

        translationTodos.push({
            blocks: blocksInContext,
            isTranslationNeeded,
            translatedContext,
        });
    }

    return translationTodos;
}

/**
 * Get updated block translations (no cache needed)
 */
export async function getUpdatedBlockTranslations(
    language: string,
    blocks: BlockTranslationInput[]
): Promise<Map<string, string>> {
    const translationTodos = getBlockTranslationTodos(language, blocks);

    if (translationTodos.length === 0) {
        return new Map();
    }

    // Convert block todos to the format expected by the server
    const serverTodos = translationTodos.map(todo => ({
        chunks: todo.blocks.map(b => b.content),
        offset: 0, // Not used for block-based translation
        isTranslationNeeded: todo.isTranslationNeeded,
        translatedContext: todo.translatedContext,
    }));

    const response = await fetch('/api/requestTranslatedBlocks', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            translationTodos: serverTodos,
            language: language,
        }),
    });

    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
        if (result?.error) {
            throw new Error(`Translation error (${response.status}): ${result.error}`);
        } else {
            throw new Error(`Translation error (${response.status}): ${response.statusText}`);
        }
    }

    // Build map of blockId -> translated text from server response
    // The server returns results in the same order as our todos, so we can match by position
    const translations = new Map<string, string>();
    const translationResults = result.results as { sourceText: string; translatedText: string; language: string}[][];

    let globalBlockIndex = 0;
    for (const todoResults of translationResults) {
        for (const translationResult of todoResults) {
            // Find the next block that needs translation
            while (globalBlockIndex < blocks.length) {
                const block = blocks[globalBlockIndex];
                globalBlockIndex++;

                // Match by content to validate server response
                if (block.content === translationResult.sourceText) {
                    translations.set(block.blockId, translationResult.translatedText.trim());
                    break;
                } else {
                    // Server returned unexpected content - log warning but continue
                    console.warn('Translation mismatch:', {
                        expected: block.content,
                        got: translationResult.sourceText,
                        blockId: block.blockId
                    });
                    // Try to find matching block (handles duplicate content case)
                    const matchingBlock = blocks.find(b => b.content === translationResult.sourceText);
                    if (matchingBlock) {
                        translations.set(matchingBlock.blockId, translationResult.translatedText.trim());
                        break;
                    }
                }
            }
        }
    }

    return translations;
}
