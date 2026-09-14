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
  outages), the invariant, and the three defense layers. **Read before changing the bridge's
  subscription or reconnect paths** — the failure mode is silent, and the sample code this
  subsystem came from does not defend against it. Written to be upstreamable.

## Design docs

- [live-audio-state-architecture.md](live-audio-state-architecture.md) — state audit of the
  live-translation subsystem (client + server state machines, edge-case catalog), a proposed
  supervisor/reconciler architecture, and the hot-fix ladder to apply before it.
- [slide-translations-plan.md](slide-translations-plan.md) — slide translation agent design.
- [LANDING_PAGE.md](LANDING_PAGE.md) — landing-page redesign brief (proposal): what a
  first-time attendee hits today, the one-question reframe, the per-deployment config set,
  and the capability model that decides which language card goes where.
- Replay harness design: [#70](https://github.com/kcarnold/live-notes/issues/70) —
  record-at-the-boundary replay of full services for testing and accountability.

## Subsystem references

- [PROCLAIM_INTEGRATION.md](PROCLAIM_INTEGRATION.md), [PROCLAIM_DATA_FORMAT.md](PROCLAIM_DATA_FORMAT.md),
  [PROCLAIM_SERVICE_SETUP.md](PROCLAIM_SERVICE_SETUP.md) — Proclaim sync service.
- [DUMP_DOCS.md](DUMP_DOCS.md) — Yjs doc dumper: bulk end-state JSON extraction across every
  day's doc. Knows about fewer keys than the doc holds; `sessionExport.ts` is the reader that
  tracks it most closely.

## Writing docs here

**Don't hard-code in prose anything a reader could look up in the code.** Every stale thing
found in the 2026-09 audit was a fact duplicated from code into a sentence, where the copy
nearest the change got updated and the far copy didn't.

In practice:

- **No line numbers.** Link the file, name the symbol; `grep` finds it, and the anchor rots on
  the next edit above it. (40 such anchors were deleted in that audit; several already pointed
  at blank lines.)
- **No default values, timeouts, model names, ports or intervals.** Name the constant or the
  env var and say where it is read. Say *why* the value is what it is — that part doesn't rot.
- **No re-listing of things the code enumerates**: env vars (`template-.env` is the list),
  route names, Yjs doc keys, layout component names. Point at the one place that has to be
  right for the program to work.
- **Keep status out of reference docs.** "Not yet built" belongs in an issue, which has a close
  button. A doc doesn't, so every "not yet" sentence is a future lie with no expiry.

What *is* worth writing here is the part the code can't say: why a design is the way it is, what
broke to make it that way, and what would break if someone changed it back.
