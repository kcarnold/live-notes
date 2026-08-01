import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

/**
 * Whether this device may edit. Set optimistically from the `#editor` hash, then
 * corrected to false if the server declines to issue a full token (no valid write key),
 * so every `isEditor`-gated control degrades to the viewer experience on its own.
 */
export const isEditorAtom = atom(false);

/**
 * True when this device *asked* to edit and was refused. Distinct from `!isEditor`,
 * which is also the ordinary state of a plain viewer: only this warrants telling
 * someone their device needs a key.
 */
export const editorDeniedAtom = atom(false);
export const fontSizeAtom = atomWithStorage('fontSize', 20);
export const languages = ["French", "Haitian Creole", "Spanish"] as const;
export const languageAtom = atom<string>("French");
