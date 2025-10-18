import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import * as production from 'react/jsx-runtime'; // Required by rehype-react
import { useScrollToBottom } from './reactUtils';
import { useAsPlainText } from './yjsUtils';
import { remarkEmphasizeNewNodes } from './remarkEmphasizeNewNodes';
import { rehypeAddClickableBlocks } from './rehypeAddClickableBlocks';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeReact from 'rehype-react';
import { translatedTextKeyForLanguage } from './translationUtils';

const prefetchEnabled = false; // Disable prefetching for now, as it causes too many TTS requests

interface TranslatedTextViewerProps {
  language: string;
  fontSize?: number;
}

// HACK: Global loading flag to prevent multiple simultaneous TTS requests
let loading = false;

const TranslatedTextViewer: React.FC<TranslatedTextViewerProps> = ({ language, fontSize }) => {
  const yJsKey = translatedTextKeyForLanguage(language);
  const [translatedText] = useAsPlainText(yJsKey);
  // Use a ref to avoid infinite update loop
  const prevTextHashesRef = useRef<Set<string>>(new Set());
  const translatedTextEndRef = useRef<HTMLDivElement | null>(null);

  const isTTSEnabled = language === 'French' || language === 'Spanish';

  // TTS state
  const [playingBlockKey, setPlayingBlockKey] = useState<string | null>(null);
  const [allBlockTexts, setAllBlockTexts] = useState<string[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prefetchedAudioRef = useRef<Set<string>>(new Set());

  useScrollToBottom(translatedTextEndRef, [translatedText], true);

  // TTS: Fetch audio for a given text
  const fetchAudio = useCallback(async (text: string): Promise<string | null> => {
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language }),
      });

      if (!response.ok) {
        console.error('TTS request failed:', response.statusText);
        return null;
      }

      const data = await response.json();
      return data.audioUrl;
    } catch (error) {
      console.error('TTS fetch error:', error);
      return null;
    }
  }, [language]);

  // TTS: Play audio for a block
  const playBlock = useCallback(async (text: string) => {
    // Stop any currently playing audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    if (loading) {
      return; // Prevent multiple simultaneous requests
    }
    loading = true;

    // Find the block element and add loading class immediately
    const blockElement = document.querySelector(`[data-block-text="${CSS.escape(text)}"]`);
    if (blockElement) {
      blockElement.classList.add('loading');
    }

    const audioUrl = await fetchAudio(text);
    loading = false;
    if (!audioUrl) {
      // Remove loading class on error
      if (blockElement) {
        blockElement.classList.remove('loading');
      }
      return;
    }

    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    audio.onended = () => {
      setPlayingBlockKey(null);
      audioRef.current = null;
      // Remove loading class when done
      if (blockElement) {
        blockElement.classList.remove('loading');
      }
    };

    audio.onerror = () => {
      console.error('Audio playback error');
      setPlayingBlockKey(null);
      audioRef.current = null;
      // Remove loading class on error
      if (blockElement) {
        blockElement.classList.remove('loading');
      }
    };

    // Remove loading class and set playing state when audio starts
    if (blockElement) {
      blockElement.classList.remove('loading');
    }
    setPlayingBlockKey(text);

    await audio.play();
  }, [fetchAudio]);

  // TTS: Handle block click
  const handleBlockClick = useCallback((text: string, _element: HTMLElement) => {
    playBlock(text);
  }, [playBlock]);

  // Only process once: update prevTextHashes after renderedTree is created
  const renderedTree = useMemo(() => {
    const currentTextHashes = new Set<string>();
    const blockTexts: string[] = [];

    if (translatedText.length === 0) {
      return { tree: <div className="text-gray-500 italic">No translated text available</div>, currentTextHashes, blockTexts };
    }

    const processor = unified()
      .use(remarkParse)
      .use(remarkEmphasizeNewNodes, { prevTextHashes: prevTextHashesRef.current, currentTextHashes })
      .use(remarkRehype);

    // Add clickable blocks plugin only if TTS is enabled
    if (isTTSEnabled) {
      processor.use(rehypeAddClickableBlocks, {
        onBlockClick: handleBlockClick,
        playingBlockKey,
        blockTexts, // Collect block texts during processing
      });
    }

    const tree = processor
      .use(rehypeReact, production)
      .processSync(translatedText).result as React.ReactNode;

    return { tree, currentTextHashes, blockTexts };
  }, [translatedText, isTTSEnabled, handleBlockClick, playingBlockKey]);

  useEffect(() => {
    prevTextHashesRef.current = renderedTree.currentTextHashes;
    setAllBlockTexts(renderedTree.blockTexts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderedTree]);

  // Prefetch audio for last block
  useEffect(() => {
    if (!isTTSEnabled || !prefetchEnabled || allBlockTexts.length === 0) return;

    const text = allBlockTexts[allBlockTexts.length - 1];

    if (!prefetchedAudioRef.current.has(text)) {
      prefetchedAudioRef.current.add(text);
      // Prefetch in background (don't await)
      fetchAudio(text).catch(err => {
        console.error('Prefetch error:', err);
        prefetchedAudioRef.current.delete(text);
      });
    }
  }, [allBlockTexts, isTTSEnabled, fetchAudio]);

  return (
    <div
      className={`overflow-auto pb-16 max-w-2xl w-full mx-auto`}
      style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
    >
      {renderedTree.tree}
      <div ref={translatedTextEndRef} />
    </div>
  );
};

export default TranslatedTextViewer;
