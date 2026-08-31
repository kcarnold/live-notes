// useNoteSynthesizer: the editor-side driver for AI note synthesis.
//
// While enabled (Suggest mode), it watches the live English transcript
// (`liveTranscript-en`) and, on a rolling cadence, sends the not-yet-summarized transcript
// slice plus the current outline to `/api/synthesizeNotes`. The server keeps one continuous
// conversation per session and returns proposed blocks, which we append to `sourceBlocks` as
// `proposed`/`ai` for the editor to accept, edit, or reject. Whether there's "enough to note"
// is the model's call — a turn may return nothing — so our trigger is just a cadence.
//
// The transcript cursor lives in a shared `noteSynthState` Y.Map (`consumedChars`) so it
// survives reconnects. Single-driver assumption: two editor tabs in Suggest mode could
// double-drive (see plan's known limitations).
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import {
  type BlockYMap,
  createBlock,
  yMapToBlock,
  compareBlockPositions,
  addBlockToYArray,
} from './blockTypes';
import { useAsPlainText } from './yjsUtils';
import { getDocId } from './getDocId';

/** A block the model proposed, as returned by `/api/synthesizeNotes`. */
export interface ProposedBlockDraft {
  type: 'heading' | 'bullet';
  level: number;
  content: string;
}

export type SynthStatus = 'idle' | 'listening' | 'thinking' | 'error';

/** How often the cadence is evaluated. */
const TICK_MS = 4000;
/** Enough new transcript (chars) to warrant asking the model, absent a sentence break. */
const MIN_NEW_CHARS = 140;
/** With a completed-sentence break present, this much new text is enough. */
const MIN_SENTENCE_CHARS = 40;
/** Minimum spacing between model turns, so we batch rather than fire on every delta. */
const MIN_INTERVAL_MS = 12000;

/** The transcript tail not yet sent to the model. */
export function pendingTranscript(transcript: string, consumedChars: number): string {
  return transcript.slice(Math.min(Math.max(0, consumedChars), transcript.length));
}

/**
 * Cadence predicate: is it worth spending a model turn now? True when enough new transcript
 * has accumulated (or a completed sentence is pending) AND the minimum interval has elapsed.
 * The model still decides whether the material deserves a block.
 */
export function hasEnoughToSynthesize(
  pending: string,
  lastRunAt: number,
  now: number,
  {
    minChars = MIN_NEW_CHARS,
    minSentenceChars = MIN_SENTENCE_CHARS,
    minIntervalMs = MIN_INTERVAL_MS,
  }: { minChars?: number; minSentenceChars?: number; minIntervalMs?: number } = {}
): boolean {
  if (now - lastRunAt < minIntervalMs) return false;
  const trimmed = pending.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length >= minChars) return true;
  // The transcript writer starts a new paragraph after a finished sentence.
  return pending.includes('\n\n') && trimmed.length >= minSentenceChars;
}

/** Snapshot the outline for the model: non-empty blocks with their review status. */
function buildOutlineSnapshot(sourceBlocks: Y.Array<BlockYMap>, maxBlocks = 60) {
  const blocks = sourceBlocks
    .toArray()
    .map((yMap) => yMapToBlock(yMap))
    .sort(compareBlockPositions)
    .filter((b) => b.content.trim() !== '');
  return blocks.slice(-maxBlocks).map((b) => ({
    type: b.type,
    level: b.level,
    content: b.content,
    status: b.status,
  }));
}

/** Append proposed blocks to the end of the outline as `proposed`/`ai`, in one transaction. */
function appendProposedBlocks(sourceBlocks: Y.Array<BlockYMap>, drafts: ProposedBlockDraft[]) {
  if (drafts.length === 0) return;
  const sorted = sourceBlocks
    .toArray()
    .map((yMap) => yMapToBlock(yMap))
    .sort(compareBlockPositions);
  let prevPos = sorted.length > 0 ? sorted[sorted.length - 1].position : null;

  const doAppend = () => {
    for (const draft of drafts) {
      const position = generateKeyBetween(prevPos, null);
      prevPos = position;
      addBlockToYArray(
        sourceBlocks,
        createBlock(draft.content, draft.type, draft.level, position, 'proposed', 'ai')
      );
    }
  };
  if (sourceBlocks.doc) sourceBlocks.doc.transact(doAppend);
  else doAppend();
}

export function useNoteSynthesizer({
  sourceBlocks,
  synthState,
  enabled,
}: {
  sourceBlocks: Y.Array<BlockYMap>;
  synthState: Y.Map<number>;
  enabled: boolean;
}): { status: SynthStatus } {
  const [transcript] = useAsPlainText('liveTranscript-en');
  const [status, setStatus] = useState<SynthStatus>('idle');

  // Refs so the polling interval always reads the latest values without re-subscribing.
  const transcriptRef = useRef(transcript);
  const inFlightRef = useRef(false);
  const lastRunAtRef = useRef(0);
  const sessionId = getDocId();

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  // On (re)enable: start summarizing forward from "now" (not the backlog) and reset the
  // server-side conversation so this run begins clean.
  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus('idle');
      return;
    }
    if (synthState.get('consumedChars') === undefined) {
      synthState.set('consumedChars', transcriptRef.current.length);
    }
    setStatus('listening');
    fetch('/api/synthesizeNotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, reset: true, newTranscript: '' }),
    }).catch(() => {});
  }, [enabled, synthState, sessionId]);

  useEffect(() => {
    if (!enabled) return;

    const tick = async () => {
      if (inFlightRef.current) return;
      const currentTranscript = transcriptRef.current;
      const consumed = synthState.get('consumedChars') ?? currentTranscript.length;
      const pending = pendingTranscript(currentTranscript, consumed);
      if (!hasEnoughToSynthesize(pending, lastRunAtRef.current, Date.now())) return;

      inFlightRef.current = true;
      lastRunAtRef.current = Date.now();
      setStatus('thinking');
      const sendUpTo = currentTranscript.length; // advance the cursor to what we're sending
      try {
        const outline = buildOutlineSnapshot(sourceBlocks);
        const resp = await fetch('/api/synthesizeNotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, newTranscript: pending, outline }),
        });
        const data = (await resp.json()) as { ok?: boolean; blocks?: ProposedBlockDraft[] };
        if (data.ok && Array.isArray(data.blocks) && data.blocks.length > 0) {
          appendProposedBlocks(sourceBlocks, data.blocks);
        }
        synthState.set('consumedChars', sendUpTo);
        setStatus('listening');
      } catch (err) {
        console.error('Note synthesis turn failed:', err);
        setStatus('error');
      } finally {
        inFlightRef.current = false;
      }
    };

    const id = setInterval(() => void tick(), TICK_MS);
    return () => clearInterval(id);
  }, [enabled, sourceBlocks, synthState, sessionId]);

  return { status };
}
