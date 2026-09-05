# The current session

Which Y-Sweet doc everything is reading and writing — and who gets to decide.

Fixes [#111](https://github.com/kcarnold/live-notes/issues/111).

## What went wrong

Last week's slideshow went on air briefly, then this week's. The Proclaim service saw the
older deck first, took its `DateGiven`, and pointed itself at *last week's* doc — where it
then wrote the whole service. Its own log said:

```
Starting slide sync for doc: doc-2026-08-09
```

The server's auth log said otherwise:

```
Auth request: doc=doc-2026-08-02 isEditor=true granted=full
```

The bug was not the date arithmetic. It was that three parties each computed "the current
session" from their own private rule and nothing ever compared the answers:

| party | rule |
|---|---|
| browsers | `?doc=` else wall-clock **local** today |
| Proclaim service | arg/env, else the on-air show's `DateGiven`, else today |
| LiveKit rooms | whatever `sessionId` a browser happened to pass |
| macOS audio feeder | override, else `doc-YYYY-MM-DD` from the booth Mac's clock |

The feeder is listed here after the fact: it was missed in the original fix, because it is
Swift and nothing in the npm or uv toolchain touches it.

Two of those disagreeing is invisible in every log anyone reads, and the symptom — an empty
slide pane — is identical to the service simply being down.

## The fix

The current session is now a **fact the server owns and everyone reads**, not a formula
everyone re-derives.

```
                         ┌──────────────────────────────┐
   browsers ────read────▶│  GET  /api/session/current   │
   Proclaim ──propose───▶│  POST /api/session/propose   │──▶ SessionRegistry
   operator ────pin─────▶│  POST/DELETE /api/session/pin│      (persisted JSON)
                         └──────────────────────────────┘
```

Precedence, highest first:

1. **`?doc=` on a browser / `doc_id` arg on the service.** An explicit override, never
   resolved away. It is the escape hatch when the server's answer is wrong, and how the
   record/replay harness targets a throwaway doc.
2. **An operator pin**, set from `/status`. Beats every other party until it lapses.
3. **A proposal** from the Proclaim service — "a show dated X is on air" — if the server
   accepts it.
4. **The date**, evaluated on the server in `SESSION_TIMEZONE`.

### The service proposes; it does not decide

`POST /api/session/propose` takes the show's own date and answers with the doc to use plus
an `outcome`:

| outcome | meaning |
|---|---|
| `accepted` | recorded; it is now the current session |
| `pinned` | an operator pin is in force — follow it |
| `stale` | the show is dated **before today**; use today's doc instead |
| `no-date` | nothing to propose; the answer is whatever it already was |

`stale` is the original bug, refused at the door. A proposal that can reach into the past is
the same bug with a nicer interface. A date *today or later* is accepted, which preserves
the pre-staging case `DateGiven` was added for — and now it works for browsers too, which it
never did before.

The service logs the answer it *got*, including when that differs from what it proposed. The
absence of that line is what made #111 invisible for a whole service.

It also re-asks every `session_recheck_interval` (60s) while connected, and ends the session
when the answer moves — the doc itself is still only ever changed by the reconnect path, with
nothing connected. A failed re-check is ignored rather than dropping a working connection:
the doc question keeps for a minute, the service does not.

An answer that isn't usable — no `docId`, or a proxy's HTML error page returned with a 200 —
raises `SessionResolutionError`, which the reconnect loop catches like any other connection
problem. It must not escape: the launch wrapper's invariant is "runs last version", never
"doesn't run".

### Pins lapse on their own

A pin (or a proposal) expires at the next 4am in `SESSION_TIMEZONE`, but never sooner than
six hours after it was set — so pinning at 2am for an early setup doesn't evaporate at 4am.
A forgotten pin therefore cannot silently capture next week's service, which is the failure
that would make this cure worse than the disease. `/status` clears one manually too.

### Timezone

The date formula moved from the *congregation's* clock (a browser) to the server's, and a
container's clock is UTC. Set **`SESSION_TIMEZONE`** to the church's IANA zone or a
Sunday-evening service in the Americas gets filed under Monday. The server logs the zone it
resolved at boot.

### No client-side fallback

Clients do not keep a copy of the date formula to fall back on. The same server hands out
the app bundle and the Y-Sweet token, so a client that cannot reach it has nothing to fall
back *to*; a browser shows "can't reach the server" (with the `?doc=` escape hatch spelled
out) and the Proclaim service lets the failure flow into its existing reconnect backoff.
Guessing in that moment is exactly the defect #111 is about.

### Disagreement is now visible

Every writable Y-Sweet token, every proposal, and every broadcaster room join is recorded as
a **writer sighting** (`GET /api/session/writers`, 15-minute TTL). `/status` lists them and
flags any writer on a doc other than the current one in amber. "The service is down" and
"the service is writing to last week's doc" no longer look identical. The Proclaim service
also reports its `docId` in the shared `status` map alongside its version.

## Operating it

**Something is on the wrong doc mid-service.** Open `/status` on a phone (the device needs a
write key), read the "Current session" section — it names the doc, where that came from, and
who is writing where — type the right doc id, press **Pin**. Every browser picks it up on
reload. The Proclaim service re-asks about once a minute while it is connected, so it moves
on its own within a minute or so: it ends the session, resolves the doc again, and reconnects
to the pinned one. (Resolving only at session start would have meant never, in practice — a
show that is on air for an hour never goes off air, which is the whole half-hour the pin is
supposed to rescue.)

The macOS audio feeder re-asks on the same one-minute cadence and rebuilds its pipeline into
the pinned room, so the microphone follows the pin rather than being left behind in the doc
everyone else just moved off.

**Pre-staging next Sunday on a Thursday.** Open the deck in Proclaim as before. Its
`DateGiven` is in the future, so the server accepts the proposal and review screens follow
it without anyone typing a doc id.

**Targeting a throwaway doc.** `?doc=doc-scratch` in the browser,
`uv run proclaim_service.py doc-scratch` for the service. Unchanged.

### The audio feeder asks too

The macOS audio feeder (`macos-audio-feeder/`) was the fourth party, and the one nobody is
watching: it runs unattended on a schedule, and it named its LiveKit room from the booth
Mac's own clock. That was survivable while the date was the only rule — the booth clock *is*
the congregation's clock, so it usually agreed. The pin is what made it a defect: an operator
pinning from a pew moved the notes, the slides, the transcripts and every listener, while the
feeder kept publishing the actual audio into the old room. That splits a service in half,
which is worse than the whole service being filed under the wrong date.

It now resolves through `GET /api/session/current` like everyone else
([`SessionClient.swift`](../macos-audio-feeder/Sources/AudioFeederCore/SessionClient.swift)),
with the same precedence as the browser: the settings window's doc-id field is the `?doc=`
equivalent and wins without a round trip; otherwise the server's answer; never a local date.
The answer *expires* after 60s rather than being held for the run: it re-asks while
publishing, and rebuilds the capture→publish pipeline when the answer moves. Expiry rather
than "forget when the run ends" because the feeder only notices a run ending if it is awake
for it — a Mac asleep between two Sunday windows would otherwise wake up inside the next
service still holding last week's answer. A failed re-check behind a live pipeline is
ignored: a stale doc answer costs a minute, dropping the pipeline costs the broadcast.

The "no client-side fallback" rule costs the feeder nothing, which is worth stating: the same
server issues its LiveKit token, so a server it cannot reach is a run that could not have
started anyway. It reports which server it cannot reach and retries on its existing backoff.

## Where the code lives

| file | role |
|---|---|
| [`sessionRegistry.ts`](../sessionRegistry.ts) | the policy: precedence, expiry, writer sightings, persistence |
| [`sessionRoutes.ts`](../sessionRoutes.ts) | the express routes (split out so they're testable) |
| [`src/sessionCurrent.ts`](../src/sessionCurrent.ts) | shared shape + the one copy of the date formula |
| [`src/getDocId.ts`](../src/getDocId.ts) | browser side: resolve once, then answer synchronously |
| [`src/SessionGate.tsx`](../src/SessionGate.tsx) | the gate that mounts nothing until the answer is in |
| [`session_client.py`](../session_client.py) | the Proclaim service's wire to `/api/session/propose` |
| [`slide_sync_runtime.py`](../slide_sync_runtime.py) | resolves before connecting, re-checks while connected |
| [`SessionClient.swift`](../macos-audio-feeder/Sources/AudioFeederCore/SessionClient.swift) | the macOS feeder's wire to `/api/session/current` |
