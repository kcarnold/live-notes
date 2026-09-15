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

1. Generates a document id per day from the earliest session to today
2. Connects to each document via Y-Sweet WebSocket
3. Extracts the Yjs data structures it knows about and writes one JSON file per document,
   plus a combined file, into the output directory

**The set of keys it extracts is not listed here.** Read the `ydoc.get*` calls in
`dump-docs.ts` — that list has drifted before (this file spent months describing
`sourceTextProseMirror`, `transcription` and `translatedTexts`, none of which have existed
for a long time, while the script itself was current the whole while).

Note that the dumper knows about fewer keys than the doc actually holds — it predates
`slideTranslations`, `slideConversations`, `status` and the `liveTranscriptSegments-*`
arrays. `sessionExport.ts` is the reader that tracks the doc most closely; prefer it when you
want a faithful end-state view, and treat this script as a bulk archaeology tool.

## Notes

- Documents with no data are skipped
- It connects to every day's doc in sequence, pausing between each so a bulk run doesn't
  overwhelm the server, so a full run is slow by design. Grep `dump-docs.ts` for `setTimeout`
  for the current pause.
