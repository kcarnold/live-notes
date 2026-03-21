import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

export const isEditorAtom = atom(false);
export const fontSizeAtom = atomWithStorage('fontSize', 20);
export const languages = ["French", "Haitian Creole", "Spanish"] as const;
export const languageAtom = atom<string>("French");
