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

import { translateBlock, draftItemTranslations, runSlideTranslationAgent, GeminiProvider } from './nlp.ts';
import type { TranslationTodo } from './nlp.ts';
import { BIBLE_TRANSLATIONS, type BibleToolCall } from './bible.ts';
import { SlideLibrary } from './slideLibrary.ts';
import { translateItem } from './src/slideItemTranslation.ts';
import { SlideConversationStore, slidesHash } from './slideConversationStore.ts';
import type { Content } from '@google/genai';

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

// Stronger model for whole-item slide drafting (pre-translation/review): one call
// translates all slides into all languages and sorts a multilingual reference dump into
// the right languages, so capability matters more than the latency/cost of the hot
// incremental notes path (which stays on defaultModel). Override via GEMINI_STRONG_MODEL.
const STRONG_MODEL = process.env.GEMINI_STRONG_MODEL || 'gemini-3.5-flash';

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

// Persistent reviewed-translation library. Defaults into the audio-cache dir so it
// rides along with the existing Docker volume; override with SLIDE_LIBRARY_PATH.
const SLIDE_LIBRARY_PATH =
  process.env.SLIDE_LIBRARY_PATH || path.join(AUDIO_CACHE_DIR, 'slide-library.json');
const slideLibrary = new SlideLibrary(SLIDE_LIBRARY_PATH);
await slideLibrary.load();
console.log(`Slide translation library: ${SLIDE_LIBRARY_PATH} (${slideLibrary.list().length} entries)`);

// Per-item agent conversations (in-memory, ephemeral). The agent runs here, so the
// conversation lives here; the review screen pulls it down and posts follow-ups.
const slideConversations = new SlideConversationStore();

/** Stable conversation key: the Proclaim itemId when present, else a content hash. */
function conversationKey(itemId: string | undefined, slides: string[]): string {
  return itemId && itemId.trim() ? itemId.trim() : `hash:${slidesHash(slides)}`;
}

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
    TranslationSessionManager.getInstance().init({ documentManager, livekit: lk });
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

// --- Slide translation library (persistent reviewed tier) ---

// List all reviewed entries.
app.get('/api/slideLibrary', (_req, res) => {
  return res.json({ ok: true, entries: slideLibrary.list() });
});

// Batch lookup of reviewed entries for one language. Body: { language, texts: string[] }.
// Returns entries[] aligned with texts (null where there is no reviewed entry).
app.post('/api/slideLibrary/lookup', (req, res) => {
  const language = req.body?.language as string | undefined;
  const texts = (req.body?.texts as string[]) ?? [];
  if (!language) {
    return res.status(400).json({ ok: false, error: 'Missing language' });
  }
  const entries = texts.map((text) => slideLibrary.lookup(language, text) ?? null);
  return res.json({ ok: true, entries });
});

// Upsert a reviewed translation. Body: { language, sourceText, text, provenance? }.
app.post('/api/slideLibrary', async (req, res) => {
  const { language, sourceText, text, provenance } = req.body ?? {};
  if (!language || typeof sourceText !== 'string' || typeof text !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing language, sourceText, or text' });
  }
  const record = await slideLibrary.upsert({ language, sourceText, text, provenance });
  return res.json({ ok: true, record });
});

// Translate a whole service item, reusing reviewed library entries and filling the rest
// with one strong-model call for all languages at once. Body:
// { slides: string[], languages: string[], reference?: string }. `reference` is a free-text
// dump (possibly multilingual, arbitrarily segmented) the model uses where it covers a
// target language and ignores otherwise. Returns { translations: { [language]: PerSlideTranslation[] } }.
app.post('/api/translateItem', async (req, res) => {
  const slides = (req.body?.slides as string[]) ?? [];
  const requestedLanguages = (req.body?.languages as string[]) ?? [];
  const reference = (req.body?.reference as string | undefined)?.trim();
  // Item title (e.g. a Bible citation like "Psalm 23") — a lookup cue the slide text lacks.
  const itemTitle = (req.body?.itemTitle as string | undefined)?.trim();
  // Conversation key: the Proclaim itemId when this came from a service item (so the review
  // screen can find it by itemId), else a content hash for ad-hoc pastes.
  const itemId = (req.body?.itemId as string | undefined)?.trim();
  if (!Array.isArray(slides) || requestedLanguages.length === 0) {
    return res.status(400).json({ ok: false, error: 'Missing slides or languages' });
  }

  const lookup = slideLibrary.toLookup();
  // Bible lookups the model made while drafting — reported to PostHog and the review UI.
  const bibleLookups: BibleToolCall[] = [];
  // The raw agent history, captured so we can persist it for review + follow-ups.
  let conversationMessages: Content[] = [];
  const translations = await translateItem({
    slides,
    languages: requestedLanguages,
    lookup,
    translate: ({ slides: sourceSlides, targets }) =>
      draftItemTranslations(geminiProvider, {
        sourceSlides,
        targets,
        referenceText: reference || undefined,
        itemTitle: itemTitle || undefined,
        model: STRONG_MODEL,
        onToolCall: (call) => {
          bibleLookups.push(call);
          phClient.capture({
            distinctId: 'slide-review',
            event: 'bible_lookup',
            properties: {
              reference: call.reference,
              ok: call.ok,
              foundLanguages: call.foundLanguages,
              missingLanguages: call.missingLanguages,
            },
          });
        },
        onConversation: (messages) => {
          conversationMessages = messages;
        },
      }),
  });

  // Persist the conversation so the review screen can show the agent's reasoning/tool calls
  // and post follow-ups. Stored even when no model call was needed (all slides reviewed) so
  // a GET by this key still returns the item context.
  const conversationId = conversationKey(itemId, slides);
  slideConversations.upsert({
    itemId: conversationId,
    itemTitle: itemTitle || '',
    slides,
    slidesHash: slidesHash(slides),
    languages: requestedLanguages,
    messages: conversationMessages,
    status: 'idle',
  });

  return res.json({ ok: true, translations, bibleLookups, conversationId });
});

// Fetch the stored agent conversation for an item (review screen). 404 when unknown.
app.get('/api/slideConversation', (req, res) => {
  const itemId = (req.query?.itemId as string | undefined)?.trim();
  if (!itemId) return res.status(400).json({ ok: false, error: 'Missing itemId' });
  const conversation = slideConversations.get(itemId);
  if (!conversation) return res.status(404).json({ ok: false, error: 'No conversation' });
  return res.json({ ok: true, conversation });
});

// Send a follow-up message to an item's agent and resume the loop. The model may answer in
// text and/or revise translations via set_translations; revised entries are returned for the
// browser to write into the slideTranslations Y.Map (the server stays a non-Yjs-writer).
app.post('/api/slideConversation/message', async (req, res) => {
  const itemId = (req.body?.itemId as string | undefined)?.trim();
  const text = (req.body?.text as string | undefined)?.trim();
  if (!itemId || !text) {
    return res.status(400).json({ ok: false, error: 'Missing itemId or text' });
  }
  const conversation = slideConversations.get(itemId);
  if (!conversation) return res.status(404).json({ ok: false, error: 'No conversation' });

  conversation.messages.push({ role: 'user', parts: [{ text }] });
  slideConversations.setStatus(itemId, 'running');
  const bibleLanguages = conversation.languages.filter((language) => BIBLE_TRANSLATIONS[language]);
  const bibleLookups: BibleToolCall[] = [];
  try {
    const result = await runSlideTranslationAgent(geminiProvider, {
      sourceSlides: conversation.slides,
      messages: conversation.messages, // mutated in place
      model: STRONG_MODEL,
      bibleLanguages,
      onToolCall: (call) => bibleLookups.push(call),
    });
    slideConversations.setStatus(itemId, 'idle');

    // Flatten revised translations for the browser to apply (auto / llm-agent provenance).
    const updatedTranslations: Array<{ language: string; sourceText: string; text: string }> = [];
    for (const [language, blocks] of Object.entries(result.translations)) {
      for (const block of blocks) {
        updatedTranslations.push({ language, sourceText: block.sourceText, text: block.translatedText });
      }
    }
    return res.json({ ok: true, conversation, updatedTranslations, bibleLookups });
  } catch (err) {
    slideConversations.setStatus(itemId, 'error');
    console.error('slideConversation/message failed:', err);
    if (err instanceof Error) phClient.captureException(err);
    return res.status(500).json({ ok: false, error: 'Agent run failed' });
  }
});

// Record a reviewer's manual edit as a note in the conversation, so the next follow-up has
// that context. No agent run — the edit itself is written to Yjs/library by the browser.
app.post('/api/slideConversation/note', (req, res) => {
  const itemId = (req.body?.itemId as string | undefined)?.trim();
  const text = (req.body?.text as string | undefined)?.trim();
  if (!itemId || !text) {
    return res.status(400).json({ ok: false, error: 'Missing itemId or text' });
  }
  const updated = slideConversations.appendMessage(itemId, {
    role: 'user',
    parts: [{ text }],
  });
  if (!updated) return res.status(404).json({ ok: false, error: 'No conversation' });
  return res.json({ ok: true, conversation: updated });
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
