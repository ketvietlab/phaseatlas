# ADR 0006: Embed checkout-bound Theia runtimes behind the desktop supervisor

- Status: accepted
- Date: 2026-08-08

## Context

PhaseAtlas needs a full editor for canonical checkouts and retained agent worktrees. The Svelte
renderer must remain free of Node.js and Electron capabilities, while an IDE necessarily needs broad
file, terminal, language-server, and extension authority inside the workspace it opens. Embedding a
browser IDE also adds a local backend, a second web surface, third-party extension code, and a large
packaged runtime to the application trust boundary.

## Decision

Build Eclipse Theia from the pinned `ide/theia` submodule and run one backend per canonical checkout or
retained worktree. Electron main owns backend and native-view lifecycle. The renderer may submit only a
registered checkout ID and, optionally, a retained run ID; trusted managers resolve those identifiers
to a canonical absolute path. The renderer never supplies a backend entry, port, command, arbitrary
working directory, process handle, or filesystem capability.

Load Theia in a dedicated sandboxed `WebContentsView` with context isolation, Node integration disabled,
permissions denied by default, navigation restricted to that instance's loopback origin, and a preload
that exposes theme observation only. Each target receives an isolated configuration, plugin directory,
session partition, stable loopback port, and backend process. Closing the PhaseAtlas window stops its
backends; hiding a view preserves IDE state until the user explicitly stops it.

Treat the Theia backend and its pinned default extensions as trusted local IDE code with authority over
exactly the resolved workspace. Extension archives are pinned by URL, version, and SHA-256. The packaged
Theia runtime, extensions, desktop preload, and all other PhaseAtlas-owned resources are included in the
bundle manifest and credential-like-file scan.

## Consequences

- The Svelte renderer and the normal PhaseAtlas preload do not gain generic filesystem, terminal, or
  process APIs.
- A retained agent worktree can be inspected and edited without granting its path to renderer code.
- Theia backends are local single-user services bound to loopback, not remote collaboration endpoints.
- IDE extensions have workspace-level authority and must remain pinned and reviewed when updated.
- A checkout or worktree cannot open if its identity, resolved path, runtime inputs, viewport, theme, or
  reserved port is missing, invalid, or ambiguous.
- The packaged application grows substantially, and release integrity verification must cover the
  embedded runtime and extensions rather than checking only for their presence.
