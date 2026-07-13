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

## Failure mode 1 — the publish race (fixed earlier)

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

The early return is the bug: presence and publication are independent, and the code treats them as
one. The remedy is that **all three** of these must run unconditionally, every time:

1. subscribe to organizer audio already published at start;
2. subscribe to organizer audio published later (`TrackPublished`);
3. pipe each subscribed organizer track to the model exactly once (`TrackSubscribed`), deduped.

That is what `wireOrganizerAudioSubscription` does, and it is kept free of LiveKit types so the
publish-timing cases are unit-testable without a room.

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

On a **full** reconnect (as opposed to a *resume*), the LiveKit SDK tears down and rebuilds session
state: remote participants and their tracks come back as **new objects**. The SDK is explicit that
this happens — `RoomEvent.LocalTrackRepublished` exists precisely to tell you it auto-republished
your local tracks during one.

Three things then conspire:

1. **The old `AudioStream` ends.** Its reader returns `done: true`, and the read loop —
   `while (true) { const { done, value } = await reader.read(); if (done) break; ... }` — takes the
   `break` and **exits silently**. A bare `break` on `done` is the single most load-bearing line of
   sample code in the file, and it says nothing when the thing it is reading from dies.
2. **Nothing re-subscribes.** With `autoSubscribe: false` the bridge drives subscription itself, but
   it only ever calls `setSubscribed(true)` from the two paths above: participants present *at
   startup*, and `TrackPublished`. Neither fires for an already-published track after a reconnect.
3. **Nothing notices.** The bridge listened for `Disconnected` (which does not fire — a full
   reconnect is `Reconnecting` → `Reconnected`, internally), so `status` stayed `"active"`.

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

Attendees were unaffected because the browser SDK uses `autoSubscribe: true` and re-subscribes
itself. Only the bridges, with hand-rolled subscription, had no path back.

## The remedy: three independent layers

Any *one* of the first two would have prevented this outage; the second alone would have healed it
without a redeploy. They are deliberately redundant, because the lesson of having now fixed this
class of bug twice is that the next trigger will be one nobody enumerated.

### 1. Correctness — rebuild the subscription when the session is rebuilt

Treat `Reconnected` as "your remote-track state was just invalidated," because it was. Re-run the
subscription decision from scratch: re-enumerate the room's current participants and re-subscribe
to organizer audio. This requires the subscription helper to take a **`() => participants`
callback rather than a snapshot iterable** — a snapshot captured at startup describes a room that
no longer exists.

Likewise, treat the read loop's `done` as an event, not an exit: log it, report it, forget the dead
track so a fresh `TrackSubscribed` for it can pipe again, and re-subscribe.

The pipe-once dedupe must therefore be **invalidatable**. Deduping on track identity forever is
correct for redundant `TrackSubscribed` deliveries and wrong for a track that has since died.

### 2. Detection — a stall watchdog

Correctness fixes the trigger you understand. The watchdog covers the ones you do not.

Audio arrives on a fixed 100ms cadence, so its *absence* is unambiguous and cheap to check: if the
bridge is `active` and has received audio before but none for ~15s, it is deaf. Report it, then
attempt recovery (forget the tracks, re-subscribe), on a cooldown so a genuinely muted speaker
produces one telemetry event rather than a retry storm.

This is the layer that converts "dead until a human redeploys" into "self-heals in fifteen
seconds," and it does so **without needing to know why**.

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

## Upstreaming notes

For anyone carrying these back to the Gemini Live + LiveKit sample, the three defects are, in
order of severity:

1. **The subscription is built once and never rebuilt.** A sample that sets `autoSubscribe: false`
   and hand-drives `setSubscribed(true)` *must* re-drive it on `Reconnected`, or it is guaranteed to
   go permanently deaf on the first full reconnect. This is not an edge case; it is what happens to
   every long-running session eventually.
2. **`if (done) break;` swallows the death of the input.** The read loop's terminal condition is a
   real event and should be surfaced to the caller.
3. **Deafness is unobservable.** There is no liveness signal on the audio path, so a bridge that has
   stopped receiving is indistinguishable from a speaker who has stopped talking — to the code, to
   the logs, and to the operator.

The general principle, worth stating plainly because it generalizes past this sample: **a component
that bridges two networks must treat "my input went quiet" as a first-class, monitored state.** The
sample treats it as the absence of an event, which is exactly the thing you cannot alert on.
