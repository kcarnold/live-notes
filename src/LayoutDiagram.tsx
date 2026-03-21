import { useStrings } from "./useLocale";

// --- LayoutDiagram helper for visualizing layouts ---
const componentColors: Record<string, string> = {
  transcript: "bg-green-300 dark:bg-green-700",
  sourceText: "bg-yellow-200 dark:bg-yellow-600",
  translatedText: "bg-purple-200 dark:bg-purple-700",
  bilingual: "bg-pink-200 dark:bg-pink-700",
  video: "bg-blue-200 dark:bg-blue-700",
  currentSlide: "bg-indigo-200 dark:bg-indigo-700",
};

export function LayoutDiagram({ layout }: { layout: string[][] }) {
  const s = useStrings();
  const humanLabels: Record<string, string> = {
    transcript: s.componentTranscript,
    sourceText: s.componentSourceText,
    translatedText: s.componentTranslatedText,
    bilingual: s.componentBilingual,
    video: s.componentVideo,
    currentSlide: s.componentCurrentSlide,
  };
  // layout is a 2D array: columns of rows
  // Find the max column height for grid alignment
  const maxRows = Math.max(...layout.map(col => col.length));
  return (
    <div className="flex border border-gray-300 dark:border-gray-700 rounded overflow-hidden mr-2" style={{ minWidth: 120 }}>
      {layout.map((col, i) => (
        <div key={i} className="flex flex-col">
          {Array.from({ length: maxRows }).map((_, j) => {
            const key = col[j];
            return key ? (
              <div
                key={key + j}
                className={`w-28 h-8 flex items-center justify-center text-sm font-bold border-b border-r border-gray-200 dark:border-gray-700 ${componentColors[key] || "bg-gray-200"}`}
                title={key}
              >
                {humanLabels[key] || key}
              </div>
            ) : (
              <div key={"empty" + j} className="w-28 h-8 border-b border-r border-gray-200 dark:border-gray-700 bg-transparent" />
            );
          })}
        </div>
      ))}
    </div>
  );
}
