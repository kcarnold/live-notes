import './App.css';
import { useRef, useState } from 'react';
import * as Y from 'yjs';
import { useYDoc } from '@y-sweet/react';
import { setYTextFromString } from './yjsUtils';

function insertOrUpdateTurn(
  transcriptXml: Y.XmlFragment,
  transcriptSessionId: string,
  turnOrder: number,
  transcript: string
) {
  for (let i = 0; i < transcriptXml.length; i++) {
    const element = transcriptXml.get(i);
    if (
      element instanceof Y.XmlElement &&
      element.nodeName === 'paragraph' &&
      element.getAttribute('session_id') === transcriptSessionId &&
      element.getAttribute('turn_order') === turnOrder.toString()
    ) {
      // Update existing turn
      const textNode = element.get(0);
      if (textNode instanceof Y.XmlText) {
        setYTextFromString(textNode, transcript);
      } else {
        console.warn(`Expected XmlText but found ${textNode.constructor.name}`);
      }
      return;
    }
  }
  // If no existing turn found, create a new one
  const textNode = new Y.XmlText();
  textNode.insert(0, transcript);
  const paragraphNode = new Y.XmlElement('paragraph');
  paragraphNode.setAttribute('session_id', transcriptSessionId);
  paragraphNode.setAttribute('turn_order', turnOrder.toString());
  paragraphNode.insert(0, [textNode]);
  // insert it at the end
  transcriptXml.insert(transcriptXml.length, [paragraphNode]);
}

// Web Speech API types
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: (event: SpeechRecognitionEvent) => void;
  onerror: (event: Event & { error: string }) => void;
  onend: () => void;
  onstart: () => void;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

function SpeechTranscriber() {
  const yDoc = useYDoc();
  const transcriptXml = yDoc.getXmlFragment("transcriptDoc");
  const recognition = useRef<SpeechRecognition | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const turnOrderRef = useRef<number>(0);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const shouldRestartRef = useRef<boolean>(false);

  const startTranscription = async () => {
    // Check if Web Speech API is supported
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      alert('Speech recognition is not supported in this browser. Please use Chrome, Edge, or Safari.');
      return;
    }

    try {
      // Request microphone permission explicitly
      await navigator.mediaDevices.getUserMedia({ audio: true });

      // Initialize speech recognition
      recognition.current = new SpeechRecognitionAPI();
      recognition.current.continuous = true; // Keep listening
      recognition.current.interimResults = true; // Get partial results
      recognition.current.lang = 'en-US'; // Default language
      recognition.current.maxAlternatives = 1;

      sessionIdRef.current = "" + Date.now();
      turnOrderRef.current = 0;
      shouldRestartRef.current = true;

      recognition.current.onstart = () => {
        console.log('Speech recognition started');
        setIsRecording(true);
      };

      recognition.current.onresult = (event: SpeechRecognitionEvent) => {
        // Process the latest result
        const result = event.results[event.resultIndex];
        const transcript = result[0].transcript;

        console.log(`${result.isFinal ? 'Final' : 'Interim'}: ${transcript}`);

        if (result.isFinal) {
          // Create a new turn for final results
          insertOrUpdateTurn(
            transcriptXml,
            sessionIdRef.current!,
            turnOrderRef.current,
            transcript
          );
          turnOrderRef.current++;
        } else {
          // Update the current turn with interim results
          insertOrUpdateTurn(
            transcriptXml,
            sessionIdRef.current!,
            turnOrderRef.current,
            transcript
          );
        }
      };

      recognition.current.onerror = (event: Event & { error: string }) => {
        console.error('Speech recognition error:', event.error);

        // Handle specific errors
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          alert('Microphone access denied. Please enable microphone permissions.');
          stopEverything();
        } else if (event.error === 'no-speech') {
          console.log('No speech detected, continuing...');
        } else if (event.error === 'network') {
          alert('Network error. Speech recognition requires internet connection.');
        }
      };

      recognition.current.onend = () => {
        console.log('Speech recognition ended');

        // Auto-restart if we're still supposed to be recording
        if (shouldRestartRef.current && recognition.current) {
          console.log('Restarting speech recognition...');
          try {
            recognition.current.start();
          } catch (error) {
            console.error('Failed to restart recognition:', error);
            stopEverything();
          }
        } else {
          setIsRecording(false);
        }
      };

      // Start recognition
      recognition.current.start();

      // Acquire wake lock to prevent screen from sleeping
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch((err) => {
          console.error('Failed to release wake lock:', err);
        });
        wakeLockRef.current = null;
      }
      navigator.wakeLock.request('screen').then((wakeLock) => {
        wakeLockRef.current = wakeLock;
      }).catch((err) => {
        console.error('Failed to acquire wake lock:', err);
      });

    } catch (error) {
      console.error('Error starting transcription:', error);
      alert('Failed to start transcription. Please check microphone permissions.');
      stopEverything();
    }
  };

  const endTranscription = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    stopEverything();
  };

  const stopEverything = (): void => {
    shouldRestartRef.current = false;
    setIsRecording(false);

    if (recognition.current) {
      try {
        recognition.current.stop();
      } catch (error) {
        console.error('Error stopping recognition:', error);
      }
      recognition.current = null;
    }

    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch((err) => {
        console.error('Failed to release wake lock:', err);
      });
      wakeLockRef.current = null;
    }
  };

  if (isRecording) {
    return <button
      className="bg-red-500 text-white font-medium py-1 px-2 rounded-md hover:bg-red-600"
      onClick={endTranscription}>Stop transcription
    </button>;
  } else {
    return <button
      className="bg-green-500 text-white font-medium py-1 px-2 rounded-md hover:bg-green-600"
      onClick={() => { void startTranscription(); }}>
      Start transcription
    </button>;
  }
}

export default SpeechTranscriber;
