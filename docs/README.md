# Docs index

Short, surfaced-not-comprehensive documentation. Coding agents can grep; humans start here.

## Orientation

- [ARCHITECTURE.md](ARCHITECTURE.md) — component map: what runs where, who writes what into
  the shared Yjs doc, and what each component's true input boundary is. **Start here.**
- [../CLAUDE.md](../CLAUDE.md) — agent-facing project guide (commands, conventions, patterns).

## Operations

- [SMOKE_TEST.md](SMOKE_TEST.md) — the pre-service manual smoke-test checklist, and how PRs
  declare which sections they touch.
- [CURRENT_SESSION.md](CURRENT_SESSION.md) — which doc everything reads and writes, and who
  decides: the server-owned pin/proposal/date precedence, the operator control on `/status`,
  and why `SESSION_TIMEZONE` has to be the church's zone. **Read before changing anything
  that resolves a doc id.**
- [WRITE_KEYS.md](WRITE_KEYS.md) — shared-key write authorization: what needs a key, the
  observe→enforce rollout, how each device is given one, and how to rotate.
- [OBSERVABILITY.md](OBSERVABILITY.md) — what to observe about the live-audio backend
  (status/liveness) and where to pull it from: PostHog events, in-process state, LiveKit, Yjs.
- [live-audio-resilience.md](live-audio-resilience.md) — how the translation bridge survives
  LiveKit and Gemini dropping connections under it. Incident history (two "active but deaf"
  outages and one "fed twice"), the invariant, and the defense layers. **Read before changing the bridge's
  subscription or reconnect paths** — the failure mode is silent, and the sample code this
  subsystem came from does not defend against it. Written to be upstreamable.
- [live-audio-state-architecture.md](live-audio-state-architecture.md) — the live-translation
  subsystem one level up from the bridge: every state machine it contains (client + server),
  the presence supervisor that reconciles them against LiveKit, and the edge-case catalog with
  what each case does today. **Read before changing the supervisor, bridge lifecycle, or the
  listener's ensure-loop** — the closed rows name the mechanism that closed them. Ends with the
  short list of gaps that are still open, all of them in the browser.

## Design docs

- [adr-001-server-owned-slide-sync.md](adr-001-server-owned-slide-sync.md) — **ADR (proposed):**
  the server owns slide publishing and translation; the Proclaim service becomes a snapshot
  pusher with no Yjs dependency. Why a CRDT client shouldn't make the "spend a model call?"
  decision; one server-owned, operator-overridable source-selection policy for both the
  slide feed and the audio feed; the migration.
- [slide-translations-plan.md](slide-translations-plan.md) — slide translation agent design.
- [LANDING_PAGE.md](LANDING_PAGE.md) — landing-page redesign brief (proposal): what a
  first-time attendee hits today, the one-question reframe, the per-deployment config set,
  and the capability model that decides which language card goes where.
- Replay harness design: [#70](https://github.com/kcarnold/live-notes/issues/70) —
  record-at-the-boundary replay of full services for testing and accountability.

## Subsystem references (repo root)

- [PROCLAIM_INTEGRATION.md](../PROCLAIM_INTEGRATION.md), [PROCLAIM_DATA_FORMAT.md](../PROCLAIM_DATA_FORMAT.md),
  [PROCLAIM_SERVICE_SETUP.md](../PROCLAIM_SERVICE_SETUP.md) — Proclaim sync service.
- [DUMP_DOCS_README.md](../DUMP_DOCS_README.md) — Yjs doc dumper (end-state JSON extraction;
  known to be stale relative to current doc structure — do not treat as source of truth).
