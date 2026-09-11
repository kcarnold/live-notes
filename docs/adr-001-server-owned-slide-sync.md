# ADR-001: The server owns slide publishing and translation; the Proclaim service pushes snapshots

**Status:** Proposed
**Date:** 2026-09-11
**Deciders:** Ken Arnold

## Context

The Proclaim service ([proclaim_service.py](../proclaim_service.py)) runs on the Proclaim
Mac and today has two jobs that have nothing to do with Proclaim:

1. It is a **Yjs writer**. It gets a Y-Sweet token, opens a websocket, runs a pycrdt
   `Provider`, and writes `proclaimServiceOrder` / `proclaimPresentations` /
   `proclaimStatus` / `status.proclaimService` into the session doc
   ([slide_sync_runtime.py](../slide_sync_runtime.py), [yjs_publisher.py](../yjs_publisher.py)).
2. It **decides when to spend a model call**. A background worker reads the doc's
   `slideTranslations` map as a cache, and on a miss calls the server's `/api/translateItem`
   and seeds the result back into the doc ([slide_translator.py](../slide_translator.py)).

Both jobs carry the full weight of being a CRDT client on a remote machine: connection
lifecycle (lazy connect, ping, silent-drop detection, reconnect with backoff, off-air
disconnect), the server-owned session question (#111: propose a date, obey the answer,
re-ask mid-service so an operator pin reaches it, recreate the Doc on a change), and the
sync semantics of writing into a doc that already has content.

The forcing incident: a rehearsal on 2026-09-10. The operator pinned the previous Sunday's
doc, ran the service on a laptop, and went on air. The service re-translated the active item
even though the doc already held every translation. Cause: pycrdt's `Provider` returns before
the server's initial sync (SYNC_STEP2) has arrived — it has no `synced` signal
([y-crdt/pycrdt#347](https://github.com/y-crdt/pycrdt/issues/347)) — so the translator's first
cache lookup ran against an empty replica. The same window applies to any process restart
mid-service (launchd, an update). A fix now exists (a `SyncedChannel` that flags the first
STEP2, [slide_sync_runtime.py](../slide_sync_runtime.py)), and it is the *third* time this
lesson has been learned in this repo: [serverDoc.ts](../serverDoc.ts) records that the two
TypeScript server-side writers had also drifted on exactly this point.

The deeper problem is not the missing event. It is that a client makes a check-then-act
decision ("is it in the shared map? if not, pay for it") against replicated state — the one
thing a CRDT explicitly does not provide. It is only as correct as the replica is fresh and
only as safe as there being exactly one such client. The rehearsal violated both: a stale
replica *and* a second service instance. Two instances (the church Mac and a laptop) would
each translate, and would race each other's writes — including against `reviewed` entries,
which Yjs settles by client id, not by status.

The server already has every ingredient the service is reimplementing in Python: a synced
server-side doc connection per session ([serverDoc.ts](../serverDoc.ts),
[slideConversationStore.ts](../slideConversationStore.ts)), the reviewed-translation library,
the Gemini drafting agent, the session registry that decides the doc, and writer sightings for
`/status`. The service's `FeedSnapshot` ([slide_feed.py](../slide_feed.py)) is already a
self-contained, JSON-round-trippable *full* state, designed that way for record/replay (#70).
The seam is already cut; the consumers are just on the wrong side of it.

## Decision

The Proclaim service becomes a **snapshot pusher**: it polls Proclaim, builds a
`FeedSnapshot`, and `POST`s it to the Express server. It has no Yjs dependency.

The server **owns everything downstream of the snapshot**: resolving which doc the session
is (inline, via the existing registry), publishing the slide maps into that doc through its
synced server-side connection, deciding what to translate ahead and when, writing
`slideTranslations`, and announcing the service's status. `/api/translateItem` stays as the
drafting primitive; the translate-ahead worker that calls it moves in-process and consults the
library, the synced doc, and an in-flight set before spending anything.

### Wire contract (sketch)

```
POST /api/proclaim/snapshot        X-Write-Key required
{
  "snapshot":  <FeedSnapshot.to_json()>,      // full state, never a delta; carries seq
  "proposal":  { "sessionDate": "2026-09-13" | null },
  "service":   { "instance", "host", "gitSha", "gitBranch", "updateChannel",
                 "channelSha", "updatePending", "startedAt" }
}
→ 200 { "docId": "...", "source": "pin" | "proposal" | "date",
        "outcome": "accepted" | "stale" | "pinned" | "no-date",
        "active": true | false }          // is this sender the session's slide source?
```

- *Who* is sending is the write key's label ([writeAuth.ts](../writeAuth.ts)) — the identity
  the device already has, not a new field to configure. `instance` is a per-process nonce so
  a restart of the same device is distinguishable from a second device with the same key.
- `active: false` means "received, not applied": the server heard a source it is not
  currently following (see *Source selection* below). The service logs it and keeps posting,
  so it is ready the moment the policy picks it.
- Snapshots are full state, so a lost, duplicated, or retried POST is harmless; `seq` (per
  instance) lets the server drop reordered ones.
- The POST *is* the writer sighting and the heartbeat. `/status` shows "last snapshot *n*s
  ago" instead of inferring liveness from token issuance.
- Cadence: send when the snapshot differs from the last one sent, plus a heartbeat every
  ~10 s. On-air status changes (a slide advance) are a full snapshot too — tens of KB on the
  LAN is nothing, and one shape is simpler than a status-only fast path.
- Off air: the service keeps posting (off-air snapshots, at the slow cadence). The server has
  no connection to drop; it just stops writing. The 60 s off-air-disconnect grace disappears.

### Source selection: one policy for every feed

Two sources for one feed is not a Proclaim problem. The live-audio path has it too: two
broadcasters in a LiveKit room (a booth feeder and a laptop, or a reconnect's ghost) both
publish, and the only rule today is "the first one that declares a language wins"
([translation-session-manager.ts](../live-audio/translation-session-manager.ts),
`resolveSourceLanguage`) — a rule about the *language*, with nothing choosing the *audio*.
The rehearsal that forced this ADR had two Proclaim sources for the same reason a demo has two
broadcasters: a laptop stood in for the installed device without the installed device knowing.

The resolution is the one the current-session question already got in #111 — the server
owns the fact, clients declare and obey — applied per feed:

1. **Clients declare who they are.** They already do: the write key's label is the device
   (`proclaim-mac`, `audio-feeder`, `kens-laptop`). A snapshot POST carries it implicitly; a
   LiveKit token is minted by the server, which stamps the same label onto the participant.
   No client ever decides whether it is *the* source.
2. **The server applies a default policy** per feed, in one module shared by the slide route
   and the audio supervisor: the **designated** label for that feed is followed while it is
   alive; any other source is accepted only when the designated one has gone silent (no
   heartbeat / no published track for a failover window, ~30 s); with no designation, the
   first source seen is followed, with the same failover. Designation is deployment config
   (`SLIDE_SOURCE=proclaim-mac`, `AUDIO_SOURCE=audio-feeder`), because "which device is the
   real one" is a fact about the church, not about a session.
3. **An operator can override it** from `/status`, the way a doc pin overrides the date:
   "follow `kens-laptop` for slides this session." It is recorded in the session registry next
   to the pin, lapses at the same 4am, and shows on `/status` with who set it. This is the
   control the rehearsal needed — and the one that lets a laptop rescue a wedged booth device
   without an SSH session.

What "following" means per feed: for slides, only the followed source's snapshots are applied
(the others get `active: false`); for audio, the supervisor's bridges subscribe to the
followed organizer's track, and `resolveSourceLanguage` reads that participant's `speaks`
rather than the first one it finds. `/status` shows every source it has heard from, which is
followed, and why (`designated` | `first-seen` | `failover` | `pinned`) — so "the service is
down" and "the service is posting but not being followed" look different, which is the same
distinction #111's writer sightings exist to make.

The server also keeps **what each source is currently saying**, not just that it spoke. For
slides that is the last snapshot per source — every source's snapshot is received whether or
not it is followed, so this is one map and no extra traffic — rendered on `/status` as
"*proclaim-mac*: Amazing Grace, slide 3/7, 2 s ago — followed" beside "*kens-laptop*:
Announcements, slide 1/4, 1 s ago". The override control sits on that list, so an operator
chooses a source by pointing at the one showing the right slide rather than by remembering a
label. For audio the equivalent is what the supervisor can already see from presence —
publishing a track or not, and the declared `speaks` — which is enough to tell a live feeder
from a ghost; a level meter per organizer would be more work and is not part of this.

The audio half is not on this ADR's critical path — the supervisor change is separate work —
but the policy module and the `/status` control are built once, for both.

## Options Considered

### Option A: Keep the Python writer; keep patching it

Merge the `SyncedChannel` fix and stop there.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Unchanged (high): two CRDT-writer implementations, one in a language whose Yjs library lacks `synced` |
| Cost | Zero now; each new lifecycle bug costs a rehearsal to find |
| Correctness | Fixes freshness, not the check-then-act; two instances still double-spend and race |
| Team familiarity | High — it's the current code |

**Pros:** Nothing moves; the fix is small and tested.
**Cons:** Leaves the spend decision on a client. Leaves a third copy of "wait for sync before
you set a map key" in the repo, in the language least equipped to express it. Every #111-style
change (pins, doc rollover) still has to be implemented twice, in TS and Python.

### Option B: Server owns translation only

`/api/translateItem` consults the session doc's `slideTranslations` (through the synced
server doc) before drafting. The service keeps publishing slides via Yjs but its cache check
becomes an optimization rather than the decision.

| Dimension | Assessment |
|-----------|------------|
| Complexity | Slightly lower: the spend decision is in one place |
| Cost | Small, contained change to `translateItem`'s `lookup` |
| Correctness | Fixes double-spend; still two Yjs writers to `slideTranslations` (service seeds, server drafts) unless the seed also moves |
| Team familiarity | High |

**Pros:** Cheap; can ship this month; fixes the money problem.
**Cons:** Keeps the whole Python connection runtime and the session client. The service still
needs `synced` for its *publishing* writes (the coin-flip in `serverDoc.ts`'s docstring),
still re-implements pin handling, still carries pycrdt and httpx_ws. Halfway.

### Option C: Server owns publishing and translation; service pushes snapshots (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest in *kinds*: the Python side loses every failure mode with "sync", "concurrent set", "client id", "recreated doc", or "silent websocket drop" in it |
| Cost | ~720 lines of Python source and ~1,000 of tests deleted; ~250 lines of TS added (publisher, worker, route) with the Python tests as their spec; one migration Sunday |
| Correctness | Single writer for the slide maps; single decider for spend; two service instances become a one-line server policy instead of two interleaving CRDT writers |
| Team familiarity | The TS pieces already exist (`serverDoc`, `SlideConversationStore`, the registry); the port is mechanical |

**Pros:** The service becomes what it is: a Proclaim adapter. Liveness becomes explicit.
Source selection has somewhere to live. Replay becomes "POST the recorded lines." `SLIDE_TRANSLATION_LANGUAGES` moves to the server,
next to the frontend config it has to match. Pins and doc rollover are handled in exactly one
codebase.
**Cons:** One more HTTP hop (tens of ms against a 0.5 s poll). The server now holds the
Proclaim state (last snapshot per session) — fine for one deployment, one doc a day. Needs a
one-Sunday overlap where both paths exist.

## Trade-off Analysis

The real trade is *where the state machine lives*. Option A keeps it on the machine that is
hardest to observe and update (a Mac in a booth, updated by a launchd fast-forward), in the
language with the weaker Yjs client. Option C puts it in the container that already runs the
other server-side writers, has the synced doc connection, can be redeployed in a minute, and
whose logs are on `/status`.

What Option C gives up is the direct path: today, if Express were down but Y-Sweet up, the
service could in principle keep writing. It cannot in practice — #111 made the server the
only source of the doc id and the token, deliberately. There is no resilience being traded
away, only an appearance of one.

Option B is the correct hot-fix if C slips past a service that matters; it is not a
destination.

## Consequences

**Easier**
- One writer per map; no client ever needs `synced` on this path again.
- The money question ("should this item be drafted?") has one answer, computed next to the
  library and the doc it needs, with an in-flight set for free.
- `/status` shows the service's heartbeat and version from the POST, not from a status-map
  entry the service may or may not have managed to write.
- The replay harness (#70) simplifies: recording stays on the service (the snapshot is the
  boundary); replaying is a script that POSTs JSONL, or the server accepting one directly.
- Installing the service on a second machine for a demo is safe by construction.

**Harder / new**
- Source selection becomes real state the server has to keep (who has been heard from, who
  is followed, the failover clock, the operator override), for two feeds. It is small, it
  lives beside the pin it mirrors, and it replaces an *implicit* policy (whoever wrote last
  into the CRDT; whichever organizer the bridge happened to subscribe to) with an explicit,
  visible one.
- The server holds a small amount of Proclaim state in memory per session doc. On a server
  restart the next snapshot restores it; the service must keep posting through a 502.
- Off-air semantics move: "service is posting off-air snapshots" and "service is gone" are
  now distinguished by heartbeat age, which `/status` has to show.

**Revisit**
- Whether `POST /api/session/propose` survives as a standalone route once the proposal rides
  the snapshot (keep it through the overlap; the audio feeder does not use it).
- The `SyncedChannel` fix is correct for the interim and is deleted with the runtime.
- pycrdt#347: worth a comment with the real-world case and the workaround, but nothing here
  waits on it.

## Action Items

1. [ ] Server: a source-selection module shared by both feeds — designated label per feed
       from env, first-seen fallback, failover on silence, operator override stored in the
       session registry with pin-style expiry, last-seen-state per source; `POST
       /api/session/source` + the `/status` list (what each source shows, which is followed,
       why) with the override on it. Unit-tested like
       [sessionRegistry.test.ts](../sessionRegistry.test.ts).
2. [ ] Server: `POST /api/proclaim/snapshot` — write key, registry resolution inline, writer
       sighting, source selection, last-snapshot timestamp per doc for `/status`.
3. [ ] Server: port `YjsSlidePublisher` to TS against `connectServerDoc` (single transaction,
       hash-diffed), with [test_yjs_publisher.py](../tests/test_yjs_publisher.py) as the spec.
4. [ ] Server: port the translate-ahead worker (active item first, then upcoming; once per
       content hash; never clobber `reviewed`) in-process, consulting library → synced doc →
       in-flight set before `translateItem`. [test_slide_translator.py](../tests/test_slide_translator.py)
       is the spec. `SLIDE_TRANSLATION_LANGUAGES` becomes a server env var.
5. [ ] Server: drive the whole path with
       [tests/fixtures/synthetic_service.jsonl](../tests/fixtures/synthetic_service.jsonl) (the
       TS successor of `test_slide_seam`).
6. [ ] Service: `HttpSnapshotPusher` beside the runtime, selected by env; on-change + heartbeat
       cadence; retry with backoff; log the doc id the server answers with.
7. [ ] `/status`: heartbeat age and version from the POST; smoke-test section for the Proclaim
       path updated in [SMOKE_TEST.md](SMOKE_TEST.md).
8. [ ] One Sunday with both paths available (pusher on, runtime selectable by env).
9. [ ] Audio: the supervisor follows the selected organizer (bridge subscription and
       `resolveSourceLanguage`); separate PR, same policy module.
10. [ ] Cut over on `proclaim-stable`; delete `slide_sync_runtime.py`, `yjs_publisher.py`,
       `slide_translator.py`, `session_client.py`, their tests, the fake websocket/Provider in
       `tests/helpers.py`, and the `pycrdt` / `httpx_ws` dependencies. Update
       [ARCHITECTURE.md](ARCHITECTURE.md)'s writer table and [CLAUDE.md](../CLAUDE.md).
