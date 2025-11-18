import { invoke } from "@tauri-apps/api/core";

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

// Web Speech API Implementation
class WebSpeechRecognizer {
  private recognition: SpeechRecognition | null = null;
  private shouldRestart = false;
  private transcriptEl: HTMLElement;
  private statusEl: HTMLElement;
  private startBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private transcripts: string[] = [];

  constructor() {
    this.transcriptEl = document.querySelector("#web-transcript")!;
    this.statusEl = document.querySelector("#web-status")!;
    this.startBtn = document.querySelector("#web-start-btn")!;
    this.stopBtn = document.querySelector("#web-stop-btn")!;
  }

  init() {
    this.startBtn.addEventListener("click", () => this.start());
    this.stopBtn.addEventListener("click", () => this.stop());
  }

  async start() {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      this.updateStatus("Error: Speech recognition not supported");
      return;
    }

    try {
      // Request microphone permission
      await navigator.mediaDevices.getUserMedia({ audio: true });

      this.recognition = new SpeechRecognitionAPI();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = "en-US";
      this.recognition.maxAlternatives = 1;

      this.shouldRestart = true;

      this.recognition.onstart = () => {
        console.log("Web Speech Recognition started");
        this.updateStatus("Listening...");
        this.startBtn.disabled = true;
        this.stopBtn.disabled = false;
      };

      this.recognition.onresult = (event: SpeechRecognitionEvent) => {
        const result = event.results[event.resultIndex];
        const transcript = result[0].transcript;
        const isFinal = result.isFinal;

        console.log(`${isFinal ? "Final" : "Interim"}: ${transcript}`);

        if (isFinal) {
          this.transcripts.push(transcript);
          this.updateTranscript();
        } else {
          // Show interim result
          this.updateTranscript(transcript);
        }
      };

      this.recognition.onerror = (event: Event & { error: string }) => {
        console.error("Web Speech recognition error:", event.error);

        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          this.updateStatus("Error: Microphone access denied");
          this.stop();
        } else if (event.error === "no-speech") {
          console.log("No speech detected, continuing...");
        } else if (event.error === "network") {
          this.updateStatus("Error: Network error (requires internet)");
        } else {
          this.updateStatus(`Error: ${event.error}`);
        }
      };

      this.recognition.onend = () => {
        console.log("Web Speech recognition ended");

        if (this.shouldRestart && this.recognition) {
          console.log("Restarting recognition...");
          try {
            this.recognition.start();
          } catch (error) {
            console.error("Failed to restart:", error);
            this.stop();
          }
        } else {
          this.updateStatus("Stopped");
          this.startBtn.disabled = false;
          this.stopBtn.disabled = true;
        }
      };

      this.recognition.start();
    } catch (error) {
      console.error("Error starting Web Speech recognition:", error);
      this.updateStatus("Error: Failed to start");
      this.stop();
    }
  }

  stop() {
    this.shouldRestart = false;

    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (error) {
        console.error("Error stopping recognition:", error);
      }
      this.recognition = null;
    }

    this.updateStatus("Stopped");
    this.startBtn.disabled = false;
    this.stopBtn.disabled = true;
  }

  private updateStatus(status: string) {
    this.statusEl.textContent = status;
  }

  private updateTranscript(interimText?: string) {
    const finalText = this.transcripts.join(" ");
    const displayText = interimText
      ? `${finalText} <span class="interim">${interimText}</span>`
      : finalText;
    this.transcriptEl.innerHTML = displayText || "<em>No transcript yet...</em>";
  }
}

// Native macOS Speech Implementation
class NativeSpeechRecognizer {
  private transcriptEl: HTMLElement;
  private statusEl: HTMLElement;
  private startBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;

  constructor() {
    this.transcriptEl = document.querySelector("#native-transcript")!;
    this.statusEl = document.querySelector("#native-status")!;
    this.startBtn = document.querySelector("#native-start-btn")!;
    this.stopBtn = document.querySelector("#native-stop-btn")!;
  }

  init() {
    this.startBtn.addEventListener("click", () => this.start());
    this.stopBtn.addEventListener("click", () => this.stop());
  }

  async start() {
    try {
      this.updateStatus("Starting native recognition...");

      // Call Tauri command to start native speech recognition
      const result = await invoke<string>("start_native_speech");

      this.updateStatus("Listening (native)...");
      this.startBtn.disabled = true;
      this.stopBtn.disabled = false;

      console.log("Native speech started:", result);

      // TODO: Set up event listener for transcript updates from Rust
    } catch (error) {
      console.error("Error starting native speech:", error);
      this.updateStatus(`Error: ${error}`);
    }
  }

  async stop() {
    try {
      await invoke("stop_native_speech");

      this.updateStatus("Stopped");
      this.startBtn.disabled = false;
      this.stopBtn.disabled = true;
    } catch (error) {
      console.error("Error stopping native speech:", error);
      this.updateStatus(`Error: ${error}`);
    }
  }

  private updateStatus(status: string) {
    this.statusEl.textContent = status;
  }

  updateTranscript(text: string) {
    this.transcriptEl.textContent = text || "No transcript yet...";
  }
}

// Initialize on DOM load
window.addEventListener("DOMContentLoaded", () => {
  const webSpeech = new WebSpeechRecognizer();
  webSpeech.init();

  const nativeSpeech = new NativeSpeechRecognizer();
  nativeSpeech.init();
});
