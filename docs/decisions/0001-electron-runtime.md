# ADR 0001: Electron runtime with repository utility processes

- Status: Accepted
- Date: 2026-08-03

## Context

PhaseAtlas needs direct access to local repositories, Git worktrees, project toolchains, filesystem
watchers, and coding-agent CLIs. It must open multiple repositories without allowing one repository's
module cache, current directory, or failed parser to corrupt another.

## Decision

Use Electron as the first desktop runtime. Keep the renderer sandboxed, expose a narrow preload API,
and start one utility process for every active checkout. Multiple workspaces share that worker.

## Consequences

- Existing Node repository parsing can move with little rewrite.
- Repository roots and caches are process-isolated.
- Worker supervision, crash recovery, and packaging require explicit implementation.
- Electron distribution is larger than a system-webview shell; bundle size is not the first milestone.

Tauri remains possible after the worker protocol stabilizes, but it would currently require a Node
sidecar or a rewrite of repository parsing and agent orchestration.

