import {
  AuthEndpoint,
  useConnectionStatus,
  useYDoc,
  YDocProvider,
} from "@y-sweet/react";
import React, { useState } from "react";
import "./App.css";

import { useAtom } from "jotai";
import { fontSizeAtom, isEditorAtom, languages } from "./configAtoms";
import { useStrings, resolveLocale, LANGUAGE_BCP47 } from "./useLocale";
import {
  LISTEN_LANGUAGE_CODES,
  LISTEN_FAVORITES,
  LISTEN_ORIGINAL_CODE,
  DEFAULT_LISTEN_CODE,
} from "./listenLanguages";
import { LayoutDiagram } from "./LayoutDiagram";
import type { ClientToken } from "@y-sweet/sdk";
import { SourceTextTranslationManager } from "./SourceTextTranslationManager";
import { PostHogErrorBoundary } from "posthog-js/react";
import { CurrentSlideViewerContainer } from "./CurrentSlideViewer";
import { BilingualBlockViewerContainer } from "./BilingualBlockViewerContainer";
import { SlideReviewContainer } from "./SlideReviewContainer";
import { SlideTranslationViewerContainer } from "./SlideTranslationViewer";
import { StatusViewContainer } from "./StatusView";
import { PresencePublisher } from "./usePublishPresence";
import { getDocId } from "./getDocId";

// Lazy-loaded so the heavy LiveKit client SDK is only fetched when a live-audio
// pane (listen-{language} / broadcast) is actually rendered, keeping it out of
// the main bundle and isolating the feature.
const ListenViewer = React.lazy(() =>
  import("./ListenViewer").then((m) => ({ default: m.ListenViewer }))
);
const BroadcastControl = React.lazy(() =>
  import("./BroadcastControl").then((m) => ({ default: m.BroadcastControl }))
);

function ConnectionStatusWidget({
  connectionStatus,
}: {
  connectionStatus: string;
}) {
  const s = useStrings();
  if (connectionStatus === "connected") {
    return null; // Don't show anything if connected
  }
  return (
    <div
      className={`px-1 py-1 rounded-full text-xs font-medium ${
        connectionStatus === "connecting"
          ? "bg-yellow-500 text-white"
          : "bg-red-500 text-white"
      }`}
    >
      {connectionStatus === "connecting" ? s.connecting : s.disconnected}
    </div>
  );
}

// Layouts: each is an array of arrays of component keys
const availableLayouts = [
  {
    key: "slide-and-listen",
    labelKey: "layoutSlideAndListen" as const,
    layout: [
      ["slideTranslation", "listen"]
    ]
  },
  {
    key: 'slide-and-translation',
    labelKey: 'layoutSlideAndTranslation' as const,
    layout: [
      ["slideTranslation", "translatedText"]
    ]
  },
  {
    key: 'slide-and-bilingual',
    labelKey: 'layoutBilingualView' as const,
    layout: [
      ["slideTranslation", "bilingual"]
    ]
  },
];


function HomePage() {
  const s = useStrings();
  const locale = resolveLocale();
  const [selectedLang, setSelectedLang] = useState<string>(languages[0]);

  const langDisplayNames = new Intl.DisplayNames([locale], { type: 'language' });

  // The listen pane is keyed by BCP-47 code (a larger set than our text-translation
  // languages). Map the selected language to its code, falling back to the default
  // listen language if Gemini Live doesn't support it (e.g. Haitian Creole).
  const listenCode =
    LISTEN_LANGUAGE_CODES.includes(LANGUAGE_BCP47[selectedLang])
      ? LANGUAGE_BCP47[selectedLang]
      : DEFAULT_LISTEN_CODE;

  // Substitute the selected language into a layout component's bare name.
  const applyLanguage = (component: string): string => {
    switch (component) {
      case 'translatedText':
      case 'bilingual':
      case 'slideTranslation':
        return `${component}-${selectedLang}`;
      case 'listen':
        return `listen-${listenCode}`;
      default:
        return component;
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-gray-100 to-gray-300 dark:from-gray-950 dark:to-gray-900 text-black dark:text-gray-200">
      <h1 className="text-2xl font-bold mb-6 mt-8">
        {s.chooseLayout}
      </h1>
      <div className="flex flex-col gap-6 w-full max-w-xl">
        <div className="bg-white/80 dark:bg-gray-800/80 rounded shadow p-4 flex items-center justify-center gap-2">
          <label htmlFor="home-language" className="font-semibold text-sm">
            {s.chooseLanguage}
          </label>
          <select
            id="home-language"
            className="px-2 py-1 rounded text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700"
            value={selectedLang}
            onChange={(e) => setSelectedLang(e.target.value)}
          >
            {languages.map((lang) => (
              <option key={lang} value={lang}>
                {langDisplayNames.of(LANGUAGE_BCP47[lang]) ?? lang}
              </option>
            ))}
          </select>
        </div>
        {availableLayouts.map((layout) => {
          // Convert layout array to a layout string, substituting the selected
          // language into any language-keyed components.
          const layoutStr = layout.layout.map(row =>
            row.map(applyLanguage).join(",")
          ).join("|");
          const localeParam = locale !== 'en' ? `?locale=${locale}` : '';
          return (
            <div
              key={layout.key}
              className="bg-white/80 dark:bg-gray-800/80 rounded shadow p-4"
            >
              <div className="flex flex-col md:flex-row items-center gap-3 mb-2">
                <LayoutDiagram layout={layout.layout} />
                <a
                  href={`/${layoutStr}${localeParam}`}
                  className="px-3 py-1 rounded bg-blue-500 text-white hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700 transition text-sm shadow hover:shadow-lg"
                >
                  {s[layout.labelKey]}
                </a>
              </div>
            </div>
          );
        })}
        <div className="text-center mb-4 flex flex-col gap-2">
          <a className="underline text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300" href={`/sourceText|bilingual-${selectedLang}#editor`}>Note-Taker</a> |{" "}
          <a className="underline text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300" href={`/sourceText,broadcast|bilingual-${selectedLang}#editor`}>Broadcaster</a>
          <a className="underline text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300" href="/slideReview#editor">{s.reviewSlidesLink}</a>
          <a className="underline text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300" href="/status">{s.statusTitle}</a>
        </div>
      </div>
    </div>
  );
}

function PagePart({ componentStr, onReplace }: { componentStr: string; onReplace: (newName: string) => void }) {
  const [fontSize, setFontSize] = useAtom(fontSizeAtom);
  const ydoc = useYDoc();
  // eslint-disable-next-line react-hooks/immutability, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  (window as any).ydoc = ydoc; // Expose YDoc on window for debugging
  const s = useStrings();
  const locale = resolveLocale();

  const onLanguageChange = (prefix: string) => (newLang: string) => {
    onReplace(`${prefix}-${newLang}`);
  };

  const langDisplayNames = new Intl.DisplayNames([locale], { type: 'language' });

  const fontSizeControls = (
    <>
      <div className="flex-1" />
      <button
        type="button"
        aria-label={s.decreaseFontSize}
        onClick={() => setFontSize(Math.max(10, (fontSize || 16) - 2))}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" role="img" aria-label={s.decreaseFontSize}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={s.increaseFontSize}
        onClick={() => setFontSize(Math.min(32, (fontSize || 16) + 2))}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" role="img" aria-label={s.increaseFontSize}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
      </button>
    </>
  );

  const languageSelector = (prefix: string, language: string) => (
    <select
      className="ml-2 px-1 py-0.5 rounded text-xs bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700"
      value={language}
      onChange={(e) => onLanguageChange(prefix)(e.target.value)}
    >
      {languages.map((lang) => (
        <option key={lang} value={lang}>{langDisplayNames.of(LANGUAGE_BCP47[lang]) ?? lang}</option>
      ))}
    </select>
  );

  // The listen picker offers the full Gemini-supported language set (keyed by
  // BCP-47 code), with "Original / English" and favorites pinned on top. Names are
  // localized via Intl.DisplayNames; the long list is sorted by localized name.
  const sortedListenLangs = LISTEN_LANGUAGE_CODES
    .filter((c) => c !== LISTEN_ORIGINAL_CODE && !LISTEN_FAVORITES.includes(c))
    .sort((a, b) =>
      (langDisplayNames.of(a) ?? a).localeCompare(langDisplayNames.of(b) ?? b, locale)
    );

  const listenLanguageSelector = (language: string) => (
    <select
      className="ml-2 px-1 py-0.5 rounded text-xs bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700"
      value={language}
      onChange={(e) => onLanguageChange('listen')(e.target.value)}
    >
      <option value={LISTEN_ORIGINAL_CODE}>{s.listenOriginal}</option>
      <optgroup label={s.favorites}>
        {LISTEN_FAVORITES.map((c) => (
          <option key={c} value={c}>{langDisplayNames.of(c) ?? c}</option>
        ))}
      </optgroup>
      <optgroup label={s.allLanguages}>
        {sortedListenLangs.map((c) => (
          <option key={c} value={c}>{langDisplayNames.of(c) ?? c}</option>
        ))}
      </optgroup>
    </select>
  );

  const cardClass = "rounded-md shadow bg-gray-100/80 dark:bg-gray-800/80 p-2 mb-2 flex flex-col gap-1 transition hover:shadow-lg";

  if (componentStr === 'sourceText') {
    return (
      <div className={cardClass + " flex-1/2 overflow-auto bg-white/70 dark:bg-gray-900/70"}>
        <SourceTextTranslationManager ydoc={ydoc} />
      </div>
    );
  }

  if (componentStr === 'currentSlide') {
    return <CurrentSlideViewerContainer />;
  }

  if (componentStr === 'status') {
    return <StatusViewContainer />;
  }

  if (componentStr === 'slideReview') {
    return (
      <div className={cardClass + " flex-1 overflow-auto bg-white/70 dark:bg-gray-900/70"}>
        <SlideReviewContainer />
      </div>
    );
  }

  if (componentStr.startsWith('slideTranslation-')) {
    const language = componentStr.substring('slideTranslation-'.length);
    const validLanguage = (languages as readonly string[]).includes(language) ? language : languages[0];
    return (
      <div className={cardClass + " flex-1/2 overflow-auto"}>
        <div className="flex items-center gap-2 px-1">
          <h2 className="font-semibold text-xs text-gray-500 dark:text-gray-300 leading-tight mb-0">{s.translation}</h2>
          {languageSelector('slideTranslation', validLanguage)}
        </div>
        <SlideTranslationViewerContainer language={validLanguage} />
      </div>
    );
  }

  if (componentStr.startsWith('translatedText-')) {
    const language = componentStr.substring('translatedText-'.length);
    const validLanguage = (languages as readonly string[]).includes(language) ? language : languages[0];
    return (
      <div className={cardClass + " flex-1/2 bg-gray-100/80 dark:bg-gray-900/60 text-gray-900 dark:text-gray-100 overflow-auto"}>
        <BilingualBlockViewerContainer
          language={validLanguage}
          fontSize={fontSize}
          showOriginal={false}
          headerControls={
            <>
              <h2 className="font-semibold text-xs text-gray-500 dark:text-gray-300 leading-tight mb-0">{s.translation}</h2>
              {languageSelector('translatedText', validLanguage)}
              {fontSizeControls}
            </>
          }
        />
      </div>
    );
  }

  if (componentStr.startsWith('listen-')) {
    const language = componentStr.substring('listen-'.length);
    const validLanguage =
      language === LISTEN_ORIGINAL_CODE || LISTEN_LANGUAGE_CODES.includes(language)
        ? language
        : DEFAULT_LISTEN_CODE;
    return (
      <div className={cardClass + " flex-1/2 bg-gray-100/80 dark:bg-gray-900/60 text-gray-900 dark:text-gray-100 overflow-hidden"}>
        <div className="flex items-center">
          <h2 className="font-semibold text-xs text-gray-500 dark:text-gray-300 leading-tight mb-0">{s.listenLive}</h2>
          {listenLanguageSelector(validLanguage)}
        </div>
        <React.Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-gray-400">{s.connecting}</div>}>
          <ListenViewer key={validLanguage} language={validLanguage} />
        </React.Suspense>
      </div>
    );
  }

  if (componentStr === 'broadcast') {
    return (
      <div className={cardClass + " flex-1/2 bg-gray-100/80 dark:bg-gray-900/60 text-gray-900 dark:text-gray-100 overflow-hidden"}>
        <h2 className="font-semibold text-xs text-gray-500 dark:text-gray-300 leading-tight mb-0">{s.broadcast}</h2>
        <React.Suspense fallback={<div className="flex-1 flex items-center justify-center text-xs text-gray-400">{s.connecting}</div>}>
          <BroadcastControl />
        </React.Suspense>
      </div>
    );
  }

  if (componentStr.startsWith('bilingual-')) {
    const language = componentStr.substring('bilingual-'.length);
    const validLanguage = (languages as readonly string[]).includes(language) ? language : languages[0];
    return (
      <div className={cardClass + " flex-1/2 bg-gray-100/80 dark:bg-gray-900/60 text-gray-900 dark:text-gray-100 overflow-auto"}>
        <BilingualBlockViewerContainer
          language={validLanguage}
          fontSize={fontSize}
          headerControls={
            <>
              <h2 className="font-semibold text-xs text-gray-500 dark:text-gray-300 leading-tight mb-0">{s.bilingual}</h2>
              {languageSelector('bilingual', validLanguage)}
              {fontSizeControls}
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className={cardClass + " flex-1/2 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 items-center justify-center"}>
      <p className="text-sm">Unknown component: <code>{componentStr}</code></p>
      <a href="/" className="text-xs underline hover:text-red-900 dark:hover:text-red-100">{s.goHome}</a>
    </div>
  );
}

// Layout page: render the selected layout from URL
function LayoutPage({ layout: initialLayout }: { layout: string }) {
  const connectionStatus = useConnectionStatus();
  const s = useStrings();

  // Track current layout in state so we can update it when URL changes
  const [layout, setLayout] = useState(initialLayout);

  // Parse layout from URL: e.g. "sourceText,translatedText-French|currentSlide" => [["sourceText", "translatedText-French"], ["currentSlide"]]
  function parseLayoutString(layoutStr: string | undefined): string[][] {
    if (!layoutStr) return [];
    return layoutStr.split("|").map(row => row.split(","));
  }

  function replaceComponent(rowIdx: number, colIdx: number, newName: string) {
    const parsedLayout = parseLayoutString(layout);
    const newLayout = parsedLayout.map((row, r) =>
      row.map((component, c) => (r === rowIdx && c === colIdx) ? newName : component)
    );
    const newLayoutStr = newLayout.map(row => row.join(",")).join("|");
    const currentSearch = window.location.search;
    const currentHash = window.location.hash;
    window.history.replaceState(null, '', `/${newLayoutStr}${currentSearch}${currentHash}`);
    setLayout(newLayoutStr);
  }

  const parsedLayout = parseLayoutString(layout);

  // Render layout columns
  const columns = parsedLayout.map((col, i) => {
    if (col.length === 0) return null;
    return (
      <div
        // biome-ignore lint/suspicious/noArrayIndexKey: The array index is stable
        key={i}
        className={
          parsedLayout.length === 1
            ? "w-full h-full flex flex-col gap-2 p-2"
            : "flex flex-col w-full md:w-1/2 h-1/2 md:h-full gap-2 p-1"
        }
      >
        {col.map((componentStr, j) =>
          <PostHogErrorBoundary key={`${componentStr}-${i}-${j}`} fallback={<div>Error loading component {componentStr}</div>}>
            <PagePart
              componentStr={componentStr}
              onReplace={(newName) => replaceComponent(i, j, newName)}
            />
          </PostHogErrorBoundary>
        )}
      </div>
    );
  });

  return (
    <div className="flex flex-col md:flex-row h-dvh overflow-hidden relative touch-none bg-gradient-to-br from-gray-100 to-gray-300 dark:from-gray-950 dark:to-gray-900">
      <div className="absolute top-2 right-2 z-10 flex items-center space-x-2">
        <ConnectionStatusWidget connectionStatus={connectionStatus} />
      </div>
      <a
        href="/"
        className="fixed bottom-4 right-4 z-20 w-10 h-10 flex items-center justify-center rounded-full bg-gray-500/70 dark:bg-gray-700/80 text-white shadow-md hover:bg-gray-700/80 dark:hover:bg-gray-600/80 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-600"
        title={s.goHome}
        style={{ fontSize: '1.3rem', boxShadow: '0 2px 8px rgba(0,0,0,0.10)' }}
      >
        <span style={{ fontSize: '1.3rem', lineHeight: 1 }}>🏠</span>
      </a>
      {columns}
    </div>
  );
}

const App = () => {
  // We're an editor only if location hash includes #editor
  const isEditor = window.location.hash.includes("editor");

  // Default doc id is `doc-${today}`, overridable via ?doc=. Shared with the
  // live-audio panes via getDocId() so the LiveKit room matches the session.
  const docId = getDocId();

  const [, setIsEditor] = useAtom(isEditorAtom);
  React.useEffect(() => {
    setIsEditor(isEditor);
  }, [isEditor, setIsEditor]);
  const authEndpoint: AuthEndpoint = async () => {
    const response = await fetch("/api/ys-auth", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ docId, isEditor }),
    });
    return (await response.json()) as ClientToken;
  };

  // Parse URL path to determine which page to render
  let pageComponent: React.ReactElement;
  const pathname = decodeURIComponent(window.location.pathname);
  if (pathname === "/" || pathname === "") {
    pageComponent = <HomePage />;
  } else {
    // Remove leading slash and use as layout string
    // Note: this will be validated inside LayoutPage
    const layout = pathname.substring(1);
    // Apply backwards compat fixes: we used to call translatedText "translatedOutline"
    const fixedLayout = layout.replace(/translatedOutline/g, "translatedText");
    pageComponent = <LayoutPage layout={fixedLayout} />;
  }

  return (
    <YDocProvider docId={docId} authEndpoint={authEndpoint}>
      {/*
        Publishes this client's presence over awareness. Mounted here, above the
        page, so it runs on every layout — the status page can only list clients
        that publish, and viewers are most of who we want to see there.
      */}
      <PresencePublisher />
      {pageComponent}
    </YDocProvider>
  );
};

export default App;
