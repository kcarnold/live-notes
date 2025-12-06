import 'dotenv/config'
import express from "express";
import path from "path";
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import pLimit from 'p-limit';

import { DocumentManager } from '@y-sweet/sdk'
import textToSpeech from '@google-cloud/text-to-speech';

import { PostHog } from 'posthog-node';

import { translateBlock, GeminiProvider } from './nlp.ts';
import type { TranslationTodo } from './nlp.ts';

// Get API keys from environment variables, crash if not set
function getEnvOrCrash(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set`);
  }
  return value;
}

const phClient = new PostHog(
  getEnvOrCrash('VITE_PUBLIC_POSTHOG_KEY'),
  { host: getEnvOrCrash('VITE_PUBLIC_POSTHOG_HOST') }
);

const geminiProvider = new GeminiProvider({
  apiKey: getEnvOrCrash('GEMINI_API_KEY'),
  defaultModel: "gemini-2.0-flash-lite",
  maxTokens: 8192,
  posthog: phClient
});

const documentManager = new DocumentManager(getEnvOrCrash("YSWEET_CONNECTION_STRING"));

// Initialize Google Cloud Text-to-Speech client
// Authentication via GOOGLE_APPLICATION_CREDENTIALS environment variable
const ttsClient = new textToSpeech.TextToSpeechClient();

// TTS Configuration: Limit concurrent requests to prevent API spam
const TTS_MAX_CONCURRENT = parseInt(process.env.TTS_MAX_CONCURRENT || '2', 10);
const ttsLimiter = pLimit(TTS_MAX_CONCURRENT);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUDIO_CACHE_DIR = 'audio-cache';

// Ensure audio cache directory exists
await fs.mkdir(AUDIO_CACHE_DIR, { recursive: true });

const app = express();
app.use(express.static("dist"));
app.use(express.json());
app.use('/audio-cache', express.static(AUDIO_CACHE_DIR));




// Y-Sweet
app.post('/api/ys-auth', async (req, res) => {
  console.log('Auth request:', req.body);
  const docId = req.body?.docId ?? null;
  const isEditor = req.body?.isEditor ?? false;
  const authorization = isEditor ? 'full' : 'read-only';
  // In a production app, this is where you'd authenticate the user
  // and check that they are authorized to access the doc.
  const clientToken = await documentManager.getOrCreateDocAndToken(docId, {
    authorization
  })
  res.send(clientToken)
})


app.post('/api/requestTranslatedBlocks', async (req, res) => {
  console.log('Request translated blocks:', req.body);
  const translationTodos = (req.body?.translationTodos as [TranslationTodo]) ?? [];
  const language = req.body?.language;

  const promises = translationTodos.map(async (todo) => {
    return await translateBlock(geminiProvider, todo, language);
  });

  const results = await Promise.all(promises);
  return res.json({
    ok: true,
    results
  });
});

// TTS request deduplication: Map of cache key -> Promise
const ttsInFlightRequests = new Map<string, Promise<string>>();

// Voice configuration per language using Google Chirp 3 HD
const VOICE_CONFIG: Record<string, { voiceName: string; languageCode: string }> = {
  French: {
    voiceName: 'fr-FR-Chirp3-HD-Aoede', // Female voice
    languageCode: 'fr-FR',
  },
  Spanish: {
    voiceName: 'es-ES-Chirp3-HD-Aoede', // Female voice
    languageCode: 'es-ES',
  },
};

app.post('/api/tts', async (req, res) => {
  const { text, language } = req.body;

  if (!text || !language) {
    return res.status(400).json({ error: 'Missing text or language' });
  }

  // Only support configured languages
  if (!VOICE_CONFIG[language]) {
    return res.status(400).json({ error: `Language ${language} not supported for TTS` });
  }

  try {
    // Generate cache key
    const cacheKey = `${language}:${text}`;
    const hash = createHash('md5').update(cacheKey).digest('hex');
    const languageCode = language.toLowerCase().substring(0, 2);
    const filename = `${languageCode}-${hash}`;
    const audioPath = path.join(AUDIO_CACHE_DIR, `${filename}.mp3`);
    const textPath = path.join(AUDIO_CACHE_DIR, `${filename}.txt`);

    // Check if already cached
    try {
      await fs.access(audioPath);
      // File exists, return URL
      return res.json({ audioUrl: `/audio-cache/${filename}.mp3` });
    } catch {
      // File doesn't exist, need to generate
    }

    // Check if request is already in flight
    if (ttsInFlightRequests.has(cacheKey)) {
      console.log(`TTS request for "${text.substring(0, 50)}..." already in flight, awaiting...`);
      await ttsInFlightRequests.get(cacheKey);
      return res.json({ audioUrl: `/audio-cache/${filename}.mp3` });
    }

    // Start new TTS request with concurrency limit
    const voiceConfig = VOICE_CONFIG[language];
    const ttsPromise = ttsLimiter(async () => {
      console.log(`Generating TTS for "${text.substring(0, 50)}..." in ${language}`);

      // Call Google Cloud Text-to-Speech
      const request = {
        input: { text },
        voice: {
          languageCode: voiceConfig.languageCode,
          name: voiceConfig.voiceName,
        },
        audioConfig: {
          audioEncoding: 'MP3' as const,
          speakingRate: 1.0,
        },
      };

      const [response] = await ttsClient.synthesizeSpeech(request);

      if (!response.audioContent) {
        throw new Error('No audio content in response');
      }

      // Convert to Buffer (audioContent is Uint8Array)
      const audioBuffer = Buffer.from(response.audioContent);

      // Write audio file
      await fs.writeFile(audioPath, audioBuffer);

      // Write text file for debugging
      await fs.writeFile(textPath, text, 'utf-8');

      console.log(`TTS cached: ${filename}.mp3`);
      return `/audio-cache/${filename}.mp3`;
    });

    ttsInFlightRequests.set(cacheKey, ttsPromise);

    try {
      const audioUrl = await ttsPromise;
      return res.json({ audioUrl });
    } finally {
      ttsInFlightRequests.delete(cacheKey);
    }
  } catch (error: any) {
    console.error('TTS error:', error?.message || error);
    return res.status(500).json({ error: 'Failed to generate speech' });
  }
});


const PORT = process.env.PORT || 8000;
app.set("port", PORT);



// Catch-all route to support React Router (client-side routing), but do not serve index.html for static asset requests
app.get('*', (req, res, next) => {
  // If the request is for a file with an extension (e.g., .js, .css, .png), skip to next middleware
  if (req.path.match(/\.[a-zA-Z0-9]+$/)) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const server = app.listen(app.get("port"), () => {
  console.log(`Server running on http://localhost:${PORT}`);
}).on('error', (error) => {
  console.error('Server error:', error);
});
