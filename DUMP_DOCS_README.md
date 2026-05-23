# Document Dumper Script

This script dumps all Y-Sweet document data to JSON files.

## Usage

```bash
# Install dependencies first
npm install

# Make sure .env has YSWEET_CONNECTION_STRING
# Then run the script:
node dump-docs.ts [output-dir]

# Default output directory is ./doc-dumps
```

## What It Does

1. Generates all document IDs from `doc-2025-11-30` (earliest commit) to today
2. Connects to each document via Y-Sweet WebSocket
3. Extracts all Yjs data structures:
   - **transcription**: Speech transcription from Web Speech API
     - `plainText`: Extracted plain text
     - `structure`: Full XML structure
   - **sourceTextProseMirror**: Rich text from ProseMirror editor
     - `plainText`: Extracted plain text
     - `structure`: Full XML structure
   - **sourceTextBlocks**: Block editor content
     - `plainText`: Formatted as markdown-like text
     - `blocks`: Full block array with metadata
   - **translatedTexts**: Translations for each language (French, Spanish, etc.)
   - **meta**: Metadata (video settings, etc.)
   - **notesTranslationCache**: Translation cache
   - **proclaimServiceItems**: Proclaim presentation data
   - **proclaimStatus**: Current Proclaim slide status

4. Saves two types of files:
   - Individual files: `doc-dumps/doc-YYYY-MM-DD.json`
   - Combined file: `doc-dumps/all-docs.json`

## Output Format

Each document JSON contains:

```json
{
  "docId": "doc-2025-12-01",
  "timestamp": "2026-02-07T12:34:56.789Z",
  "transcription": {
    "plainText": "This is the transcribed text...",
    "structure": [...]
  },
  "sourceTextProseMirror": {
    "plainText": "This is the source document...",
    "structure": [...]
  },
  "translatedTexts": {
    "French": "Translated text in French...",
    "Spanish": "Translated text in Spanish..."
  }
}
```

## Notes

- Documents with no data are skipped
- Connection timeout is 10 seconds
- Sync timeout is 5 seconds
- Small 500ms delay between documents to avoid overwhelming the server
