# Development guide

## Runtime topology

Development keeps the UI and desktop runtime separate:

1. Vite serves the Svelte renderer at `127.0.0.1:4177`.
2. Electron loads that URL into a sandboxed renderer.
3. The main process owns repository selection and utility-process lifecycle.
4. Opening a repository starts `@phaseatlas/repository-worker` with a fixed repository root.

The packaged topology will load a static renderer. Packaging, signing, notarization, and updates are
deliberately outside the first vertical slice.

## Commands

```bash
pnpm dev       # build runtime, start renderer, restart Electron on backend changes
pnpm check     # TypeScript and Svelte checks
pnpm test      # core contract tests
pnpm build     # production builds for every workspace
```

The Svelte renderer uses Vite hot reload. Changes under contracts, core, repository worker, or
Electron main/preload trigger a sequential runtime rebuild followed by an Electron restart. Open
repositories are process-local and must be selected again after that restart.

## Adding an IPC operation

1. Add request and response types in `packages/contracts`.
2. Implement the operation inside the repository worker or main process.
3. Route it through `RepoProcessManager`.
4. Expose a narrow function from `apps/desktop/src/preload.ts`.
5. Consume only the typed bridge from the renderer.

Never expose `ipcRenderer`, filesystem primitives, arbitrary commands, or raw process handles to the
renderer.

## Current limitations

- Agent execution is represented in contracts but is not yet started by the worker.
- Repository workers stop when a repository is closed; idle TTL and run-aware shutdown come next.
- The packaged worker path has a placeholder layout and will be finalized with Electron packaging.
- Workspace and task manifests are YAML; execution persistence is the next contract milestone.
