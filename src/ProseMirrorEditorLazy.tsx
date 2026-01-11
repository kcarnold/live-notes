import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

const ProseMirrorEditor = lazy(() => import('./ProseMirrorEditor'));

type ProseMirrorEditorProps = ComponentProps<typeof import('./ProseMirrorEditor').default>;

export default function ProseMirrorEditorLazy(props: ProseMirrorEditorProps) {
  return (
    <Suspense fallback={<div className="p-4 text-gray-500">Loading editor...</div>}>
      <ProseMirrorEditor {...props} />
    </Suspense>
  );
}
