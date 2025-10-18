import 'dotenv/config'
import express from "express";
import path from "path";
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import fs from 'fs/promises';

import { DocumentManager } from '@y-sweet/sdk'
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

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

const geminiProvider = new GeminiProvider({
  apiKey: getEnvOrCrash('GEMINI_API_KEY'),
  defaultModel: "gemini-2.0-flash-lite",
  maxTokens: 8192,
});

const documentManager = new DocumentManager(getEnvOrCrash("YSWEET_CONNECTION_STRING"));

const elevenLabsClient = new ElevenLabsClient({
  apiKey: getEnvOrCrash('ELEVENLABS_API_KEY'),
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUDIO_CACHE_DIR = 'audio-cache';

// Ensure audio cache directory exists
await fs.mkdir(AUDIO_CACHE_DIR, { recursive: true });

const app = express();
app.use(express.static("dist"));
app.use(express.json());
app.use('/audio-cache', express.static(AUDIO_CACHE_DIR));


// AssemblyAI v3 token endpoint
app.get("/api/aai_token", async (_req, res) => {
  const expiresInSeconds = 2 * 60;
  const apiKey = getEnvOrCrash("ASSEMBLYAI_API_KEY");
  const url = `https://streaming.assemblyai.com/v3/token?expires_in_seconds=${expiresInSeconds}`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: apiKey,
      },
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`AssemblyAI token fetch failed: ${response.status} ${errText}`);
    }
    const data = await response.json();
    res.json({ token: data.token });
  } catch (error: any) {
    console.error("Error generating temp token:", error?.message || error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});


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

// Voice configuration per language
const VOICE_CONFIG: Record<string, { voiceId: string; model: string }> = {
  French: {
    voiceId: 'Xb7hH8MSUJpSbSDYk0k2', // Alice
    model: 'eleven_multilingual_v2',
  },
  Spanish: {
    voiceId: 'Xb7hH8MSUJpSbSDYk0k2', // Alice
    model: 'eleven_multilingual_v2',
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

    // Start new TTS request
    const voiceConfig = VOICE_CONFIG[language];
    const ttsPromise = (async () => {
      console.log(`Generating TTS for "${text.substring(0, 50)}..." in ${language}`);

      const audio = await elevenLabsClient.textToSpeech.convert(voiceConfig.voiceId, {
        text,
        modelId: voiceConfig.model,
      });

      // Convert stream to buffer
      const chunks: Buffer[] = [];
      for await (const chunk of audio) {
        chunks.push(Buffer.from(chunk));
      }
      const audioBuffer = Buffer.concat(chunks);

      // Write audio file
      await fs.writeFile(audioPath, audioBuffer);

      // Write text file for debugging
      await fs.writeFile(textPath, text, 'utf-8');

      console.log(`TTS cached: ${filename}.mp3`);
      return `/audio-cache/${filename}.mp3`;
    })();

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
