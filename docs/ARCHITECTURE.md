# Architecture map

One page: what runs where, how data flows, and — most importantly — **who writes what into
the shared Yjs doc and what each writer's true input is**. That distinction (stimulus vs.
derived data) drives the testing/replay strategy.

## Components

```
 sound booth / stage                      server (docker compose)              external SaaS
┌────────────────────┐                  ┌──────────────────────────┐
│ Broadcaster        │── mic (WebRTC) ─▶│ LiveKit room             │
│ (BroadcastControl  │                  │   ▲            │         │
│  in a browser, OR  │                  │   │ translated │ source  │
│  the macOS Audio   │                  │   │ audio      ▼ audio   │
│  Feeder app)       │                  │ translation-bridge ──────┼──▶ Gemini Live
┌────────────────────┐                  │  (per language, spawned  │    (translate speech)
│ Proclaim Mac       │                  │   on listener demand by  │
│ proclaim_service.py│─┐                │   translation-session-   │
└────────────────────┘ │                │   manager)               │
                       │ Y-Sweet WS     ├──────────────────────────┤
┌────────────────────┐ │                │ Express server           │──▶ Gemini (block +
│ Browser clients    │ ├───────────────▶│  - Y-Sweet token auth    │     slide translation)
│  editor / viewers /│ │                │  - /api/translate        │──▶ ElevenLabs (TTS)
│  listeners         │─┘                │  - /api/translateItem    │──▶ PostHog (telemetry)
└────────────────────┘                  │  - TTS + audio cache     │
                                        ├──────────────────────────┤
                                        │ Y-Sweet (doc persistence)│
                                        └──────────────────────────┘
```

- **Browser app** (`src/`): block editor, translated/bilingual viewers, current-slide viewer,
  slide review UI, listen viewer (translated audio), live transcript, broadcast control.
  Layouts are URL-encoded (see `App.tsx`); `#editor` gates write access.
- **Express server** (`server.ts`): Y-Sweet token issuing (the auth chokepoint), translation
  endpoints, TTS with disk cache, `/api/config`; hosts the live-audio subsystem in-process.
- **live-audio** (`live-audio/`): `translation-session-manager` runs a supervisor loop that
  reconciles running `translation-bridge`s against LiveKit room presence — listeners carry a
  `listen=<lang>` participant attribute in their token, and the loop starts, recreates, or
  winds down one bridge per (session, language) to match (no refcounts or beacons). Each
  bridge subscribes to the organizer's LiveKit track (16 kHz in), streams to Gemini Live,
  publishes translated audio (24 kHz out), and writes the transcript into Yjs via
  `transcript-writer`. When a Gemini session is swapped (goaway/reconnect), input frames are
  buffered across the gap and flushed into the fresh session, so a swap costs a little
  latency rather than dropped words (always on). A **cost path** — off unless
  `LIVE_AUDIO_SILENCE_THRESHOLD_DBFS` names a level (−30 is a guess) — additionally
  suspends a bridge's Gemini socket after ~30 s below that level, reopening on the first
  non-silent frame; the LiveKit participant/track stay live so listeners never resubscribe.
  That threshold is the feature's only switch: unset, it is −Infinity, every frame reads as
  voice, and nothing can suspend. It affects only what a bridge does while nobody speaks —
  *which* bridges exist is decided independently (see the supervisor below).
- **macOS Audio Feeder** (`macos-audio-feeder/`): a native menu-bar app (Swift/SwiftUI) that
  takes one channel off the sound board and publishes it to the LiveKit room on a schedule, so
  a service doesn't depend on someone opening the browser broadcast page. It joins as the
  *same* identity that page uses (`organizer-host`), and LiveKit permits one participant per
  identity, so **the app and the browser page are mutually exclusive** — whichever connects
  last evicts the other (handled deliberately: `DisconnectPolicy`). Split into
  `AudioFeederCore` (pure logic — schedule, config, levels, channel extraction, token
  contract; `swift test`, no Xcode) and `AudioFeederApp` (CoreAudio capture, LiveKit publish,
  UI; built by an XcodeGen-generated project). Publishing spends the room's microphone, so it
  carries a write key like everything else. Its own `README.md` covers operation and
  `NOTEBOOK.md` records why it looks the way it does — read the notebook before changing
  packaging, entitlements, or the connect/retry logic.
- **proclaim_service.py**: polls Proclaim's local HTTP API (~1 s) and reads its SQLite DB,
  pushes presentations + slide status into Yjs. Internally decoupled into a **slide feed**
  (`ProclaimFeed`, the source) and **consumers** (a Yjs publisher + a translation worker),
  wired by a source-agnostic runtime — see "Testing seams". Installed as a macOS LaunchAgent
  that runs `proclaim_service_launch.sh`: every launch fast-forwards the checkout to the
  `proclaim-stable` release branch and then starts the service regardless of how the update
  went, so the machine degrades to "runs last version", never "doesn't run". The running SHA
  is announced in the `status` map (`proclaimService`).
- **Y-Sweet**: persistence and fan-out for the per-service Y.Doc (`doc-YYYY-MM-DD`).

## The Yjs doc is stimulus + response mixed together

Every writer below shares one Y.Doc per service. When recording or replaying, record each
component at its **true input boundary** — never the Yjs doc wholesale, because most of the
doc is *derived* data that the system under test will regenerate.

| Writer | Writes into Yjs | True input boundary |
|---|---|---|
| Human editor (browser) | `sourceTextBlocks` edits | Keystrokes — these *are* Yjs deltas; Yjs-level recording is correct **only** for this writer |
| `proclaim_service.py` (slide feed → Yjs publisher + translator) | `proclaimServiceOrder`, `proclaimPresentations`, `proclaimStatus`, `slideTranslations`, `status.proclaimService` | Proclaim local HTTP API responses + `PresentationManager.db` |
| translation-bridge / transcript-writer | `liveTranscriptSegments-{code}` (one utterance per entry, stamped `startedAt` + `endedAt`; the silence between utterances is derived from those, not stored) | Organizer audio track + Gemini Live responses — including *when* each delta arrived, which only the writer sees |
| Block translation manager | per-language translations, `notesTranslationCache` | Source blocks + `/api/translate` (Gemini) |
| Slide translation agent | slide translations, conversations, library | Slide texts + Gemini |

Recorded *outputs* of a component have exactly two legitimate uses: as a **stand-in** when
that component is out of the loop (simulated mode), or as a **golden reference** when it is
in the loop. Never both at once — replaying a component's output while the real component
also runs produces double-writes.

Yjs updates carry the author's `clientID`, so a recorder can partition the delta stream by
writer once each component announces its clientID (planned: via the status heartbeat map).

## Lifecycle notes that surprise people

- **Bridges are presence-driven**: the supervisor (`translation-session-manager.ts`) derives
  the desired bridge set from who is in the LiveKit room — nothing runs without a broadcaster
  (a listener waiting for the talk costs nothing; bridges start the moment the organizer
  joins), and with a broadcaster present the default/English-transcript bridge runs
  unconditionally, plus each language named by a listener's `listen` attribute. So connecting
  clients *change* system behavior — preflight checks for a *translation* must include a
  synthetic listener, and "no French audio" is often just "nobody asked for French yet." The
  English transcript is the exception and needs no listener: a talk is transcribed from the
  moment the broadcaster goes live, so the first listener to arrive gets history rather than
  a mid-sentence start. Because the loop reconciles (every ~10 s, plus pokes), bridges also
  *come back* by themselves after a server restart or a failed bridge, as long as demand
  persists. With the cost path enabled, a silent mic suspends the socket rather than tearing
  it down, so "nothing is translating" can also mean "nobody is speaking" — preflight then
  needs non-silent audio, not just a connection.
- **Doc IDs are date-anchored** (`getDocId.ts`, and the Proclaim service anchors to the
  show's scheduled date), so a service's state lives in one doc per date.
- **Editor vs viewer** is enforced server-side via Y-Sweet token scope. The `#editor` request
  states an intent; whether it is honored depends on a shared per-device write key
  (`writeAuth.ts`, [WRITE_KEYS.md](WRITE_KEYS.md)) — as does taking the microphone, and the
  endpoints that spend money. Reading needs no key, and never will: viewers are the point.
  An unauthorized editor request is *downgraded* to a read-only token rather than refused, so
  a stale key shows the session read-only instead of a blank screen mid-service. The whole
  thing defaults to `observe` mode, which records what it would have refused and refuses
  nothing — check the mode before concluding that a key is being enforced.

## Testing seams

- Pure component / Yjs-container split on the frontend (see CLAUDE.md).
- Python tests fake the Proclaim DB, Y-Sweet websocket, and provider (see `tests/helpers.py`),
  and inject scaled-down timing — the model for the TS side.
- The Proclaim writer is split at a serializable seam: a `SlideFeed` (source; `ProclaimFeed`)
  emits a complete `FeedSnapshot` each poll, and the consumers (`YjsSlidePublisher`,
  `SlideTranslator`) act on it, wired by `SlideSyncRuntime`. A fake/replayed feed drives the
  **real** consumers with no Proclaim in the loop (`tests/test_slide_seam.py`) — the
  "simulated proclaim" mode of the replay harness, in miniature. (The snapshot's single-write
  publisher also fixed #67's status/presentation desync.)
- The replay harness (tracking issue supersedes #69) extends these seams into recorded,
  shareable fixtures with per-component real/simulated switches; the `FeedSnapshot`
  `to_json`/`from_json` round-trip is the slot where recorded Proclaim output plugs in. The
  Proclaim slice of this lives in `slide_replay.py`: `proclaim_service.py --record PATH`
  wraps the live feed to append each snapshot to a JSONL stream, `--replay PATH` re-emits a
  recording as a `SlideFeed` (honoring the recorded cadence) so the unchanged runtime replays
  it against Y-Sweet, and `replay_records_through_consumers` plays a recording through the
  real consumers offline — the network-free regression test, driven by a committed synthetic
  fixture (`tests/fixtures/synthetic_service.jsonl`).
