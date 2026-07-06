# Docs index

Short, surfaced-not-comprehensive documentation. Coding agents can grep; humans start here.

## Orientation

- [ARCHITECTURE.md](ARCHITECTURE.md) — component map: what runs where, who writes what into
  the shared Yjs doc, and what each component's true input boundary is. **Start here.**
- [../CLAUDE.md](../CLAUDE.md) — agent-facing project guide (commands, conventions, patterns).

## Operations

- [SMOKE_TEST.md](SMOKE_TEST.md) — the pre-service manual smoke-test checklist, and how PRs
  declare which sections they touch.

## Design docs

- [slide-translations-plan.md](slide-translations-plan.md) — slide translation agent design.
- Replay harness design: [#70](https://github.com/kcarnold/live-notes/issues/70) —
  record-at-the-boundary replay of full services for testing and accountability.

## Subsystem references (repo root)

- [PROCLAIM_INTEGRATION.md](../PROCLAIM_INTEGRATION.md), [PROCLAIM_DATA_FORMAT.md](../PROCLAIM_DATA_FORMAT.md),
  [PROCLAIM_SERVICE_SETUP.md](../PROCLAIM_SERVICE_SETUP.md) — Proclaim sync service.
- [DUMP_DOCS_README.md](../DUMP_DOCS_README.md) — Yjs doc dumper (end-state JSON extraction;
  known to be stale relative to current doc structure — do not treat as source of truth).
