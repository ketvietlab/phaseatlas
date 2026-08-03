# PhaseAtlas

PhaseAtlas is a local-first desktop control plane for turning repository-backed work into explicit,
reviewable agent runs. One Electron application can open multiple repositories; each active checkout
is isolated in its own utility process and can expose multiple workspaces.

This repository currently contains the first vertical slice:

- an Electron main process and a narrow preload bridge;
- one lazy repository worker per active checkout;
- a Svelte desktop renderer following KétViệt's staff/operational design language;
- shared repository, workspace, task, run, and worker contracts;
- a repository inspector for `.phaseatlas/` manifests;
- provider-neutral read-only planning through Codex CLI and Claude Code adapters;
- proposal review, policy validation, and canonical YAML publishing;
- optional single-task or parallel batch initialization of Markdown task bodies after publish;
- a repository explorer and Monaco-based multi-tab editor with explicit saves;
- architecture decisions and contract documentation.

## Requirements

- Node.js `>=24` (the repository currently pins `24.14.0`)
- pnpm `11.9` or newer
- Git

## Start locally

```bash
pnpm install
pnpm dev
```

The development command builds the shared runtime, starts the Svelte dev server on
`http://127.0.0.1:4177`, then opens Electron. Renderer changes hot-reload in place. Contract, core,
repository-worker, and Electron changes rebuild the runtime and restart the desktop window
automatically.

## Verify

```bash
pnpm check
pnpm test
pnpm build
```

## Repository layout

```text
apps/desktop             Electron main process and preload bridge
apps/repository-worker   Process-isolated repository backend
apps/ui                  Svelte renderer
packages/contracts       Shared messages and domain types
packages/core            Repository inspection and normalization core
docs                     Architecture, contracts, ADRs, and roadmap
.phaseatlas              PhaseAtlas's own repository manifest and tasks
```

Start with [the architecture overview](docs/architecture/overview.md) and
[the development guide](docs/development.md). The renderer's visual profile and asset provenance are
recorded in [ADR 0003](docs/decisions/0003-ketviet-design-language.md).
