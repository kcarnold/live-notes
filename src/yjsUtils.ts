import { useEffect, useState } from 'react';
import diff from 'fast-diff';
import { useText } from '@y-sweet/react';
import * as Y from 'yjs';

// Hook based on implementation here https://discuss.yjs.dev/t/plain-text-input-component-with-y-text/2358/2
export const useAsPlainText = (name: string): [string, (newText: string) => void] => {
  const sharedText = useText(name);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const [text, setText] = useState(() => sharedText.toString());
  
  // Reset text state when name changes
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    setText(sharedText.toString());
  }, [sharedText, name]);

  useEffect(() => {
    const observer = () => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      setText(sharedText.toString());
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

/**
 * Hook to observe a Yjs array and get a version number that increments on changes
 * Returns [array, version] where version increments whenever the array changes
 */
export const useYjsArray = <T>(yArray: Y.Array<T>): [Y.Array<T>, number] => {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const observer = () => {
      setVersion(v => v + 1);
    };

    yArray.observeDeep(observer);
    return () => {
      yArray.unobserveDeep(observer);
    };
  }, [yArray]);

  return [yArray, version];
};


export function setYTextFromString(yText: Y.Text, text: string) {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const currentText = yText.toString();
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
