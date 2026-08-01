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

import { translateBlock, draftItemTranslations, runSlideTranslationAgent, buildSeedConversationPrompt, GeminiProvider, emptyUsage, mergeUsage } from './nlp.ts';
import type { TranslationTodo, TokenUsage, AgentObservability } from './nlp.ts';
import { BIBLE_TRANSLATIONS, type BibleToolCall } from './bible.ts';
import { SlideLibrary } from './slideLibrary.ts';
import { translateItem } from './src/slideItemTranslation.ts';
import {
  SlideConversationStore,
  slidesHash,
  readConversation,
  writeConversation,
  appendMessageTo,
  setStatusIn,
} from './slideConversationStore.ts';
import type { Content } from '@google/genai';
import * as Y from 'yjs';
import { buildSessionExport, renderSessionHtml, sessionExportFilename } from './sessionExport.ts';

import { AccessToken } from 'livekit-server-sdk';
import { SimulateScenarioKind } from '@livekit/rtc-node';
import TranslationSessionManager from './live-audio/translation-session-manager.ts';
import { parseSilenceThresholdDbfs } from './live-audio/translation-bridge.ts';
import { WriteAuth, auditDistinctId, formatAudit, resolveWriteAuthConfig } from './writeAuth.ts';

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

// General context injected into every slide-translation prompt: the setting and the intent
// of the translations. Steers register and reminds the model these are for understanding,
// not singing or literal liturgical reading. Override with SLIDE_TRANSLATION_CONTEXT.
const SLIDE_TRANSLATION_CONTEXT = process.env.SLIDE_TRANSLATION_CONTEXT ||
  'These slides are shown at a Presbyterian Church in America (PCA) worship service. The ' +
  'translations are provided alongside the service so non-English speakers can follow along — ' +
  'they are for understanding and reference, not for congregational singing or as an official ' +
  'literal/liturgical rendering. Aim for clear, natural, reverent wording in each target language.';

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

// Per-item agent conversations. The agent runs here, but the conversation is stored in the
// per-day Y-Sweet doc (so it survives restarts and streams live to the review screen); this
// store manages the server's write connection to that doc.
const slideConversations = new SlideConversationStore(documentManager);

/** Stable conversation key: the Proclaim itemId when present, else a content hash. */
function conversationKey(itemId: string | undefined, slides: string[]): string {
  return itemId && itemId.trim() ? itemId.trim() : `hash:${slidesHash(slides)}`;
}

/**
 * PostHog LLM-observability tags for a slide-translation conversation. The conversation id
 * is the trace id, so every generation (initial draft + follow-ups) groups into one trace;
 * the day's docId is the distinct id, so a day's review work groups under one "user".
 */
function slideObservability(
  conversationId: string,
  docId: string,
  extra?: Record<string, unknown>,
): AgentObservability {
  return {
    distinctId: docId,
    traceId: conversationId,
    properties: { conversationId, docId, ...extra },
  };
}

/**
 * Report a Bible lookup to PostHog, keyed to the same conversation as the LLM trace so it
 * lines up with the agent's generations (`$ai_trace_id`) instead of the old hardcoded
 * 'slide-review' distinct id that lumped every lookup together.
 */
function recordBibleLookup(call: BibleToolCall, conversationId: string, docId: string): void {
  phClient.capture({
    distinctId: docId,
    event: 'bible_lookup',
    properties: {
      $ai_trace_id: conversationId,
      conversationId,
      reference: call.reference,
      ok: call.ok,
      foundLanguages: call.foundLanguages,
      missingLanguages: call.missingLanguages,
    },
  });
}

// !!! TEMPORARY BACK-COMPAT SHIM — DELETE ME (see /api/translateItem) !!!
// Mirrors the frontend's getDocId() default (`doc-YYYY-MM-DD`, local date) so a
// Proclaim client too old to send `docId` still targets the right per-day doc.
function currentDayDocId(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `doc-${ymd}`;
}

// ---------------------------------------------------------------------------
// Write authorization (shared keys, not user logins — see writeAuth.ts).
//
// Reading is open to anyone: viewers get read-only Y-Sweet tokens, TTS and listener
// LiveKit tokens with no key at all. What a key protects is the ability to *write* —
// full doc tokens, the broadcaster's microphone, and the endpoints that spend money on
// models and TTS.
//
// Defaults to `observe`: every privileged request is checked and recorded, and then
// allowed regardless. That makes it safe to ship keys to the clients first and read
// the logs for a week before flipping WRITE_AUTH_MODE=enforce.
// ---------------------------------------------------------------------------
const writeAuthConfig = resolveWriteAuthConfig(process.env);
for (const notice of writeAuthConfig.notices) console.log(notice);

const writeAuth = new WriteAuth(writeAuthConfig, (audit) => {
  // Log every outcome, and mirror it to PostHog so the observe week can be read as a
  // chart ("is the Proclaim service presenting a key yet?") rather than by grepping.
  const line = formatAudit(audit);
  if (audit.status === 'ok') console.log(line);
  else console.warn(line);
  phClient.capture({
    distinctId: auditDistinctId(audit),
    event: 'write_auth_check',
    properties: {
      route: audit.route,
      status: audit.status,
      keyLabel: audit.label,
      mode: audit.mode,
      refused: audit.refused,
      // Attribution for the misses. Without these, every unauthorized request in the
      // observe window collapses into one anonymous total, which cannot answer the only
      // question that window exists to ask: *which* device still needs a key.
      ip: audit.client.ip,
      userAgent: audit.client.userAgent,
      keyFingerprint: audit.client.keyFingerprint,
    },
  });
});

/**
 * Gate a route that is *always* privileged. Routes where only some requests are
 * privileged (asking for an editor token, or for the broadcaster's microphone) call
 * `writeAuth.check`/`gate` inline instead, so an ordinary viewer request stays open.
 */
function requireWriteKey(route: string): express.RequestHandler {
  return (req, res, next) => {
    if (writeAuth.gate(req, res, route)) next();
  };
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
//
// Read-only tokens are unconditional — anyone may watch a session. A *full* token is
// the app's real write boundary (the browser talks to Y-Sweet directly with it), so
// asking for one is what requires a key.
//
// An unauthorized editor request is downgraded to read-only rather than refused: a
// device with a stale key then shows the session as a viewer instead of a blank page,
// which is the failure anyone would rather have mid-service. The granted level comes
// back in a header so the UI can say so plainly instead of offering edit controls that
// silently do nothing.
app.post('/api/ys-auth', async (req, res) => {
  const docId = req.body?.docId ?? null;
  const wantsEditor = req.body?.isEditor ?? false;
  // Only editor requests are evaluated, and so only they are audited: a viewer needs no
  // key, and checking one anyway would put an audit record on every page load of every
  // screen in the session.
  const check = wantsEditor ? writeAuth.check(req, '/api/ys-auth') : null;
  const authorization = check?.allowed ? 'full' : 'read-only';
  console.log(`Auth request: doc=${docId} isEditor=${wantsEditor} granted=${authorization}`);
  const clientToken = await documentManager.getOrCreateDocAndToken(docId, {
    authorization
  })
  res.setHeader('X-Granted-Authorization', authorization);
  // Why the key was or wasn't accepted, which is not the same question as what was
  // granted. In observe mode nothing is refused, so `granted` is always `full` and this
  // header is the only way a device can discover it is holding a stale key — during the
  // observe window, which is exactly when that is still cheap to fix.
  if (check) res.setHeader('X-Write-Key-Status', check.result.status);
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

// The cost path's only knob: the dBFS level below which the organizer's mic counts as
// silence, at which point a bridge suspends its Gemini socket. Unset (the default)
// means bridges never suspend. The goaway/reconnect buffering is independent of this
// and always on, as is the default translator — silence gating no longer decides
// which bridges exist, only what an existing one does while nobody is speaking.
const SILENCE_THRESHOLD_DBFS = parseSilenceThresholdDbfs(process.env.LIVE_AUDIO_SILENCE_THRESHOLD_DBFS);

// Give the translation manager what it needs to persist transcripts into Yjs and
// reap idle translator bots. No-op for transcript/reaper if LiveKit is unconfigured.
{
  const lk = getLiveKitConfig();
  if (lk) {
    TranslationSessionManager.getInstance().init({
      documentManager,
      livekit: lk,
      telemetry: phClient,
      silenceThresholdDbfs: SILENCE_THRESHOLD_DBFS,
    });
    console.log(
      `[server] Live-audio silence gating (cost path): ${
        Number.isFinite(SILENCE_THRESHOLD_DBFS) ? `${SILENCE_THRESHOLD_DBFS} dBFS` : 'disabled'
      }`
    );
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
    // The language this listener wants translated (BCP-47). Carried as a participant
    // attribute so the translation supervisor can read demand straight from room
    // presence — no refcount, no beacon. Optional: attribute-less listeners still get
    // the default bridge, and their /translate request stamps their language.
    const listenLanguage = req.body?.listenLanguage as string | undefined;
    if (!room || !identity) {
      return res.status(400).json({ error: 'Missing room or identity' });
    }

    const isOrganizer = role === 'organizer';
    // An organizer token is the microphone. Its holder can speak into the room and —
    // because every broadcaster joins under the same `organizer-host` identity, which
    // LiveKit resolves by evicting the incumbent — can silently cut off whoever is
    // currently speaking. Listeners ask for no such thing and need no key.
    if (isOrganizer && !writeAuth.gate(req, res, '/api/livekit/token')) return;

    const at = new AccessToken(lk.apiKey, lk.apiSecret, {
      identity,
      name: identity,
      ttl: '4h',
      attributes: isOrganizer
        ? { role: 'organizer' }
        : listenLanguage
          ? { listen: listenLanguage }
          : undefined,
    });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: isOrganizer,
      canSubscribe: true,
      canPublishData: isOrganizer,
    });
    const token = await at.toJwt();

    // A token request means room presence is about to change — poke the translation
    // supervisor so it reconciles this room within seconds instead of on its next
    // tick. Delayed a beat so the requester has actually joined by the time the
    // supervisor looks. Latency-only: the interval loop converges regardless.
    setTimeout(() => TranslationSessionManager.getInstance().poke(room), 2_000).unref?.();

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

// Legacy endpoint, kept for clients cached from before the presence supervisor.
// Leaving the LiveKit room is now the real "unsubscribe" signal; a beacon here just
// nudges the supervisor to notice sooner.
app.post('/api/livekit/translate/unsubscribe', (req, res) => {
  try {
    if (!getLiveKitConfig()) return res.status(503).json({ error: 'LiveKit not configured' });
    const sessionId = req.body?.sessionId as string | undefined;
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    TranslationSessionManager.getInstance().poke(sessionId);
    return res.json({ success: true });
  } catch (error) {
    phClient.captureException(error);
    console.error('LiveKit unsubscribe error:', error);
    return res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});


// Force a LiveKit reconnection scenario on a session's translator bridges.
//
// A full reconnect is what silently deafened both bridges on 2026-07-12, and it cannot be
// waited for — it's the SDK's escalation when a resume fails, driven by server-side events
// rather than by elapsed time. Without this route, verifying that the bridge survives one
// means running a whole service and hoping. With it, the check takes seconds:
//
//   curl -X POST localhost:8000/api/livekit/translate/simulate \
//     -H 'content-type: application/json' \
//     -d '{"sessionId":"doc-2026-07-13","scenario":"fullReconnect"}'
//
// …then confirm translation audio keeps flowing and `organizer_audio_reconciled` fires with
// trigger "reconnected". See docs/live-audio-resilience.md.
//
// Chaos endpoint: refuses to run in production, since it deliberately breaks a live room.
const SIMULATE_SCENARIOS: Record<string, SimulateScenarioKind> = {
  fullReconnect: SimulateScenarioKind.SIMULATE_FULL_RECONNECT,
  signalReconnect: SimulateScenarioKind.SIMULATE_SIGNAL_RECONNECT,
  nodeFailure: SimulateScenarioKind.SIMULATE_NODE_FAILURE,
  migration: SimulateScenarioKind.SIMULATE_MIGRATION,
  serverLeave: SimulateScenarioKind.SIMULATE_SERVER_LEAVE,
};

app.post('/api/livekit/translate/simulate', async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_CHAOS_ENDPOINT !== '1') {
      return res.status(403).json({ error: 'Chaos endpoint disabled in production' });
    }
    if (!getLiveKitConfig()) return res.status(503).json({ error: 'LiveKit not configured' });

    const sessionId = req.body?.sessionId as string | undefined;
    const scenario = (req.body?.scenario as string | undefined) ?? 'fullReconnect';
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

    const kind = SIMULATE_SCENARIOS[scenario];
    if (kind === undefined) {
      return res.status(400).json({
        error: `Unknown scenario '${scenario}'`,
        available: Object.keys(SIMULATE_SCENARIOS),
      });
    }

    const manager = TranslationSessionManager.getInstance();
    const languages = await manager.simulateScenario(sessionId, kind);
    if (languages.length === 0) {
      return res.status(404).json({ error: `No active translator bridges for ${sessionId}` });
    }
    console.warn(`[chaos] Simulated ${scenario} on ${sessionId} for: ${languages.join(', ')}`);
    return res.json({ success: true, scenario, languages });
  } catch (error) {
    phClient.captureException(error);
    console.error('LiveKit simulate error:', error);
    return res.status(500).json({ error: 'Failed to simulate scenario' });
  }
});


app.post('/api/requestTranslatedBlocks', requireWriteKey('/api/requestTranslatedBlocks'), async (req, res) => {
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
// Writes to the persistent library on disk, so unlike the lookups above it needs a key.
app.post('/api/slideLibrary', requireWriteKey('/api/slideLibrary'), async (req, res) => {
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
app.post('/api/translateItem', requireWriteKey('/api/translateItem'), async (req, res) => {
  const slides = (req.body?.slides as string[]) ?? [];
  const requestedLanguages = (req.body?.languages as string[]) ?? [];
  const reference = (req.body?.reference as string | undefined)?.trim();
  // An existing translation from the presentation software (possibly machine-generated) —
  // grounding the model can keep where good and correct where not.
  const existingTranslation = (req.body?.existingTranslation as string | undefined)?.trim();
  // Item title (e.g. a Bible citation like "Psalm 23") — a lookup cue the slide text lacks.
  const itemTitle = (req.body?.itemTitle as string | undefined)?.trim();
  // Conversation key: the Proclaim itemId when this came from a service item (so the review
  // screen can find it by itemId), else a content hash for ad-hoc pastes.
  const itemId = (req.body?.itemId as string | undefined)?.trim();
  // The per-day doc the conversation belongs to (where the browser reads it live).
  let docId = (req.body?.docId as string | undefined)?.trim();
  if (!Array.isArray(slides) || requestedLanguages.length === 0) {
    return res.status(400).json({ ok: false, error: 'Missing slides or languages' });
  }
  // ===========================================================================
  // !!!  TEMPORARY BACK-COMPAT SHIM — DELETE ME  !!!
  // ---------------------------------------------------------------------------
  // A Proclaim client pinned to pre-#64 code (Jul 2026) doesn't send `docId`.
  // Rather than 400 that client's slide-translation calls, default to the
  // current-day doc so it keeps seeding translations. The translations flow
  // back in the HTTP response regardless; only the server-written conversation
  // map lands in this defaulted doc, which nobody watches for that old client.
  //
  // This exists ONLY to bridge one un-updatable client. Once every Proclaim
  // client is on code that sends `docId`, RESTORE the hard 400 below and remove
  // this block + `currentDayDocId()`:
  //     if (!docId) return res.status(400).json({ ok: false, error: 'Missing docId' });
  // ===========================================================================
  if (!docId) {
    docId = currentDayDocId();
    console.warn(`[translateItem] TEMPORARY SHIM: missing docId, defaulting to ${docId}. DELETE ME once all Proclaim clients send docId.`);
  }

  // Stable conversation id up front so it can tag the LLM trace (and any bible_lookup events)
  // as the agent runs — this is what makes a conversation's generations group in PostHog.
  const conversationId = conversationKey(itemId, slides);
  const observability = slideObservability(conversationId, docId, {
    itemTitle: itemTitle || undefined,
    source: 'translateItem',
  });

  const lookup = slideLibrary.toLookup();
  // Bible lookups the model made while drafting — reported to PostHog and the review UI.
  const bibleLookups: BibleToolCall[] = [];
  // The raw agent history, captured so we can persist it for review + follow-ups.
  let conversationMessages: Content[] = [];
  // Token usage across the draft's model calls (surfaced so cache hits/cost are visible).
  let usage: TokenUsage = emptyUsage();
  const translations = await translateItem({
    slides,
    languages: requestedLanguages,
    lookup,
    translate: ({ slides: sourceSlides, targets }) =>
      draftItemTranslations(geminiProvider, {
        sourceSlides,
        targets,
        referenceText: reference || undefined,
        existingTranslation: existingTranslation || undefined,
        generalContext: SLIDE_TRANSLATION_CONTEXT,
        itemTitle: itemTitle || undefined,
        model: STRONG_MODEL,
        observability,
        onToolCall: (call) => {
          bibleLookups.push(call);
          recordBibleLookup(call, conversationId, docId);
        },
        onConversation: (messages) => {
          conversationMessages = messages;
        },
        onUsage: (runUsage) => {
          usage = mergeUsage(usage, runUsage);
        },
      }),
  });

  // Persist the conversation so the review screen can show the agent's reasoning/tool calls
  // and post follow-ups. When no model call was needed (every slide already cached/reviewed),
  // seed a context-only conversation — slides + current translations + general context — so a
  // later follow-up resumes with real context instead of replying blind, without spending a
  // model call now.
  const seededMessages: Content[] = conversationMessages.length > 0
    ? conversationMessages
    : [{
        role: 'user',
        parts: [{
          text: buildSeedConversationPrompt({
            slides,
            translations,
            generalContext: SLIDE_TRANSLATION_CONTEXT,
          }),
        }],
      }];
  const conversationsMap = await slideConversations.getConversationsMap(docId);
  writeConversation(conversationsMap, {
    itemId: conversationId,
    itemTitle: itemTitle || '',
    slides,
    slidesHash: slidesHash(slides),
    languages: requestedLanguages,
    messages: seededMessages,
    status: 'idle',
    usage,
  });

  return res.json({ ok: true, translations, bibleLookups, conversationId });
});

// The review screen reads the conversation live from the `slideConversations` Y.Map in its
// own doc, so there's no GET endpoint — the writes below stream straight to watchers.

// Send a follow-up message to an item's agent and resume the loop. The model may answer in
// text and/or revise translations via set_translations; revised entries are returned for the
// browser to write into the slideTranslations Y.Map. Conversation progress (status, agent
// reasoning, tool calls) streams live via the slideConversations Y.Map.
app.post('/api/slideConversation/message', requireWriteKey('/api/slideConversation/message'), async (req, res) => {
  const itemId = (req.body?.itemId as string | undefined)?.trim();
  const text = (req.body?.text as string | undefined)?.trim();
  const docId = (req.body?.docId as string | undefined)?.trim();
  // The reviewer's current per-language drafts, index-aligned with the conversation's slides.
  // The browser holds the live state (drafts may have been hand-edited since the draft run),
  // so it sends it along; the agent needs it to make targeted `revise_translation` edits.
  const currentTranslations = (req.body?.currentTranslations as
    | Record<string, (string | null)[]>
    | undefined) ?? undefined;
  if (!itemId || !text) {
    return res.status(400).json({ ok: false, error: 'Missing itemId or text' });
  }
  if (!docId) return res.status(400).json({ ok: false, error: 'Missing docId' });

  const conversationsMap = await slideConversations.getConversationsMap(docId);
  const stored = readConversation(conversationsMap, itemId);
  if (!stored) return res.status(404).json({ ok: false, error: 'No conversation' });

  // Work on a copy; the agent appends to `messages` in place, and Yjs values must not be
  // mutated outside a set(). We re-snapshot the whole conversation as it progresses.
  const conversation = structuredClone(stored);
  conversation.messages.push({ role: 'user', parts: [{ text }] });
  conversation.status = 'running';
  writeConversation(conversationsMap, conversation);

  const bibleLanguages = conversation.languages.filter((language) => BIBLE_TRANSLATIONS[language]);
  const bibleLookups: BibleToolCall[] = [];
  // Same trace id as the initial draft so this follow-up's generations group with it.
  const observability = slideObservability(itemId, docId, { source: 'followUp' });
  try {
    const result = await runSlideTranslationAgent(geminiProvider, {
      sourceSlides: conversation.slides,
      messages: conversation.messages, // mutated in place
      model: STRONG_MODEL,
      bibleLanguages,
      currentTranslations,
      observability,
      onToolCall: (call) => {
        bibleLookups.push(call);
        recordBibleLookup(call, itemId, docId);
        // Stream the agent's progress (new tool-call/response messages) to watchers.
        writeConversation(conversationsMap, conversation);
      },
    });
    conversation.status = 'idle';
    // Fold this run's tokens into the conversation's running total (initial draft + follow-ups).
    conversation.usage = mergeUsage(conversation.usage ?? emptyUsage(), result.usage);
    writeConversation(conversationsMap, conversation);

    // Flatten revised translations for the browser to apply (auto / llm-agent provenance).
    const updatedTranslations: Array<{ language: string; sourceText: string; text: string }> = [];
    for (const [language, blocks] of Object.entries(result.translations)) {
      for (const block of blocks) {
        updatedTranslations.push({ language, sourceText: block.sourceText, text: block.translatedText });
      }
    }
    return res.json({ ok: true, conversation, updatedTranslations, bibleLookups });
  } catch (err) {
    setStatusIn(conversationsMap, itemId, 'error');
    console.error('slideConversation/message failed:', err);
    if (err instanceof Error) phClient.captureException(err);
    return res.status(500).json({ ok: false, error: 'Agent run failed' });
  }
});

// Record a reviewer's manual edit as a note in the conversation, so the next follow-up has
// that context. No agent run — the edit itself is written to Yjs/library by the browser.
app.post('/api/slideConversation/note', requireWriteKey('/api/slideConversation/note'), async (req, res) => {
  const itemId = (req.body?.itemId as string | undefined)?.trim();
  const text = (req.body?.text as string | undefined)?.trim();
  const docId = (req.body?.docId as string | undefined)?.trim();
  if (!itemId || !text) {
    return res.status(400).json({ ok: false, error: 'Missing itemId or text' });
  }
  if (!docId) return res.status(400).json({ ok: false, error: 'Missing docId' });
  const conversationsMap = await slideConversations.getConversationsMap(docId);
  const updated = appendMessageTo(conversationsMap, itemId, {
    role: 'user',
    parts: [{ text }],
  });
  if (!updated) return res.status(404).json({ ok: false, error: 'No conversation' });
  return res.json({ ok: true, conversation: updated });
});

// One-click session export: fetch a session's Y-Sweet doc as an update (no live
// websocket needed) and render everything in it — notes + translations, slides +
// their translations, and the live transcript — into a single, self-contained,
// human-readable HTML page that downloads as an attachment.
app.get('/api/session/export', async (req, res) => {
  const docId = (req.query?.doc as string | undefined)?.trim();
  if (!docId) {
    return res.status(400).json({ error: 'Missing doc query parameter' });
  }
  try {
    const update = await documentManager.getDocAsUpdate(docId);
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, update);

    const data = buildSessionExport(ydoc, docId);
    const html = renderSessionHtml(data);
    ydoc.destroy();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sessionExportFilename(docId)}"`,
    );
    return res.send(html);
  } catch (error) {
    phClient.captureException(error);
    console.error('Session export error:', error);
    return res.status(500).json({ error: 'Failed to export session' });
  }
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
app.get('/*splat', (req, res, next) => {
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

// Flush PostHog before the process exits so events queued in the 10s batch window
// aren't lost when Docker sends SIGTERM.
process.on('SIGTERM', async () => {
  await phClient.shutdown();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await phClient.shutdown();
  process.exit(0);
});
