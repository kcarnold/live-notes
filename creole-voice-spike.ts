#!/usr/bin/env node
/**
 * Haitian Creole voice spike — which TTS engine can actually speak Creole?
 *
 * ## The question
 *
 * Creole is already a first-class *notes* translation language (`configAtoms.ts`), but
 * `VOICE_CONFIG` in server.ts has entries only for French and Spanish, so `/api/tts`
 * returns 400 for it: Creole notes are translated today and cannot be spoken. Fixing
 * that means picking an engine — and **no vendor documents a Haitian Creole voice**:
 *
 *   - ElevenLabs v3 publishes 74 languages; Creole is not among them.
 *   - OpenAI's speech API advertises "50+ languages" and doesn't name Creole either.
 *   - Google Chirp 3 HD (see the `switch-tts-chirp-3-hd` branch) almost certainly not.
 *
 * What makes it worth trying anyway is that these endpoints take **no language
 * parameter**. You hand them text and they speak it. So "unsupported" may mean "we
 * don't promise anything" rather than "it will refuse" — and OpenAI's realtime model
 * demonstrably produces Creole, since that is what ChatGPT's voice mode does.
 *
 * That is an empirical question about how something *sounds*, which no test can answer.
 * Hence a spike: synthesize the same passage through every candidate, then have a
 * Creole speaker listen and rank them.
 *
 * ## Why this is worth doing on the notes path rather than live audio
 *
 * Notes TTS is text-driven and cacheable, so the audio exists *before* the service and
 * can be reviewed. Live speech-to-speech (the `ht` bridge on this branch) cannot be
 * reviewed even in principle — you find out what it said when the congregation does.
 * See issues #81 and #88.
 *
 * ## Usage
 *
 *   node creole-voice-spike.ts                        # all available engines, sample text
 *   node creole-voice-spike.ts --file notes-ht.txt    # real Creole notes (preferred)
 *   node creole-voice-spike.ts --text "Bonjou tout moun."
 *   node creole-voice-spike.ts --engines openai-tts,openai-realtime
 *   node creole-voice-spike.ts --mode translate --file notes-en.txt
 *   node creole-voice-spike.ts --help
 *
 * Modes:
 *   read      (default) Creole text in, spoken Creole out — the notes-TTS question.
 *   translate English text in, spoken Creole out — asks whether one realtime hop can
 *             replace "Gemini translates, then something speaks it". Only meaningful
 *             for the realtime engine; the plain TTS endpoints just read what you give
 *             them, so they are skipped in this mode.
 *
 * Reads keys from `.env` (same as the server): OPENAI_API_KEY, ELEVENLABS_API_KEY.
 * An engine whose key is missing is skipped and reported as skipped — never silently.
 *
 * Output: `creole-voice-spike/` containing one audio file per engine, an `index.html`
 * that plays them side by side (open it in a browser and hand it to a Creole speaker),
 * and `results.json` with what each engine did, including how long it took.
 *
 * **A vendor refusing is a result, not a crash.** Every engine's failure is captured
 * and reported so the run always produces a comparison, however partial.
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const OUT_DIR = 'creole-voice-spike';

/**
 * Default passage. Deliberately liturgical and widely published (the opening of the
 * Lord's Prayer and John 3:16 in standard Haitian Creole) rather than composed here, so
 * a listener can judge pronunciation against text they already know — and so this file
 * isn't inventing Creole.
 *
 * It also contains the two things I expect engines to get wrong, which is the point of
 * including them: a spoken scripture reference with numbers ("chapit twa, vèsè sèz")
 * and proper names ("Jan", "Bondye").
 *
 * **Replace this for the real evaluation.** Use actual Creole notes from a past service
 * (`sessionExport.ts` can pull them) — the register of real notes is what matters, and a
 * native speaker should confirm whatever text you test with.
 */
const SAMPLE_CREOLE = [
  'Papa nou ki nan syèl la, se pou yo toujou respekte non ou.',
  'Bonjou tout moun. Jodi a, n ap li nan liv Jan, chapit twa, vèsè sèz.',
  'Paske Bondye te renmen lemonn lan tèlman, li bay sèl Pitit li a.',
  'Mèsi anpil. Ann priye ansanm.',
].join('\n');

/** English source for `--mode translate`, roughly parallel to the Creole sample. */
const SAMPLE_ENGLISH = [
  'Good morning, everyone. Today we are reading from the book of John, chapter three, verse sixteen.',
  'For God so loved the world that he gave his only Son.',
  'Thank you. Let us pray together.',
].join('\n');

interface Options {
  text: string;
  /** Path to read the passage from, if given; overrides `text`. */
  file: string | null;
  mode: 'read' | 'translate';
  engines: string[] | null;
  outDir: string;
  voice: string | null;
  realtimeModel: string;
  ttsModel: string;
}

interface EngineResult {
  id: string;
  label: string;
  status: 'ok' | 'skipped' | 'failed';
  file?: string;
  bytes?: number;
  elapsedMs?: number;
  /** What the model reported it said, when it tells us (realtime transcript). */
  reportedText?: string;
  detail?: string;
}

/** One candidate engine. `run` returns the audio and the extension to save it under. */
interface Engine {
  id: string;
  label: string;
  /** Why this engine can't run, or null if it can. */
  unavailable(opts: Options): string | null;
  /** Whether this engine is meaningful in the given mode. */
  supportsMode(mode: Options['mode']): boolean;
  run(opts: Options): Promise<{ audio: Buffer; ext: string; reportedText?: string }>;
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/**
 * OpenAI's plain speech endpoint. The cheapest possible answer: a normal HTTP request,
 * mp3 back, cacheable exactly like the ElevenLabs path already is — so if this sounds
 * acceptable, wiring Creole into `/api/tts` is a small change and nothing else about the
 * notes pipeline moves.
 */
const openaiTts: Engine = {
  id: 'openai-tts',
  label: 'OpenAI speech endpoint (mp3, cacheable)',
  unavailable: () => (process.env.OPENAI_API_KEY ? null : 'OPENAI_API_KEY not set'),
  // It reads what you give it; it has no translate step to exercise.
  supportsMode: (mode) => mode === 'read',
  async run(opts) {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.ttsModel,
        voice: opts.voice ?? 'marin',
        input: opts.text,
        // No language parameter exists — that absence is the whole reason this might work.
        instructions:
          'Read the text aloud in Haitian Creole with natural Haitian pronunciation. ' +
          'Read it exactly as written; do not translate it or add anything.',
        response_format: 'mp3',
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }
    return { audio: Buffer.from(await response.arrayBuffer()), ext: 'mp3' };
  },
};

/**
 * The realtime model used as a TTS engine: text in, audio out, no microphone involved.
 * Heavier than the endpoint above (a websocket per utterance, PCM to wrap, no built-in
 * caching) but it is the one engine we have positive evidence for on Creole, and in
 * `--mode translate` it can do the translation itself.
 */
const openaiRealtime: Engine = {
  id: 'openai-realtime',
  label: 'OpenAI Realtime, text in → audio out (wav)',
  unavailable: () => (process.env.OPENAI_API_KEY ? null : 'OPENAI_API_KEY not set'),
  supportsMode: () => true,
  async run(opts) {
    const instructions =
      opts.mode === 'translate'
        ? 'You are a simultaneous interpreter. Translate the text you are given into ' +
          'Haitian Creole and speak only the translation. Never answer, comment, or add anything.'
        : 'Read the text you are given aloud in Haitian Creole, exactly as written, with ' +
          'natural Haitian pronunciation. Do not translate it, summarize it, comment on it, ' +
          'or add anything at all.';

    const chunks: Buffer[] = [];
    let reportedText = '';

    await withSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(opts.realtimeModel)}`,
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } },
      async (ws, done) => {
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'realtime',
              output_modalities: ['audio'],
              instructions,
              audio: { output: { format: { type: 'audio/pcm', rate: 24000 }, voice: opts.voice ?? 'marin' } },
            },
          })
        );

        ws.on('message', (raw: WebSocket.Data) => {
          const message = JSON.parse(raw.toString()) as Record<string, unknown>;
          const type = typeof message.type === 'string' ? message.type : '';
          const delta = typeof message.delta === 'string' ? message.delta : '';

          switch (type) {
            // Configured — now hand it the text and ask for one response.
            case 'session.updated':
              ws.send(
                JSON.stringify({
                  type: 'conversation.item.create',
                  item: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: opts.text }],
                  },
                })
              );
              ws.send(JSON.stringify({ type: 'response.create' }));
              break;

            case 'response.output_audio.delta':
            case 'response.audio.delta':
              if (delta) chunks.push(Buffer.from(delta, 'base64'));
              break;

            // What the model believes it said — worth capturing, because in translate
            // mode it is the translation, and in read mode a divergence from the input
            // is the tell that it "helpfully" rewrote the text.
            case 'response.output_audio_transcript.delta':
            case 'response.audio_transcript.delta':
              reportedText += delta;
              break;

            case 'response.done':
              done(null);
              break;

            case 'error': {
              const error = (message.error ?? {}) as { message?: string; code?: string };
              done(new Error(`${error.code ?? 'error'}: ${error.message ?? 'unknown'}`));
              break;
            }
          }
        });
      }
    );

    if (chunks.length === 0) throw new Error('session produced no audio');
    return {
      audio: pcm16ToWav(Buffer.concat(chunks), 24000),
      ext: 'wav',
      reportedText: reportedText.trim() || undefined,
    };
  },
};

/**
 * The incumbent, included as a control rather than a candidate. ElevenLabs doesn't list
 * Creole, so the useful question isn't "does it work" but "what does it *do*" — read it
 * as French (partially intelligible, given the shared vocabulary), mangle it, or refuse?
 * The answer decides whether Creole needs a different engine or merely a voice setting,
 * and it sets the quality bar the alternatives are judged against, since this is what
 * French and Spanish listeners already hear.
 */
const elevenlabs: Engine = {
  id: 'elevenlabs',
  label: 'ElevenLabs multilingual v2 (control — Creole not on its language list)',
  unavailable: () => (process.env.ELEVENLABS_API_KEY ? null : 'ELEVENLABS_API_KEY not set'),
  supportsMode: (mode) => mode === 'read',
  async run(opts) {
    const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
    const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
    // Same voice and model server.ts uses for French, so this is a fair read of what
    // the existing pipeline would produce if Creole were simply added to VOICE_CONFIG.
    const stream = await client.textToSpeech.convert(opts.voice ?? 'JBFqnCBsd6RMkjVDRZzb', {
      text: opts.text,
      modelId: 'eleven_multilingual_v2',
      voiceSettings: { speed: 0.9 },
    });

    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return { audio: Buffer.concat(chunks), ext: 'mp3' };
  },
};

const ENGINES: Engine[] = [openaiTts, openaiRealtime, elevenlabs];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a websocket exchange to completion, with a hard timeout so a stalled vendor can't
 * hang the spike. `register` wires the message handlers and calls `done` to finish.
 */
async function withSocket(
  url: string,
  options: WebSocket.ClientOptions,
  register: (ws: WebSocket, done: (err: Error | null) => void) => Promise<void>,
  timeoutMs = 90_000
): Promise<void> {
  const ws = new WebSocket(url, options);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      const done = (err: Error | null) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      ws.on('error', (err) => done(err instanceof Error ? err : new Error(String(err))));
      ws.on('close', (code, reason) =>
        done(new Error(`socket closed before finishing: ${code} ${reason.toString()}`))
      );
      ws.on('open', () => {
        void register(ws, done).catch(done);
      });
    });
  } finally {
    ws.close();
  }
}

/** Wrap raw PCM16 mono in a RIFF/WAVE header so the file is double-clickable. */
function pcm16ToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function parseArgs(argv: string[]): Options | 'help' {
  const opts: Options = {
    text: '',
    file: null,
    mode: 'read',
    engines: null,
    outDir: OUT_DIR,
    voice: null,
    realtimeModel: process.env.LIVE_AUDIO_OPENAI_MODEL || 'gpt-realtime-2.1',
    ttsModel: 'gpt-4o-mini-tts',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--help':
      case '-h':
        return 'help';
      case '--text':
        opts.text = value();
        break;
      case '--file':
        opts.file = value();
        break;
      case '--mode': {
        const mode = value();
        if (mode !== 'read' && mode !== 'translate') throw new Error(`unknown mode: ${mode}`);
        opts.mode = mode;
        break;
      }
      case '--engines':
        opts.engines = value()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--out':
        opts.outDir = value();
        break;
      case '--voice':
        opts.voice = value();
        break;
      case '--realtime-model':
        opts.realtimeModel = value();
        break;
      case '--tts-model':
        opts.ttsModel = value();
        break;
      default:
        throw new Error(`unknown argument: ${arg} (try --help)`);
    }
  }

  return opts;
}

const HELP = `
Haitian Creole voice spike — synthesize one passage through every candidate engine
so a Creole speaker can listen and rank them.

  node creole-voice-spike.ts [options]

  --file PATH            read the passage from a file (preferred: real Creole notes)
  --text "..."           read the passage from the command line
  --mode read|translate  read (default): Creole in, Creole speech out
                         translate: English in, Creole speech out (realtime only)
  --engines a,b          limit to these engines (${ENGINES.map((e) => e.id).join(', ')})
  --voice ID             voice name (OpenAI) or voice id (ElevenLabs)
  --realtime-model ID    default gpt-realtime-2.1
  --tts-model ID         default gpt-4o-mini-tts
  --out DIR              output directory (default ${OUT_DIR})

Keys come from .env: OPENAI_API_KEY, ELEVENLABS_API_KEY. Missing keys skip an engine.
Writes audio + index.html + results.json; open index.html to compare them.
`.trim();

/** A tiny local player, so the person judging this doesn't have to be a developer. */
function buildIndexHtml(opts: Options, results: EngineResult[]): string {
  const rows = results
    .map((r) => {
      if (r.status !== 'ok') {
        return `<section class="engine bad">
      <h2>${escapeHtml(r.label)}</h2>
      <p class="status">${r.status.toUpperCase()}: ${escapeHtml(r.detail ?? '')}</p>
    </section>`;
      }
      const reported = r.reportedText
        ? `<p class="reported"><strong>Model reported saying:</strong> ${escapeHtml(r.reportedText)}</p>`
        : '';
      return `<section class="engine">
      <h2>${escapeHtml(r.label)}</h2>
      <audio controls preload="none" src="${escapeHtml(r.file ?? '')}"></audio>
      <p class="meta">${r.bytes ?? 0} bytes · ${r.elapsedMs ?? 0} ms · <code>${escapeHtml(r.id)}</code></p>
      ${reported}
    </section>`;
    })
    .join('\n    ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Haitian Creole voice spike</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem;
           line-height: 1.5; color: #111; }
    @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; }
      .engine { border-color: #444; } pre { background: #1c1c1c; } }
    h1 { font-size: 1.4rem; }
    pre { white-space: pre-wrap; background: #f4f4f4; padding: .75rem; border-radius: .4rem; }
    .engine { border: 1px solid #ddd; border-radius: .5rem; padding: .75rem 1rem; margin: 1rem 0; }
    .engine.bad { opacity: .65; }
    audio { width: 100%; margin: .5rem 0; }
    .meta, .status { font-size: .85rem; opacity: .75; margin: .25rem 0 0; }
    .reported { font-size: .9rem; }
    .ask { border-left: 3px solid #888; padding-left: .8rem; }
  </style>
</head>
<body>
  <h1>Haitian Creole voice spike</h1>
  <p>Mode: <code>${escapeHtml(opts.mode)}</code>. Passage given to each engine:</p>
  <pre>${escapeHtml(opts.text)}</pre>

  <div class="ask">
    <p><strong>What to listen for</strong> (please note answers per engine):</p>
    <ol>
      <li>Is it Haitian Creole, or French/English with Creole words?</li>
      <li>Is the pronunciation natural enough for a congregation to follow easily?</li>
      <li>Are the proper names and the scripture reference (chapter and verse numbers) right?</li>
      <li>Would you rather hear this than nothing? (That is the real bar today.)</li>
    </ol>
  </div>

  ${rows}
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let parsed: Options | 'help';
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (parsed === 'help') {
    console.log(HELP);
    return;
  }

  const opts = parsed;
  // --file wins over --text, and both win over the built-in sample.
  if (opts.file) opts.text = (await fs.readFile(opts.file, 'utf8')).trim();
  if (!opts.text) opts.text = opts.mode === 'translate' ? SAMPLE_ENGLISH : SAMPLE_CREOLE;

  const selected = ENGINES.filter((e) => !opts.engines || opts.engines.includes(e.id));
  if (opts.engines) {
    for (const id of opts.engines) {
      if (!ENGINES.some((e) => e.id === id)) console.warn(`! unknown engine "${id}" ignored`);
    }
  }

  await fs.mkdir(opts.outDir, { recursive: true });
  console.log(`Mode: ${opts.mode}\nPassage (${opts.text.length} chars):\n${opts.text}\n`);

  const results: EngineResult[] = [];
  for (const engine of selected) {
    const base: EngineResult = { id: engine.id, label: engine.label, status: 'skipped' };

    if (!engine.supportsMode(opts.mode)) {
      results.push({ ...base, detail: `not meaningful in --mode ${opts.mode}` });
      console.log(`- ${engine.id}: skipped (not meaningful in --mode ${opts.mode})`);
      continue;
    }
    const blocked = engine.unavailable(opts);
    if (blocked) {
      results.push({ ...base, detail: blocked });
      console.log(`- ${engine.id}: skipped (${blocked})`);
      continue;
    }

    const startedAt = Date.now();
    try {
      const { audio, ext, reportedText } = await engine.run(opts);
      const filename = `${engine.id}-${opts.mode}.${ext}`;
      await fs.writeFile(path.join(opts.outDir, filename), audio);
      results.push({
        ...base,
        status: 'ok',
        file: filename,
        bytes: audio.length,
        elapsedMs: Date.now() - startedAt,
        reportedText,
      });
      console.log(`✓ ${engine.id}: ${filename} (${audio.length} bytes, ${Date.now() - startedAt} ms)`);
      if (reportedText) console.log(`    reported: ${reportedText}`);
    } catch (error) {
      // A vendor refusing Creole is the finding, not a crash. Record and carry on.
      const detail = (error as Error).message;
      results.push({ ...base, status: 'failed', elapsedMs: Date.now() - startedAt, detail });
      console.log(`✗ ${engine.id}: FAILED — ${detail}`);
    }
  }

  const indexPath = path.join(opts.outDir, 'index.html');
  await fs.writeFile(indexPath, buildIndexHtml(opts, results));
  await fs.writeFile(
    path.join(opts.outDir, 'results.json'),
    JSON.stringify({ mode: opts.mode, text: opts.text, ranAt: new Date().toISOString(), results }, null, 2)
  );

  const ok = results.filter((r) => r.status === 'ok').length;
  console.log(`\n${ok}/${results.length} engine(s) produced audio.`);
  console.log(`Open ${indexPath} and listen — ideally with a Creole speaker.`);
  if (ok === 0) console.log('No audio at all: check keys and the failure messages above.');
}

// Keep the exit code honest so this can be dropped into a script later.
main().catch((error) => {
  console.error(error);
  process.exit(1);
});

