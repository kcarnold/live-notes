# Keeping the translation bridge alive

How [`live-audio/translation-bridge.ts`](../live-audio/translation-bridge.ts) survives the two
networks it straddles, and why the obvious sample-code shape does not.

This subsystem started as Google sample code for Gemini Live + LiveKit. Sample code models the
happy path: join a room, subscribe to a track, stream it to the model, publish the result. That
shape is correct for a demo that runs for two minutes, and it has now caused two production
outages in services that run for ninety. **The notes here are written so they can be upstreamed** —
each fix is stated as a failure mode, an invariant, and a minimal remedy, not as a diff against
our code.

## The invariant

> A bridge whose `status` is `"active"` is receiving organizer audio.

Every outage so far has been a violation of exactly this: the bridge is *up* — joined to the room,
publishing its translated-audio track, holding a healthy Gemini socket — and simply not being fed.
Nothing throws. Nothing disconnects. It is **active but deaf**, and it stays that way until a human
notices the silence and restarts the process.

Deafness is the failure mode to design against, because it is the one the happy-path shape cannot
see. A crash is loud and gets restarted. A bridge that is merely *not receiving* looks, from every
signal the sample code emits, exactly like a bridge whose speaker has paused.

## Failure mode 1 — the publish race

The organizer is already in the room when the bridge starts, but their mic track lands a beat later
(the usual `join` / `getUserMedia` race). The sample's shape is:

```ts
// Sample-code shape. Broken.
const organizer = findOrganizer(room);
if (organizer) {
  subscribeToTheirAudio(organizer);   // nothing published yet → subscribes to nothing
  return;                             // ← and now we never listen for the late publish
}
room.on(TrackPublished, subscribe);   // unreachable in the racing case
```

The early return is the bug: **presence and publication are independent**, and the code treats them
as one. Note which way round this is — the organizer joining *after* the bridge was the path that
worked, because it fell through to the listener. The broken case is the organizer being *present but
not yet publishing*.

What makes that narrow window reachable in production is that bridges are spawned on demand when a
**listener** subscribes to a language ([translation-session-manager.ts](../live-audio/translation-session-manager.ts)).
A listener landing on the page during the organizer's join/mic gap spawns a bridge directly into the
race — and since the session manager keeps that bridge alive, it stays deaf for everyone on that
language until the process restarts.

## Failure mode 2 — the full reconnect (2026-07-12)

Fixing the race left a sibling case uncovered: the track subscribes and pipes correctly at startup,
and then **the subscription dies mid-session and nothing rebuilds it.**

### What happened

Mid-service, all translation stopped — no translated audio, no transcripts — while attendees
listening to the original audio noticed nothing. It stayed dead for about six minutes until the
server was redeployed.

Reconstructed from the LiveKit session events and the server log:

| Time (2026-07-12) | Event |
| --- | --- |
| 10:03:08 / 10:09:39 | `translator-fr` / `translator-es` join; each subscribes and pipes organizer audio once |
| 10:34:53 | **All five participants `resumed`** — a LiveKit-side signal disruption |
| 10:35:09–10:35:11 | Second wave; attendees drop (`SIGNAL_CLOSE`) and rejoin |
| **10:35:23** | **Both bridges' `framesSent` counters freeze — audio input stops** |
| 10:35:24 | Both bridges **full-reconnect**: `left (CLIENT_INITIATED)` → `joining` → `active`; stale sessions reaped as `DUPLICATE_IDENTITY` |
| 10:35–10:41 | Bridges sit `active` and deaf: Gemini sockets keep cycling their `goAway` swaps against silence |
| 10:41:37 | Redeploy; fresh bridges join, the deaf ones are reaped |

The two bridges started six minutes apart and had entirely different frame counts, yet both went
deaf in the same second. Audio frames are 100ms each, so the frozen counters are a clock:

- `fr`: 19,350 frames × 100ms = 1935s from 10:03:08 → **10:35:23**
- `es`: 15,449 frames × 100ms = 1545s from 10:09:39 → **10:35:23**

which is precisely when LiveKit recorded the bridges' full reconnect.

### The mechanism

A LiveKit **full** reconnect (as opposed to a *resume*) is documented as being
[identical to everyone leaving the room and coming back](https://docs.livekit.io/intro/basics/connect/).
The published sequence is:

1. `ParticipantDisconnected` for other participants
2. `LocalTrackUnpublished` for any published local tracks
3. `Reconnecting`
4. *(the full reconnect)*
5. `Reconnected`
6. **`ParticipantConnected` for everyone currently in the room**
7. Local tracks are republished → `LocalTrackPublished`

Read step 6 carefully, and note what is *absent*: remote participants come back carrying their
existing publications, and **no `TrackPublished` fires for them**. There was no new publication —
just a participant we're being told about for the first time (again).

That is the whole outage. Three things conspire:

1. **The old `AudioStream` ends.** Its reader returns `done: true`, and the read loop —
   `while (true) { const { done, value } = await reader.read(); if (done) break; ... }` — takes the
   `break` and **exits silently**. A bare `break` on `done` is the single most load-bearing line of
   sample code in the file, and it says nothing when the thing it is reading from dies.
2. **Nothing re-subscribes.** With `autoSubscribe: false` the bridge drove subscription itself, but
   only from two triggers: participants present *at startup*, and `TrackPublished`. Per the sequence
   above, **neither fires after a full reconnect.**
3. **Nothing notices.** The bridge listened for `Disconnected`, which does not fire (a full reconnect
   is `Reconnecting` → `Reconnected`, internally), so `status` stayed `"active"`.

The server log is a photograph of all three: `Joined room` appears exactly once per bridge, so the
reconnect happened entirely *inside* the SDK, invisible to bridge code; `Subscribed to organizer
audio track` appears exactly once per bridge, at startup, so nothing ever re-piped; and there are
**zero** `Audio stream error`, `Dropped N input audio frames`, and `Disconnected from room` lines —
the stream did not error, frames were not dropped, the room did not disconnect. The read loop just
ended, quietly, and no code was watching.

> The Gemini `goAway` reconnect machinery ran perfectly throughout — four clean make-before-break
> swaps on `fr`, three on `es`, all against a silent input. It dominates the log and is a red
> herring. **A subsystem that reconnects diligently to the wrong side of the pipe will happily
> reconnect its way through an outage.**

### Why the attendees were fine

Not because they subscribe differently — attendees also run `autoSubscribe: false` and drive
`setSubscribed` by hand. They survived because of *when* they do it
([ListenViewer.tsx](../src/ListenViewer.tsx)):

```ts
// Re-running on participant changes is essential for late joiners — the track is
// already published, so no per-track event fires for us.
useEffect(() => {
  for (const participant of remoteParticipants) { /* …setSubscribed(wanted) */ }
}, [room, translatorIdentity, isOriginal, remoteParticipants, audioOn]);
```

`useRemoteParticipants()` re-renders on participant changes, and step 6 above fires
`ParticipantConnected` for everyone — so the effect re-runs and re-drives subscription. The frontend
had **continuously reconciled** subscription; the bridge had a **once-at-startup** one. Same SDK,
same options, opposite outcome. The comment in that effect is the lesson the bridge hadn't learned.

## The remedy: reconcile, then watch

### 1. Correctness — reconcile against current state, don't react to events

The fix is not "also handle `Reconnected`." That would patch this trigger and leave the next one.
Both outages are the same mistake in different clothes: **subscription was decided once, from an
event, and the decision then drifted from reality.**

So don't store a decision. Keep one idempotent function —

```ts
reconcileOrganizerAudio({ organizerIdentity, participants, isAudio })  // subscribe to what's there now
```

— that drives the room's *current* state toward "we are subscribed to the organizer's audio", and
run it from every trigger that could plausibly matter: startup, `ParticipantConnected`,
`TrackPublished`, `Reconnected`, and the watchdog below.

This is convergent rather than event-exhaustive, and that distinction is the entire point. **No
single trigger is load-bearing.** Getting one wrong, or failing to anticipate one, costs nothing so
long as some other trigger still fires. Enumerating LiveKit's event semantics correctly is a game
we lost twice; this stops playing it.

Piping stays separate from subscribing: a track may be delivered to us more than once and must reach
the model exactly once, so `TrackSubscribed` dedupes on track identity. That dedupe is cleared when a
stream ends — deduping forever is right for redundant deliveries and wrong for a track that has died.

And treat the read loop's `done` as an event, not an exit: log it, report it, drop the track from the
dedupe, reconcile.

### 2. Detection — a stall watchdog

Correctness fixes the triggers you understand. The watchdog covers the ones you do not.

Audio arrives on a fixed 100ms cadence, so its *absence* is unambiguous and cheap to check: if the
bridge is `active` and has received audio before but none for ~15s, it is deaf. Report it and
reconcile, on a cooldown so a genuinely muted speaker produces one telemetry event rather than a
retry storm.

This is the layer that converts "dead until a human redeploys" into "self-heals in fifteen seconds",
and it does so **without needing to know why**. If a future failure is one reconcile can't fix, the
next escalation is to tear down and recreate the bridge — which is exactly what the manual redeploy
did.

Note the seam: liveness is measured where organizer audio *enters* the bridge, not where it reaches
the model. A stalled Gemini socket is a different failure with its own (working) recovery; conflating
them would have the watchdog papering over the wrong pipe.

### 3. Observability — log the lifecycle you depend on

The reason this incident had to be reconstructed from frame-count arithmetic is that the bridge
subscribed to three room events and depended on nine. At minimum, log and report: `Reconnecting`,
`Reconnected`, `Disconnected` (**with its `DisconnectReason`** — the sample discards it),
`TrackUnsubscribed`, `TrackSubscriptionFailed`, and `ParticipantDisconnected`.

None of these change behavior. All of them turn the next incident from an archaeology exercise into
a line in the log.

## How this is tested

Both outages lived in the **wiring**, not the logic. The subscribe decision was always correct; it
just wasn't re-run. That has a sharp consequence for testing: a suite that only exercises pure
helpers would have gone green, untouched, straight through both outages. Unit tests on
`reconcileOrganizerAudio` prove it does the right thing *when called*. They cannot prove it gets
called, and "gets called" is the entire bug.

So [translation-bridge.e2e.test.ts](../live-audio/translation-bridge.e2e.test.ts) drives the real
`TranslationBridge` against fakes of the only two things it talks to — a LiveKit room and a Gemini
websocket — and asserts on the single thing a listener cares about: **is audio still reaching
Gemini?** No test inspects internal state. Each one breaks the input the way production broke it and
checks that frames resume.

The load-bearing part of the fake is that `FakeRoom.fullReconnect()` reproduces LiveKit's documented
sequence *exactly*, including the gap that caused the outage: `ParticipantConnected` for everyone
already present, and **no `TrackPublished`** for their existing publications. Get that detail wrong
and the test passes against broken code.

Which is not hypothetical — **verify that a regression test can actually fail.** Run it against the
code from before the fix (`git show <pre-fix-sha>:live-audio/translation-bridge.ts`) and confirm it
goes red. Three of the five e2e tests fail against `9ff8822`, the code that was in production during
the outage; the two that pass are the happy path and outage 1's race, which that commit already
fixed. A regression test that has never been observed to fail is a guess about the bug, not a test
of it.

Coverage is deliberately split by what each layer can prove:

| Test | Proves |
| --- | --- |
| happy path | the pipeline works at all |
| late mic publish | outage 1 stays fixed |
| full reconnect | outage 2 stays fixed |
| input dies with **no room event at all** | the watchdog catches the unknown-unknown |
| **only one trigger fires** | the convergence claim — no single trigger is load-bearing |

That last one is the one worth stealing. It asserts the *property* the design rests on, rather than
the behavior of any particular event, so it keeps holding even if LiveKit changes which events it
emits — which is exactly the thing we have now been wrong about twice.

## Upstreaming notes

For anyone carrying these back to the Gemini Live + LiveKit sample, the three defects are, in
order of severity:

1. **Subscription is decided from events, not reconciled against state.** A sample that sets
   `autoSubscribe: false` and hand-drives `setSubscribed(true)` from "organizer is here" and
   "organizer published" is guaranteed to go permanently deaf on the first full reconnect, because
   LiveKit's documented reconnect sequence fires *neither* of those. Reconcile from the current
   participant list on every plausible trigger instead — then no single trigger is load-bearing, and
   the sample stops depending on a reading of event semantics that most users will get wrong.
   (Setting `autoSubscribe: true` also fixes it, by making the server own re-subscription. Either is
   fine; deciding once from an event is not.)
2. **`if (done) break;` swallows the death of the input.** The read loop's terminal condition is a
   real event and should be surfaced to the caller.
3. **Deafness is unobservable.** There is no liveness signal on the audio path, so a bridge that has
   stopped receiving is indistinguishable from a speaker who has stopped talking — to the code, to
   the logs, and to the operator.

The general principle, worth stating plainly because it generalizes past this sample: **a component
that bridges two networks must treat "my input went quiet" as a first-class, monitored state.** The
sample treats it as the absence of an event, which is exactly the thing you cannot alert on.
