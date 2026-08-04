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
Electron main/preload trigger a sequential runtime rebuild followed by an Electron restart. The
checkout catalog and operational run history are application-support data, so repositories and runs
are reconstructed after that restart rather than relying on renderer memory.

## Adding an IPC operation

1. Add request and response types in `packages/contracts`.
2. Implement the operation inside the repository worker or main process.
3. Route it through `RepoProcessManager`.
4. Expose a narrow function from `apps/desktop/src/preload.ts`.
5. Consume only the typed bridge from the renderer.

Never expose `ipcRenderer`, filesystem primitives, arbitrary commands, or raw process handles to the
renderer.

## Exercising task execution

1. Open a configured repository and choose an installed provider plus a provider-discovered model in
   Repository settings.
2. Select a canonical task and open **Run task** or the repository-level **Runs** action.
3. Inspect the worker-provided availability reasons. Read-only actions start directly; implementation
   requires acknowledgement of the exact task revision, provider/model, isolated worktree, sandbox,
   writable paths, and network policy.
4. Keep the workbench open to observe the provider narrative. Command activity remains collapsed and
   contains metadata only; opening one command fetches a bounded SQLite page on demand. Previous/next
   navigation replaces the visible page instead of accumulating output in the DOM.
5. Reload during a run. The renderer lists checkout-owned history, reconstructs the selected transcript
   from persisted pages, then resumes after its highest contiguous sequence while deduplicating live
   events and backfilling a detected gap.
6. Cancel an active run to verify the UI waits for confirmed provider exit. Restart during a run to
   exercise the explicit interrupted-attempt keep/retry choices.
7. Edit the canonical task after a completed result and reopen the result review to verify it becomes
   stale and non-promotable.

The renderer stores only the selected run preference. Run specifications, events, results, retry links,
freshness, and terminal state remain in checkout-owned operational storage behind the worker.

## Exercising repository chat

1. Choose an installed CLI and one of its discovered models in **Provider settings**, then open
   **Agent chat** from the active repository toolbar. Chat does not require a workspace or task.
2. Create multiple conversations and send turns in more than one session. The session rail shows
   independent active state while normalized reasoning, tools, command output, and provider silence
   remain visible in the selected transcript.
3. Attach only repository-relative path references. Chat remains read-only; it does not expose a file
   picker, command input, executable path, provider permissions, or task authority.
4. Reload during a turn. Session metadata is hydrated for every conversation, while selected transcript
   messages and bounded event pages are reconstructed from checkout storage and deduplicated by sequence.
5. Cancel an active turn or restart the worker to exercise terminal cancellation and explicit retry of
   interrupted attempts.

Assistant content is rendered by `@humanspeak/svelte-markdown`, following the Conversation, Message,
Tool, Reasoning, and Prompt Input composition used by Svelte AI Elements. URL and image output is
disabled at the chat boundary, Mermaid rendering is isolated, and PhaseAtlas remains the authority for
session state and durable events.

## Current limitations

- Result promotion and canonical task-state transitions remain separate reviewed workflows.
- The packaged worker path has a placeholder layout and will be finalized with Electron packaging.
- Repository chat starts read-only. Use the Ask/Edit switch for a separately confirmed isolated edit.

### Isolated chat editing

Edit mode requires one or more comma-separated repository paths before it can show the confirmation.
Verify the repository, provider, model, base revision, scope, and fixed no-network/no-dependency/no-database
policy before confirming.

The review must list Git-derived files and a patch while the canonical checkout remains unchanged. Test
Accept only with a clean, unchanged checkout; test Discard and Retain separately. After Retain, restart the
desktop worker and verify that Resume review or Discard is required. `Option+L` toggles Chat on macOS
(`Alt+L` elsewhere), and the Explorer action opens the existing repository file browser.
