
import { apiFetch } from './writeKey.ts';

export function findContiguousBlocks(arr: unknown[]) {
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


export interface TranslationTodo {
    chunks: string[]; // the "content" part of the chunk; the formatting part is added back later
    offset: number;
    isTranslationNeeded: boolean[];
    translatedContext: string;
}

// We need a type that is a map of string to string. The translation cache is actually a YMap, which has a slightly different
// type signature, but we don't want to lose the type information entirely, so we use this type to represent it.
export interface TranslationCache {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    has(key: string): boolean;
}

type ChunkStatus = 0 | 1 | 2; // 0: skip, 1: translate, 2: context

export function translationCacheKey(language: string, chunkText: string) {
    // The translation cache key is a combination of the language and the chunk text.
    // This is to avoid collisions between different languages.
    return `${language}:${chunkText}`;
}

interface TranslationApiResult {
    sourceText: string;
    translatedText: string;
    language: string;
}

export interface TranslationApiResponse {
    ok: boolean;
    error?: string;
    results: TranslationApiResult[][];
}

export function updateTranslationCache(serverResponse: TranslationApiResponse, translationCache: TranslationCache) {
    // For each block, the server gave us a list of updated chunks, which we can use to update the translation cache.
    for (const block of serverResponse.results) {
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
    }) as ChunkStatus[];

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
 * Main entry point: translate blocks. Stores results in cache.
 */
export async function fetchAndCacheTranslations(
    language: string,
    blocks: TranslationBlock[],
    translationCache: TranslationCache
): Promise<void> {
    const translationTodos = buildBlockTranslationRequests(language, blocks, translationCache);

    if (translationTodos.length > 0) {
        const response = await apiFetch('/api/requestTranslatedBlocks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ translationTodos, language }),
        });

        const result = await response.json().catch(() => null) as TranslationApiResponse | null;
        if (!response.ok || !result?.ok) {
            if (result?.error) {
                throw new Error(`Translation error (${response.status}): ${result.error}`);
            } else {
                throw new Error(`Translation error (${response.status}): ${response.statusText}`);
            }
        }
        updateTranslationCache(result, translationCache);
    }
}
