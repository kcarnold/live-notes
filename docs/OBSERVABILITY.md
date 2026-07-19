# Observability notes — live-audio backend status & liveness

Notes on what's worth observing about the live-audio translation backend and where to pull it
from. This is a map of existing signals plus gaps worth filling — not a spec for any particular
dashboard. Written while landing the goaway/reconnect and silence-gating work
([live-audio/translation-bridge.ts](../live-audio/translation-bridge.ts),
[translation-session-manager.ts](../live-audio/translation-session-manager.ts)), which surfaced
most of these signals.

## The four sources

1. **PostHog events** — per-bridge lifecycle telemetry. Emitted via the injected `recordEvent`
   sink, captured with `distinctId = sessionId` and every property also tagged with `sessionId`,
   `targetLanguage`, and `identity` (`translator-<code>`), so a talk's whole history groups by
   session. Best for *history and rates* ("how often do sessions drop", "how long are the gaps").
   Off when telemetry is unconfigured (dev/tests); logs still print each event.
2. **In-process manager/bridge state** — live, authoritative for "what is running right now",
   but in-memory only (single server instance; rebuilt from presence after a restart by the
   supervisor). Exposed by `GET /api/livekit/translate/status?sessionId=…` →
   `getActiveTranslations()` (`{ language, translatorIdentity, status, subscriberCount,
   health }[]`, where `health` is the bridge's composite snapshot: per-leg Gemini state,
   last input/output frame ages, reconnect count, gap-buffer depth).
3. **LiveKit RoomService** — source of truth for *room/participant presence* (who's actually
   connected: `organizer-*`, `translator-*`, listeners; their track publications, and each
   listener's `listen=<lang>` attribute — the demand signal). Pull with
   `RoomServiceClient.listParticipants(sessionId)` against the `LIVEKIT_URL` (ws→http). The
   supervisor polls this every 10 s; it does not depend on any client-side beacon.
4. **Y-Sweet / Yjs transcript doc** — the `liveTranscript-<code>` Y.Text per language is the
   product itself; its steady growth is a good end-to-end "translation is actually flowing"
   heartbeat that no single component can fake (written by `transcript-writer.ts`).

Server logs are the fifth, lowest-friction source: bridges log `[TranslationBridge:<lang>] …`
and the manager logs `[SessionManager] …`, including every telemetry event, suspend/resume, and
supervisor start/stop decision.

## PostHog events (from `translation-bridge.ts`)

| Event | Meaning | Key properties |
|---|---|---|
| `gemini_session_setup_complete` | A Gemini socket finished setup and is serving. | `isReconnect`, `trigger`, `setupLatencyMs`, `totalReconnects` |
| `gemini_session_closed` | A socket closed (any role). | `code`, `reason`, `role`, `wasActive`, `wasPending`, `socketLifetimeMs`, `framesSent/Received` |
| `gemini_goaway` | Server warned it will terminate the session. | `timeLeftRaw`, `timeLeftMs`, `sessionAgeMs` |
| `gemini_reconnect_attempt` | Opening a replacement socket. | `trigger` (`goaway`\|`close`\|`resume`), `attempt` |
| `gemini_reconnect_retry` | A replacement died before setup; backing off. | `trigger`, `attempt`, `backoffMs` |
| `gemini_audio_gap` | Translated audio resumed after a >2 s output gap. | `gapMs` — the user-visible "hang" |
| `gemini_input_flushed` | Buffered input replayed into a fresh session after a swap. | `frames`, `bufferedMs` — **> 0 means make-before-break overlap failed and we caught up instead of dropping** |
| `gemini_input_dropped` | Input lost because the buffer overflowed (long outage). | `frames` — genuine loss |
| `gemini_suspended_silence` | Cost path: socket torn down after sustained silence. | `silentMs`, `framesSent/Received` |
| `gemini_resumed_voice` | Cost path: socket reopened on returning speech. | `silentMs` |
| `gemini_session_resumption_update` | Whether the translate model offered a resume handle (not yet used). | `resumable`, `hasHandle` |

Server-level exceptions go through `phClient.captureException(...)` in
[server.ts](../server.ts) (token issue, translate start, unsubscribe, etc.).

## Questions → where to look

- **Is a talk live and translating right now?** LiveKit `listParticipants` (organizer + a
  `translator-*` present) *and* `liveTranscript-*` still growing. Bridge `status` alone can read
  `active` while deaf, so pair it with transcript growth.
- **How reliable are session swaps?** `gemini_goaway` → `gemini_session_setup_complete`
  (`trigger: goaway`) latency, and whether `gemini_input_flushed.bufferedMs` / `gemini_audio_gap`
  spike around them. Frequent nonzero `bufferedMs` = the overlap is routinely losing the race.
- **Are we dropping audio?** `gemini_input_dropped` (buffer overflow) and `gemini_audio_gap`
  (output hang). Both should be rare and short.
- **Is the cost path behaving?** Rates of `gemini_suspended_silence` / `gemini_resumed_voice`
  and the `silentMs` distribution; cross-check that suspends don't correlate with lost transcript.
- **Who's paying for what?** `getActiveTranslations()` (`subscriberCount` per language, stamped
  by the supervisor from `listen` attributes) + LiveKit listener counts; a `translator-*` with
  0 listeners that isn't the default bridge should be within its 60 s stop grace, or is a bug.
- **Is the supervisor converging?** `supervisor_bridge_started` / `supervisor_bridge_stopped` /
  `supervisor_bridge_start_failed` events (distinctId = sessionId). A start/stop cycle repeating
  for one language means demand is flapping or a bridge can't hold; `start_failed` repeating
  means LiveKit/Gemini won't accept the bridge at all.

## Gaps worth filling (not yet exposed)

The status endpoint now returns each bridge's `health` snapshot (`status`, per-leg `gemini`
state, `lastInputFrameAt`/`lastOutputFrameAt`, `reconnects`, `bufferedFrames`). Still cheap and
worth surfacing:

- Per bridge: `framesSentToGemini` / `framesReceivedFromGemini`, `lastVoiceAt` /
  `sessionConnectedAt` ages, `framesDroppedWhileDown`.
- Server: whether the cost path is enabled and whether LiveKit is configured, so a dashboard can
  explain why behavior differs between environments.
- A cheap **liveness heartbeat**: "frames received from Gemini in the last N s" per active bridge
  distinguishes "active" from "active but silent/stuck" without waiting for the 2 s `gemini_audio_gap`
  threshold. Consider a periodic gauge rather than only edge events.

Because in-process state is per-instance and lost on restart, anything meant for alerting should be
mirrored to PostHog (or another external sink) as periodic gauges, not just the edge events above.
