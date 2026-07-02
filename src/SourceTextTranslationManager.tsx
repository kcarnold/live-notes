import { useAtomValue } from "jotai";
import { useCallback, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { isEditorAtom, languages } from "./configAtoms";
import { BlockEditor } from "./BlockEditor";
import { type Block, type BlockYMap, updateYMap } from "./blockTypes";
import type { TranslationBlock } from "./translationUtils";
import { useTranslationManager } from "./useTranslationManager";
import { useNoteSynthesizer, type SynthStatus } from "./useNoteSynthesizer";

// https://developer.mozilla.org/en-US/docs/Web/API/Navigator/platform#examples
const modifierKeyPrefix =
  navigator.platform.startsWith("Mac") || navigator.platform === "iPhone"
    ? "⌘" // command key
    : "^"; // control key

export function SourceTextTranslationManager({ ydoc }: { ydoc: Y.Doc }) {
  const sourceBlocksRef = useRef<TranslationBlock[]>([]);
  const isEditor = useAtomValue(isEditorAtom);
  const sourceBlocks = useMemo(() => ydoc.getArray<BlockYMap>("sourceBlocks"), [ydoc]);
  const synthState = useMemo(() => ydoc.getMap<number>("noteSynthState"), [ydoc]);
  // AI note synthesis: 'off' (manual, the default) or 'suggest' (AI proposes blocks to review).
  const [synthMode, setSynthMode] = useState<"off" | "suggest">("off");
  const [pendingCount, setPendingCount] = useState(0);
  const {
    isTranslating,
    translationError,
    doTranslations,
    doResetTranslations,
  } = useTranslationManager({
    languages,
    sourceBlocksRef,
    translationCacheName: "notesTranslationCache",
  });

  const { status: synthStatus } = useNoteSynthesizer({
    sourceBlocks,
    synthState,
    enabled: isEditor && synthMode === "suggest",
  });

  const doTranslationsSync = useCallback(() => {
    doTranslations().catch((err) => {
      console.error("Error during translation:", err);
    });
  }, [doTranslations]);

  const handleBlocksChanged = useCallback((blocks: Block[]) => {
    // Only confirmed blocks feed translation; unaccepted AI proposals must not leak.
    sourceBlocksRef.current = blocks
      .filter(b => b.status === "confirmed")
      .map(b => ({
        type: b.type,
        level: b.level,
        content: b.content,
      }));
    setPendingCount(blocks.filter(b => b.status === "proposed").length);
  }, []);

  // Accept every pending proposal at once (flip proposed -> confirmed in one transaction).
  const acceptAllProposals = useCallback(() => {
    ydoc.transact(() => {
      for (const yMap of sourceBlocks.toArray()) {
        if (yMap.get("status") === "proposed") updateYMap(yMap, { status: "confirmed" });
      }
    });
  }, [ydoc, sourceBlocks]);

  // Discard every pending proposal (delete from the end so indices stay valid).
  const clearProposals = useCallback(() => {
    ydoc.transact(() => {
      for (let i = sourceBlocks.length - 1; i >= 0; i--) {
        if (sourceBlocks.get(i).get("status") === "proposed") sourceBlocks.delete(i, 1);
      }
    });
  }, [ydoc, sourceBlocks]);

  return (
    <div className="flex flex-col gap-1 h-full">
      <h2 className="font-semibold text-xs text-gray-600 dark:text-gray-300 leading-tight">
        Original Text
      </h2>
      {isEditor ? (
        <NoteSynthToolbar
          mode={synthMode}
          onModeChange={setSynthMode}
          status={synthStatus}
          pendingCount={pendingCount}
          onAcceptAll={acceptAllProposals}
          onClear={clearProposals}
        />
      ) : null}
      <div className="flex-1 min-h-0 overflow-auto">
        <BlockEditor
          yArray={sourceBlocks}
          onBlocksChanged={isEditor ? handleBlocksChanged : undefined}
          editable={isEditor}
          onTranslationTrigger={isEditor ? doTranslationsSync : undefined}
        />
      </div>
      {isEditor ? (
        <div className="flex justify-end">
          {translationError !== "" && (
            <div className="p-2 bg-red-800 text-white rounded-md mx-2">
              <b>Translation Error</b>: {translationError}
            </div>
          )}
          <button
            className="bg-gray-600 text-white font-medium py-1 px-2 rounded hover:bg-gray-700 transition-colors mr-2"
            onClick={doResetTranslations}
          >
            Reset
          </button>
          <button
            className={`text-white font-medium py-1 px-2 rounded transition-colors ${
              isTranslating
                ? "bg-blue-400 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-700"
            }`}
            onClick={doTranslationsSync}
            disabled={isTranslating}
          >
            {isTranslating
              ? "Translating..."
              : `Translate (${modifierKeyPrefix}-Enter)`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

const SYNTH_STATUS_LABEL: Record<SynthStatus, string> = {
  idle: "",
  listening: "Listening…",
  thinking: "Drafting…",
  error: "Sync error",
};

/**
 * Editor-only controls for AI note synthesis: toggle Off/Suggest, show live status, and
 * bulk-accept or clear pending proposals.
 */
function NoteSynthToolbar({
  mode,
  onModeChange,
  status,
  pendingCount,
  onAcceptAll,
  onClear,
}: {
  mode: "off" | "suggest";
  onModeChange: (mode: "off" | "suggest") => void;
  status: SynthStatus;
  pendingCount: number;
  onAcceptAll: () => void;
  onClear: () => void;
}) {
  const on = mode === "suggest";
  return (
    <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 flex-wrap">
      <button
        type="button"
        onClick={() => onModeChange(on ? "off" : "suggest")}
        className={`font-medium py-0.5 px-2 rounded transition-colors ${
          on
            ? "bg-amber-500 text-white hover:bg-amber-600"
            : "bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600"
        }`}
        title="Let the AI suggest outline blocks from the live transcript"
      >
        {on ? "AI Notes: Suggesting" : "AI Notes: Off"}
      </button>
      {on && status !== "idle" && (
        <span className={status === "error" ? "text-red-600 dark:text-red-400" : "italic"}>
          {SYNTH_STATUS_LABEL[status]}
        </span>
      )}
      {pendingCount > 0 && (
        <>
          <span className="text-amber-600 dark:text-amber-400">
            {pendingCount} pending
          </span>
          <button
            type="button"
            onClick={onAcceptAll}
            className="py-0.5 px-2 rounded border border-green-400 text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/20"
          >
            Accept all
          </button>
          <button
            type="button"
            onClick={onClear}
            className="py-0.5 px-2 rounded border border-red-400 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            Clear
          </button>
        </>
      )}
    </div>
  );
}
