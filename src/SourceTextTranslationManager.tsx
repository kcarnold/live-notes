import { useAtomValue } from "jotai";
import { useCallback, useRef } from "react";
import * as Y from "yjs";
import { isEditorAtom, languages } from "./configAtoms";
import { BlockEditor } from "./BlockEditor";
import type { Block } from "./blockTypes";
import type { TranslationBlock } from "./translationUtils";
import { useTranslationManager } from "./useTranslationManager";

// https://developer.mozilla.org/en-US/docs/Web/API/Navigator/platform#examples
const modifierKeyPrefix =
  navigator.platform.startsWith("Mac") || navigator.platform === "iPhone"
    ? "⌘" // command key
    : "^"; // control key

export function SourceTextTranslationManager({ ydoc }: { ydoc: Y.Doc }) {
  const sourceBlocksRef = useRef<TranslationBlock[]>([]);
  const isEditor = useAtomValue(isEditorAtom);
  const sourceBlocks = ydoc.getArray<Y.Map<string | number>>("sourceBlocks");
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

  const doTranslationsSync = useCallback(() => {
    doTranslations().catch((err) => {
      console.error("Error during translation:", err);
    });
  }, [doTranslations]);

  const handleBlocksChanged = useCallback((blocks: Block[]) => {
    sourceBlocksRef.current = blocks.map(b => ({
      type: b.type,
      level: b.level,
      content: b.content,
    }));
  }, []);

  return (
    <div className="flex flex-col gap-1 h-full">
      <h2 className="font-semibold text-xs text-gray-600 dark:text-gray-300 leading-tight">
        Original Text
      </h2>
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
