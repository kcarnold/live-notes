import 'dotenv/config'
import express from "express";
import path from "path";
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import pLimit from 'p-limit';

import { DocumentManager } from '@y-sweet/sdk'
import { ElevenLabs, ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

import { PostHog, setupExpressErrorHandler } from 'posthog-node';

import { translateBlock, GeminiProvider } from './nlp.ts';
import type { TranslationTodo } from './nlp.ts';

import { AccessToken } from 'livekit-server-sdk';
import TranslationSessionManager from './live-audio/translation-session-manager.ts';

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
  {
    host: getEnvOrCrash('VITE_PUBLIC_POSTHOG_HOST'),
    enableExceptionAutocapture: true,
  }
);

const geminiProvider = new GeminiProvider({
  apiKey: getEnvOrCrash('GEMINI_API_KEY'),
  defaultModel: "gemini-2.5-flash-lite",
  maxTokens: 8192,
  posthog: phClient
});

const ySweetConnectionString = getEnvOrCrash("YSWEET_CONNECTION_STRING");
console.log('Y-Sweet Connection String:', ySweetConnectionString);
const documentManager = new DocumentManager(ySweetConnectionString);

const elevenLabsClient = new ElevenLabsClient({
  apiKey: getEnvOrCrash('ELEVENLABS_API_KEY'),
});

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

setupExpressErrorHandler(phClient, app);


// Public config for services that need to report to PostHog
app.get('/api/config', (_req, res) => {
  res.json({
    posthogKey: process.env.VITE_PUBLIC_POSTHOG_KEY ?? '',
    posthogHost: process.env.VITE_PUBLIC_POSTHOG_HOST ?? '',
  });
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


// ---------------------------------------------------------------------------
// Live speech-to-speech translation (Gemini Live + LiveKit)
//
// Self-contained, opt-in feature. If the LIVEKIT_* env vars are unset these
// routes return 503 and the rest of the app is unaffected. The LiveKit room
// name is the Y-Sweet doc id, so audio rooms line up 1:1 with outline sessions.
// The speaker (editor) always joins as ORGANIZER_IDENTITY; per-language
// translator bots subscribe to that identity.
// ---------------------------------------------------------------------------
const ORGANIZER_IDENTITY = 'organizer-host';

function getLiveKitConfig(): { url: string; apiKey: string; apiSecret: string } | null {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

// Give the translation manager what it needs to persist transcripts into Yjs and
// reap idle translator bots. No-op for transcript/reaper if LiveKit is unconfigured.
{
  const lk = getLiveKitConfig();
  if (lk) {
    TranslationSessionManager.getInstance().init({ documentManager, livekit: lk, telemetry: phClient });
  }
}

// Issue a LiveKit access token. role 'organizer' => can publish (the speaker);
// anything else => subscribe-only attendee (a listener).
app.post('/api/livekit/token', async (req, res) => {
  try {
    const lk = getLiveKitConfig();
    if (!lk) return res.status(503).json({ error: 'LiveKit not configured' });

    const room = req.body?.room as string | undefined;
    const identity = req.body?.identity as string | undefined;
    const role = (req.body?.role as string | undefined) ?? 'attendee';
    if (!room || !identity) {
      return res.status(400).json({ error: 'Missing room or identity' });
    }

    const isOrganizer = role === 'organizer';
    const at = new AccessToken(lk.apiKey, lk.apiSecret, { identity, name: identity, ttl: '4h' });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: isOrganizer,
      canSubscribe: true,
      canPublishData: isOrganizer,
    });
    const token = await at.toJwt();
    return res.json({ token, serverUrl: lk.url });
  } catch (error) {
    phClient.captureException(error);
    console.error('LiveKit token error:', error);
    return res.status(500).json({ error: 'Failed to issue LiveKit token' });
  }
});

// Request (or reuse) a translator bot for a language in a room. The bot spins
// up a Gemini Live session and publishes translated audio as `translator-<code>`.
app.post('/api/livekit/translate', async (req, res) => {
  try {
    if (!getLiveKitConfig()) return res.status(503).json({ error: 'LiveKit not configured' });

    const sessionId = req.body?.sessionId as string | undefined;
    const targetLanguage = req.body?.targetLanguage as string | undefined; // BCP-47 code, e.g. "fr"
    if (!sessionId || !targetLanguage) {
      return res.status(400).json({ error: 'Missing sessionId or targetLanguage' });
    }

    const manager = TranslationSessionManager.getInstance();
    const bridge = await manager.getOrCreate(sessionId, targetLanguage, ORGANIZER_IDENTITY);
    return res.json({
      translatorIdentity: bridge.identity,
      status: bridge.status,
      targetLanguage: bridge.targetLanguage,
    });
  } catch (error) {
    phClient.captureException(error);
    console.error('LiveKit translate error:', error);
    return res.status(500).json({ error: 'Failed to start translation: ' + (error as Error).message });
  }
});

// List active translator bots + listener counts for a room (drives the speaker dashboard).
app.get('/api/livekit/translate/status', (req, res) => {
  try {
    if (!getLiveKitConfig()) return res.status(503).json({ error: 'LiveKit not configured' });
    const sessionId = req.query?.sessionId as string | undefined;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    const manager = TranslationSessionManager.getInstance();
    return res.json({ translations: manager.getActiveTranslations(sessionId) });
  } catch (error) {
    phClient.captureException(error);
    console.error('LiveKit status error:', error);
    return res.status(500).json({ error: 'Failed to get translation status' });
  }
});

// Decrement a language's listener count; the bot tears down at zero.
// POST so navigator.sendBeacon can call it on page unload.
app.post('/api/livekit/translate/unsubscribe', async (req, res) => {
  try {
    if (!getLiveKitConfig()) return res.status(503).json({ error: 'LiveKit not configured' });
    const sessionId = req.body?.sessionId as string | undefined;
    const targetLanguage = req.body?.targetLanguage as string | undefined;
    if (!sessionId || !targetLanguage) {
      return res.status(400).json({ error: 'Missing sessionId or targetLanguage' });
    }
    const manager = TranslationSessionManager.getInstance();
    await manager.unsubscribe(sessionId, targetLanguage);
    return res.json({ success: true });
  } catch (error) {
    phClient.captureException(error);
    console.error('LiveKit unsubscribe error:', error);
    return res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});


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
const VOICE_CONFIG: Record<string, { voiceId: string; languageCode: string; model: string, voiceSettings?: ElevenLabs.VoiceSettings }> = {
  French: {
    voiceId: 'JBFqnCBsd6RMkjVDRZzb', // George
    languageCode: 'fr',
    model: 'eleven_multilingual_v2',
    voiceSettings: {
      speed: 0.9,
    }
  },
  Spanish: {
    voiceId: 'JBFqnCBsd6RMkjVDRZzb', // George
    languageCode: 'es',
    model: 'eleven_multilingual_v2',
    voiceSettings: {
      speed: 0.9,
    }
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

      // Call with retry on 429 errors
      const audio = await elevenLabsClient.textToSpeech.convert(voiceConfig.voiceId, {
        text,
        modelId: voiceConfig.model,
        languageCode: voiceConfig.languageCode,
        voiceSettings: voiceConfig.voiceSettings,
      }, {
        maxRetries: 3,
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
    });

    ttsInFlightRequests.set(cacheKey, ttsPromise);

    try {
      const audioUrl = await ttsPromise;
      return res.json({ audioUrl });
    } finally {
      ttsInFlightRequests.delete(cacheKey);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('TTS error:', message);
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

app.listen(app.get("port"), () => {
  console.log(`Server running on http://localhost:${PORT}`);
}).on('error', (error) => {
  console.error('Server error:', error);
});
