# Architecture map

One page: what runs where, how data flows, and — most importantly — **who writes what into
the shared Yjs doc and what each writer's true input is**. That distinction (stimulus vs.
derived data) drives the testing/replay strategy.

## Components

```
 sound booth / stage                      server (docker compose)              external SaaS
┌────────────────────┐                  ┌──────────────────────────┐
│ Broadcaster        │── mic (WebRTC) ─▶│ LiveKit room             │
│ (BroadcastControl, │                  │   ▲            │         │
│  future macOS      │                  │   │ translated │ source  │
│  ingest service)   │                  │   │ audio      ▼ audio   │
└────────────────────┘                  │ translation-bridge ──────┼──▶ Gemini Live
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
- **live-audio** (`live-audio/`): `translation-session-manager` spawns one
  `translation-bridge` per (session, language) when a listener wants it and reaps idle ones;
  each bridge subscribes to the organizer's LiveKit track (16 kHz in), streams to Gemini
  Live, publishes translated audio (24 kHz out), and writes the transcript into Yjs via
  `transcript-writer`.
- **proclaim_service.py**: polls Proclaim's local HTTP API (~1 s) and reads its SQLite DB,
  pushes presentations + slide status into Yjs. Installed as a macOS LaunchAgent.
- **Y-Sweet**: persistence and fan-out for the per-service Y.Doc (`doc-YYYY-MM-DD`).

## The Yjs doc is stimulus + response mixed together

Every writer below shares one Y.Doc per service. When recording or replaying, record each
component at its **true input boundary** — never the Yjs doc wholesale, because most of the
doc is *derived* data that the system under test will regenerate.

| Writer | Writes into Yjs | True input boundary |
|---|---|---|
| Human editor (browser) | `sourceTextBlocks` edits | Keystrokes — these *are* Yjs deltas; Yjs-level recording is correct **only** for this writer |
| `proclaim_service.py` | `proclaimPresentations`, `proclaimStatus` | Proclaim local HTTP API responses + `PresentationManager.db` |
| translation-bridge / transcript-writer | live transcript | Organizer audio track + Gemini Live responses |
| Block translation manager | per-language translations, `notesTranslationCache` | Source blocks + `/api/translate` (Gemini) |
| Slide translation agent | slide translations, conversations, library | Slide texts + Gemini |

Recorded *outputs* of a component have exactly two legitimate uses: as a **stand-in** when
that component is out of the loop (simulated mode), or as a **golden reference** when it is
in the loop. Never both at once — replaying a component's output while the real component
also runs produces double-writes.

Yjs updates carry the author's `clientID`, so a recorder can partition the delta stream by
writer once each component announces its clientID (planned: via the status heartbeat map).

## Lifecycle notes that surprise people

- **Bridges are demand-driven**: a translation bridge exists only while the session has at
  least one human listener AND a broadcaster (`translation-session-manager.ts`). Connecting
  clients therefore *changes* system behavior — preflight checks must include a synthetic
  listener, and "nothing is translating" is often just "nobody is listening yet."
- **Doc IDs are date-anchored** (`getDocId.ts`, and the Proclaim service anchors to the
  show's scheduled date), so a service's state lives in one doc per date.
- **Editor vs viewer** is enforced server-side via Y-Sweet token scope, keyed off the
  `#editor` request — there is currently no other auth.

## Testing seams

- Pure component / Yjs-container split on the frontend (see CLAUDE.md).
- Python tests fake the Proclaim DB, Y-Sweet websocket, and provider, and scale timing
  constants via the `fast_timing` fixture (`tests/`) — the model for the TS side.
- The replay harness (tracking issue supersedes #69) extends these seams into recorded,
  shareable fixtures with per-component real/simulated switches.
