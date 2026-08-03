# Roadmap

## M0 — Desktop boundary

- [x] Electron main process and sandboxed renderer
- [x] Typed preload bridge
- [x] One utility process per active checkout
- [x] `.phaseatlas/` repository and workspace discovery
- [x] Worker change notifications
- [x] Idle shutdown and crash recovery

## M1 — Canonical tasks

- [x] Initial TypeScript contracts and model-output JSON schemas
- [x] Runtime validation for repository, workspace, and task YAML
- [ ] Source adapters for legacy repository documents
- [x] Deterministic normalization and task revision
- [x] Task graph and cycle detection

## M2 — Planning

- [x] Provider-neutral runner discovery and capabilities
- [x] Read-only planner runner
- [x] Natural-language request to `TaskProposal[]`
- [x] Repository-scoped planning to a reviewed workspace and starter tasks
- [x] Proposal review and edit UI
- [x] Policy validation and canonical task publishing

## M3 — Execution

- [ ] Worktree lease manager
- [ ] Provider-neutral execution runner framework
- [ ] Codex CLI execution adapter
- [ ] Second execution provider adapter to verify the abstraction
- [ ] Normalized agent event stream
- [ ] Run timeline, command cards, and changed-file view
- [ ] Cancellation, resume, and stale-revision handling

## M4 — Persistence and distribution

- [x] Global catalog and per-checkout SQLite databases
- [x] Recovery after worker or application crash
- [ ] Static packaged renderer
- [ ] Electron packaging, signing, notarization, and updates
