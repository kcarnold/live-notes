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
- [ ] `/status` shows the Proclaim service's SHA/branch, and no "update pending" flag
      (if it flags one, restart the service — restarting is what applies an update).

## 4. Live audio translation

- [ ] Start broadcasting (mic level meter moves).
- [ ] On the viewer device, join Listen for one language **after** broadcast started:
      transcript deltas appear, translated audio plays after tapping play.
- [ ] **The #69 race / waiting room**: start the Listen client *first*, then start
      broadcasting. Before the broadcast the supervisor runs no bridges (the listener just
      waits); within ~10 s of the organizer joining, the translator appears and the
      transcript flows. The listener's amber "Restarting translation…" state may flash
      briefly — it must go green without a reload.
- [ ] **Pause indicator**: stop speaking for ~15 s, then resume. A dashed "Pause · Ns" rule
      appears between the two utterances, with a plausible duration. Normal gaps between
      sentences must *not* produce one. (A bridge outage also shows up here — that's intended,
      but it means a divider isn't proof the speaker was silent.)
- [ ] Stop and restart the broadcaster mid-session; transcript resumes without a reload.
- [ ] **Server-restart recovery**: with a listener connected and the speaker talking,
      restart the Node server. Within ~15 s the supervisor rebuilds the bridges from room
      presence and the transcript resumes — no reload, no re-tap on any client. The resumed
      speech must start a *new* utterance with a pause divider covering the outage, not get
      glued onto the sentence that was in flight when the server went down.
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

- [ ] With **no listener yet**, the English transcript still flows — the default translator
      runs whenever the broadcaster is present, whatever the cost path is set to.

Cost path (only when `LIVE_AUDIO_SILENCE_THRESHOLD_DBFS` names a level — off by default; the
startup log line reports which):

- [ ] **Silence suspend/resume**: stay silent >30 s (server logs "Suspending Gemini after…");
      then speak — the first words resume translation ("resuming Gemini after…") without the
      listener resubscribing.
- [ ] With the threshold **unset**, the opposite: stay silent >30 s and confirm no
      "Suspending Gemini" line appears, with the mic both open-but-quiet and fully muted.

## 5. TTS (text-to-speech on translated notes)

- [ ] Tap a translated line: audio plays. Tap again: cancels.
- [ ] Auto-speak advances line to line.

## 6. Write keys

Skip entirely when `WRITE_KEYS` is unset (the server logs `write authorization is off`).

- [ ] Server startup logs show the expected mode and key labels:
      `[write-auth] mode=observe keys=[proclaim, booth, …]`.
- [ ] Provision the editor device once with `#editor&key=THEKEY`: the key disappears from
      the address bar, and `#editor` survives.
- [ ] Reload that device with a plain `#editor` URL (no key): still an editor.
- [ ] `/status` reports "Key installed" and the last four characters of the right key.
- [ ] On a device with no key (or a wrong one), an `#editor` URL prompts for a key, and
      pasting a valid one grants edit access without a reload. Cancelling continues
      read-only — and does *not* prompt again on the next reconnect.
- [ ] Server logs show `key=<label> → ok` for `/api/ys-auth` from each real device —
      the editor browsers, the Proclaim Mac (`Write key: configured` in its own log), and
      the feeder. Anything logged as `key=none` is a device that `enforce` would lock out.
- [ ] A viewer URL (no `#editor`, no key) still connects, and TTS still plays — viewers must
      never need a key.

**In `enforce` mode only** (skip while in `observe`):

- [ ] An editor URL on an unprovisioned device shows the read-only banner and no edit
      controls, rather than a blank or broken page.
- [ ] Broadcast from an unprovisioned device fails with a visible error, not silence.

## 7. Teardown sanity

- [ ] Close all listener tabs; confirm the supervisor winds the translator bots down within
      ~2 minutes (60 s demand grace + a reconcile tick; watch for `[SessionManager] Supervisor
      stopping …` in server logs) — no orphaned Gemini sessions burning quota. (With the cost
      path enabled, closing listeners is not enough: the default translator stays up for the
      transcript until the broadcaster also leaves.)
