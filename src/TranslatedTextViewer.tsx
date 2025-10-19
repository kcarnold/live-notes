import React, { useRef, useMemo, useState, useCallback } from 'react';
import { useScrollToBottom } from './reactUtils';
import { useAsPlainText } from './yjsUtils';
import { Remark } from 'react-remark';
import { translatedTextKeyForLanguage } from './translationUtils';

interface TranslatedTextViewerProps {
  language: string;
  fontSize?: number;
}

interface TTSStatus {
  state: 'idle' | 'loading' | 'error' | 'playing';
  errorMessage?: string;
  playingText?: string;
  loadingText?: string;
};

async function fetchAudio(text: string, language: string): Promise<string> {
  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, language }),
  });

  if (!response.ok) {
    console.error('TTS request failed:', response.statusText);
    throw new Error(`TTS request failed: ${response.statusText}`);
  }

  const data = await response.json() as { audioUrl: string };
  return data.audioUrl;
}


const TranslatedTextViewer: React.FC<TranslatedTextViewerProps> = ({ language, fontSize }) => {
  const yJsKey = translatedTextKeyForLanguage(language);
  const [translatedText] = useAsPlainText(yJsKey);
  const translatedTextEndRef = useRef<HTMLDivElement | null>(null);
  useScrollToBottom(translatedTextEndRef, [translatedText], true);
  
  const lines = useMemo(() => {
    const lines = translatedText ? translatedText.split('\n') : [];
    return lines.filter(line => line.trim() !== '');
  }, [translatedText]);

  const isTTSEnabled = language === 'French' || language === 'Spanish';

  const [ttsStatus, setTtsStatus] = useState<TTSStatus>({ state: 'idle' });
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handleBlockClick = useCallback(async (text: string) => {
    if (!isTTSEnabled || !text.trim()) return;
    if (ttsStatus.state === 'loading') return; // Prevent multiple requests
    if (ttsStatus.state === 'playing') {
      audioRef.current?.pause();
      audioRef.current = null;
      // If the same block, don't restart
      if (ttsStatus.playingText === text) {
        setTtsStatus({ state: 'idle' });
        return;
      }
      // Fall through to start new audio
    }
    setTtsStatus({ state: 'loading', loadingText: text });
    let audioUrl: string;
    try {
      audioUrl = await fetchAudio(text, language);
    } catch (error: unknown) {
      console.error('Error fetching TTS audio:', error);
      setTtsStatus({ state: 'error', errorMessage: error instanceof Error ? error.message : 'Unknown error' });
      return;
    }

    const audio = new Audio(audioUrl);
    audioRef.current = audio;
    audio.onerror = (err: string | Event) => {
      console.error('Audio playback error:', err);
      const errStr = err instanceof Event ? 'Audio playback error' : err.toString();
      setTtsStatus({ state: 'error', errorMessage: errStr });
    };
    audio.onended = () => {
      setTtsStatus({ state: 'idle' });
    };
    setTtsStatus({ state: 'playing', playingText: text });
    await audio.play();
  }, [isTTSEnabled, ttsStatus, language]);

  return (
    <div
      className={`overflow-auto pb-16 max-w-2xl w-full mx-auto`}
      style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
    >
      {lines.map((line, index) => (
        <p key={index} onClick={() => {void handleBlockClick(line)}} className={
          (ttsStatus.state === 'playing' && ttsStatus.playingText === line) ? 'bg-blue-200 dark:bg-blue-800' : 
          (ttsStatus.state === 'loading' && ttsStatus.loadingText === line) ? 'tts-loading' : ''
        }>
          <Remark>{line}</Remark>
        </p>
      ))}
      <div ref={translatedTextEndRef} />
    </div>
  );
};

export default TranslatedTextViewer;
