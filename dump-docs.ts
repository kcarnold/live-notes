#!/usr/bin/env node
/**
 * Script to dump all Y-Sweet document data
 *
 * Connects to each doc-YYYY-MM-DD from earliest commit date to today
 * and exports all Yjs data structures to JSON files.
 *
 * Usage: node dump-docs.ts [output-dir]
 */

import 'dotenv/config';
import { DocumentManager } from '@y-sweet/sdk';
import * as Y from 'yjs';
import * as fs from 'fs/promises';
import * as path from 'path';

// Get environment variable or crash
function getEnvOrCrash(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set`);
  }
  return value;
}

const documentManager = new DocumentManager(getEnvOrCrash("YSWEET_CONNECTION_STRING"));

// Generate all dates from start to today in YYYY-MM-DD format
function generateDateRange(startDate: string): string[] {
  const dates: string[] = [];
  const start = new Date(startDate);
  const today = new Date();

  // Advance start to the first Sunday on or after startDate
  const d = new Date(start);
  if (d.getDay() !== 0) {
    d.setDate(d.getDate() + (7 - d.getDay()));
  }

  for (; d <= today; d.setDate(d.getDate() + 7)) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dates.push(`${year}-${month}-${day}`);
  }

  return dates;
}

// Serialize Y.XmlFragment to a plain object
function serializeXmlFragment(fragment: Y.XmlFragment): any {
  const result: any[] = [];
  fragment.forEach((item) => {
    if (item instanceof Y.XmlElement) {
      const attributes: any = {};
      const attrs = item.getAttributes() as any;
      // Convert attributes to plain object
      if (attrs && typeof attrs.forEach === 'function') {
        attrs.forEach((value: string, key: string) => {
          attributes[key] = value;
        });
      }
      result.push({
        type: 'element',
        name: item.nodeName,
        attributes,
        children: serializeXmlFragment(item as any),
      });
    } else if (item instanceof Y.XmlText) {
      result.push({
        type: 'text',
        content: item.toString(),
      });
    }
  });
  return result;
}

// Extract plain text from XmlFragment (for transcriptions and ProseMirror)
function extractTextFromXml(fragment: Y.XmlFragment): string {
  let text = '';
  fragment.forEach((item) => {
    if (item instanceof Y.XmlElement) {
      // Recursively extract text from child elements
      text += extractTextFromXml(item as any);
      // Add newlines after block-level elements
      const blockElements = ['p', 'paragraph', 'heading', 'li', 'div'];
      if (blockElements.includes(item.nodeName)) {
        text += '\n';
      }
    } else if (item instanceof Y.XmlText) {
      text += item.toString();
    }
  });
  return text.trim();
}

// Serialize Y.Array to plain array
function serializeArray(yArray: Y.Array<any>): any[] {
  return yArray.toArray().map((item) => {
    if (item instanceof Y.Map) {
      return serializeMap(item);
    } else if (item instanceof Y.Array) {
      return serializeArray(item);
    } else if (item instanceof Y.Text) {
      return item.toString();
    } else {
      return item;
    }
  });
}

// Serialize Y.Map to plain object
function serializeMap(yMap: Y.Map<any>): Record<string, any> {
  const result: Record<string, any> = {};
  yMap.forEach((value, key) => {
    if (value instanceof Y.Map) {
      result[key] = serializeMap(value);
    } else if (value instanceof Y.Array) {
      result[key] = serializeArray(value);
    } else if (value instanceof Y.Text) {
      result[key] = value.toString();
    } else {
      result[key] = value;
    }
  });
  return result;
}

// Dump a single document
async function dumpDocument(docId: string): Promise<any> {
  console.log(`Fetching document: ${docId}...`);

  try {
    // Fetch document as a Yjs update (no WebSocket needed)
    const update = await documentManager.getDocAsUpdate(docId);

    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, update);
    console.log(`Loaded ${docId}`);

    // Extract all data structures
    const data: any = {
      docId,
      timestamp: new Date().toISOString(),
    };

    // transcriptDoc (XmlFragment) - speech transcription
    const transcriptDoc = ydoc.getXmlFragment('transcriptDoc');
    if (transcriptDoc.length > 0) {
      data.transcription = {
        plainText: extractTextFromXml(transcriptDoc),
        structure: serializeXmlFragment(transcriptDoc),
      };
    }

    // prosemirror (XmlFragment) - rich text editor content
    const prosemirror = ydoc.getXmlFragment('prosemirror');
    if (prosemirror.length > 0) {
      data.sourceTextProseMirror = {
        plainText: extractTextFromXml(prosemirror),
        structure: serializeXmlFragment(prosemirror),
      };
    }

    // sourceBlocks (Array) - block editor content
    const sourceBlocks = ydoc.getArray('sourceBlocks');
    if (sourceBlocks.length > 0) {
      const blocks = serializeArray(sourceBlocks);
      // Extract plain text from blocks
      const plainText = blocks
        .map((block: any) => {
          if (block && block.text) {
            const indent = '  '.repeat(block.indent || 0);
            const prefix = block.type === 'heading' ? '# ' : '';
            return indent + prefix + block.text;
          }
          return '';
        })
        .filter((line: string) => line.trim().length > 0)
        .join('\n');

      data.sourceTextBlocks = {
        plainText,
        blocks,
      };
    }

    // Find all translatedText-* keys
    const translatedTexts: Record<string, string> = {};
    // Common languages to check
    const languages = ['French', 'Spanish', 'Haitian', 'English'];
    for (const lang of languages) {
      const key = `translatedText-${lang}`;
      const yText = ydoc.getText(key);
      const text = yText.toString();
      if (text.length > 0) {
        translatedTexts[lang] = text;
      }
    }
    if (Object.keys(translatedTexts).length > 0) {
      data.translatedTexts = translatedTexts;
    }

    // meta (Map)
    const meta = ydoc.getMap('meta');
    if (meta.size > 0) {
      data.meta = serializeMap(meta);
    }

    // notesTranslationCache (Map)
    const notesTranslationCache = ydoc.getMap('notesTranslationCache');
    if (notesTranslationCache.size > 0) {
      data.notesTranslationCache = serializeMap(notesTranslationCache);
    }

    // proclaimPresentations (Map)
    const proclaimPresentations = ydoc.getMap('proclaimPresentations');
    if (proclaimPresentations.size > 0) {
      data.proclaimPresentations = serializeMap(proclaimPresentations);
    }

    // proclaimStatus (Map)
    const proclaimStatus = ydoc.getMap('proclaimStatus');
    if (proclaimStatus.size > 0) {
      data.proclaimStatus = serializeMap(proclaimStatus);
    }

    // Check if document has any actual data
    const hasData = Object.keys(data).length > 2; // More than docId and timestamp

    return hasData ? data : null;

  } catch (error: any) {
    console.error(`Error dumping ${docId}:`, error.message);
    return null;
  }
}

// Main function
async function main() {
  const outputDir = process.argv[2] || './doc-dumps';

  console.log(`Output directory: ${outputDir}`);
  await fs.mkdir(outputDir, { recursive: true });

  // Generate date range from earliest commit to today
  const EARLIEST_DATE = '2025-11-30';
  const dates = generateDateRange(EARLIEST_DATE);

  // Early documents were just `doc1`, `doc2`, up to `doc15`, then switched to date-based naming. Handle both patterns.
  const docIds = [
    ...Array.from({ length: 15 }, (_, i) => `doc${i + 1}`),
    ...dates.map(date => `doc-${date}`)
  ];

  console.log(`Dumping ${docIds.length} documents from ${EARLIEST_DATE} to today...`);

  // Dump each document
  const results: any[] = [];
  for (const docId of docIds) {
    const data = await dumpDocument(docId);

    if (data) {
      // Save individual file
      const filename = path.join(outputDir, `${docId}.json`);
      await fs.writeFile(filename, JSON.stringify(data, null, 2));
      console.log(`Saved: ${filename}`);
      results.push(data);
    } else {
      console.log(`Skipped ${docId} (no data)`);
    }

    // Small delay to avoid overwhelming the server
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Save combined file
  const combinedFile = path.join(outputDir, 'all-docs.json');
  await fs.writeFile(combinedFile, JSON.stringify(results, null, 2));
  console.log(`\nSaved combined file: ${combinedFile}`);
  console.log(`Total documents with data: ${results.length}`);
}

main().catch(console.error);
