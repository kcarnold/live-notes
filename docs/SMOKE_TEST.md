# Pre-service smoke test

A ~10-minute manual checklist covering the critical Sunday path. Two purposes:

1. **Before a service** (or after deploying): run the whole thing.
2. **Merge-queue batching**: merge everything CI-green, then run this checklist **once over
   the batch** instead of once per PR. Each PR should say in its description which sections
   below it touches ("Blast radius: §3, §5"); if a PR touches none, it can merge on green CI
   alone.

Until the replay harness lands, this checklist is the integration test. Keep it current: if
an incident happens that this list would not have caught, add a line.

## Setup

- [ ] Deployed build is the intended SHA (`docker compose logs` banner / deploy script output).
- [ ] Open the editor URL (`/...#editor`) on one device, a viewer URL on a second device
      (ideally a phone on cellular, not the LAN).

## 1. Collaboration & editor

- [ ] Type in the block editor; text appears on the second device within ~1 s.
- [ ] Enter/Backspace/Tab block operations behave; no duplicate or orphaned blocks.
- [ ] Viewer device has no edit affordances (read-only token).

## 2. Block translation

- [ ] Trigger translation for at least one language; translated text appears on the viewer.
- [ ] Edit one line, retranslate: only the changed line churns (cache hit on the rest).

## 3. Proclaim sync

- [ ] Proclaim service running (LaunchAgent) and pointed at today's doc.
- [ ] Advance a slide in Proclaim; current-slide view updates on both devices within ~2 s.
- [ ] Slide translations show for the on-air item; review screen loads its conversation.

## 4. Live audio translation

- [ ] Start broadcasting (mic level meter moves).
- [ ] On the viewer device, join Listen for one language **after** broadcast started:
      transcript deltas appear, translated audio plays after tapping play.
- [ ] **The #69 race**: start the Listen client *first*, then start broadcasting — bridge
      must still pick up the source audio (transcript flows).
- [ ] Stop and restart the broadcaster mid-session; transcript resumes without a reload.
- [ ] **The LiveKit full reconnect** (the 2026-07-12 outage — see
      [live-audio-resilience.md](live-audio-resilience.md)). With a bridge running and the
      speaker talking, force the reconnect that once deafened every translator for six
      minutes:

      curl -X POST localhost:8000/api/livekit/translate/simulate \
        -H 'content-type: application/json' \
        -d '{"sessionId":"doc-YYYY-MM-DD","scenario":"fullReconnect"}'

      Translated audio and transcript must resume within a few seconds. In the server log:
      `LiveKit reconnected`, then `organizer_audio_reconciled` with `trigger: "reconnected"`.
      A silent bridge that still reports `active` is the exact failure this is checking for —
      it looks healthy from every other signal.

      Do this rather than waiting: a full reconnect is the SDK's escalation when a resume
      fails, so it can't be provoked by running longer. `scenario` also accepts
      `signalReconnect`, `nodeFailure`, `migration`, `serverLeave`.

## 5. TTS (text-to-speech on translated notes)

- [ ] Tap a translated line: audio plays. Tap again: cancels.
- [ ] Auto-speak advances line to line.

## 6. Teardown sanity

- [ ] Close all listener tabs; confirm translator bots get reaped (server logs) — no
      orphaned Gemini sessions burning quota.
