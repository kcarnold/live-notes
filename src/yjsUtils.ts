import { useEffect, useState } from 'react';
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
  const [text, setText] = useState(() => yTextToString(sharedText));

  // Reset text state when name changes
  useEffect(() => {
    setText(yTextToString(sharedText));
  }, [sharedText, name]);

  useEffect(() => {
    const observer = () => {
      setText(yTextToString(sharedText));
    };

    sharedText.observe(observer);
    return () => { sharedText.unobserve(observer); };
  }, [sharedText]);

  const setPlainText = (newText: string) => {
    setYTextFromString(sharedText, newText);
    // Don't set the state here, as it will be set by the observer
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
