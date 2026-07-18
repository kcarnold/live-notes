import { useCallback, useSyncExternalStore } from 'react';
import diff from 'fast-diff';
import { useText } from '@y-sweet/react';
import * as Y from 'yjs';

// Yjs's Y.Text.d.ts doesn't declare its (working) toString() override, so TypeScript
// falls back to Object.prototype.toString and flags direct calls as unsafe. Centralize
// the disable here instead of scattering it at every call site.
export function yTextToString(yText: Y.Text): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return yText.toString();
}

// Hook based on implementation here https://discuss.yjs.dev/t/plain-text-input-component-with-y-text/2358/2
export const useAsPlainText = (name: string): [string, (newText: string) => void] => {
  const sharedText = useText(name);

  // Subscribe to the shared Y.Text as an external store. useSyncExternalStore
  // re-reads the snapshot on every change and whenever `subscribe` changes (i.e.
  // when `name` yields a different Y.Text), so no manual reset effect is needed.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      sharedText.observe(onStoreChange);
      return () => { sharedText.unobserve(onStoreChange); };
    },
    [sharedText],
  );
  const text = useSyncExternalStore(subscribe, () => yTextToString(sharedText));

  const setPlainText = (newText: string) => {
    setYTextFromString(sharedText, newText);
    // Don't set state here; the snapshot updates via the observer.
  };

  return [text, setPlainText];
};

export const usePlainTextSetter = (name: string): ((newText: string) => void) => {
  const sharedText = useText(name);
  const setPlainText = (newText: string) => {
    setYTextFromString(sharedText, newText);
  };
  return setPlainText;
};


export function setYTextFromString(yText: Y.Text, text: string) {
  const currentText = yTextToString(yText);
  if (currentText === text) return;
  const delta = diffToDelta(diff(currentText, text));
  yText.applyDelta(delta);
}

type DeltaOperation = 
  | { insert: string }
  | { delete: number }
  | { retain: number };

function diffToDelta(diffResult: diff.Diff[]): DeltaOperation[] {
  return diffResult.map(([op, value]) => {
    if (op === diff.INSERT) 
      return { insert: value };
    if (op === diff.DELETE)
      return { delete: value.length };
    if (op === diff.EQUAL)
      return { retain: value.length };
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    throw new Error(`Unknown diff operation: ${op}`);
  });
}
