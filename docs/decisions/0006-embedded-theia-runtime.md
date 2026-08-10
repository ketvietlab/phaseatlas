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
retained worktree, plus a separately labelled target for a configured task registry. Electron main owns backend and native-view lifecycle. The renderer may submit only a
registered checkout ID and, optionally, a retained run ID; trusted managers resolve those identifiers
to a canonical absolute path. The renderer never supplies a backend entry, port, command, arbitrary
working directory, process handle, or filesystem capability.

Load Theia in a dedicated sandboxed `WebContentsView` with context isolation, Node integration disabled,
permissions denied by default, navigation restricted to that instance's loopback origin, and a preload
that exposes theme observation plus a bounded repository-agent configuration projection and applies a
PhaseAtlas presentation layer through Theia's CSS color-token boundary. It does not expose files,
commands, executable paths, processes, credentials, or generic Electron APIs. Each target
receives an isolated configuration, plugin directory,
session partition, stable loopback port, and backend process. Closing the PhaseAtlas window stops its
backends; hiding a view preserves IDE state until the user explicitly stops it.

Use Theia AI Chat as the repository-wide chat UI instead of maintaining a second PhaseAtlas chat
surface. The normal renderer receives a single bounded `ide.openChat()` operation. Electron main waits
for the application shell and invokes only Theia's fixed Chat View keybinding; it does not accept an
arbitrary Theia command identifier or JavaScript payload. The pinned Theia application registers the
Codex and ClaudeCode agents. Target settings bypass generic language-model-provider onboarding because
these agents own their authentication. Electron main projects only available Codex/Claude runners and
their discovered models and efforts into the IDE. PhaseAtlas selections are inherited per checkout;
changes from Theia are treated as untrusted, validated against the repository worker catalog, persisted
back by the normal renderer, and then broadcast to both surfaces. The backend consumes only the
validated target-local configuration file at turn start. The packaged runtime includes pinned Claude
Agent and current Codex SDKs plus the matching Codex native runtime; both use existing local CLI auth.

The renderer reports the CSS-pixel rectangle reserved for the IDE. Electron main validates it and
converts it with the host renderer's zoom factor before placing the native view, because native view
bounds use unzoomed window coordinates. The IDE surface is a full content-column replacement rather
than an inset or transformed card so its measured rectangle remains stable and cannot cover adjacent
PhaseAtlas chrome.

Treat the Theia backend and its pinned default extensions as trusted local IDE code with authority over
exactly the resolved workspace. Extension archives are pinned by URL, version, and SHA-256. The packaged
Theia runtime, extensions, Claude Agent SDK, Codex SDK/native runtime, desktop preload, and all other PhaseAtlas-owned resources
are included in the bundle manifest and credential-like-file scan.

## Consequences

- The Svelte renderer and the normal PhaseAtlas preload do not gain generic filesystem, terminal, or
  process APIs.
- The Svelte renderer no longer owns repository-wide chat sessions, transcripts, attachments, or a
  second chat/IDE surface switcher.
- Repository provider selection has one per-checkout value across PhaseAtlas and Theia; unsupported
  runner/model/effort values fail closed at the desktop boundary.
- A retained agent worktree can be inspected and edited without granting its path to renderer code.
- Canonical task YAML and Markdown can be edited in Theia without switching the code checkout; saves
  remain drafts until the validated registry publish action succeeds.
- Theia backends are local single-user services bound to loopback, not remote collaboration endpoints.
- IDE extensions have workspace-level authority and must remain pinned and reviewed when updated.
- A checkout or worktree cannot open if its identity, resolved path, runtime inputs, viewport, theme, or
  reserved port is missing, invalid, or ambiguous.
- The packaged application grows substantially, and release integrity verification must cover the
  embedded runtime and extensions rather than checking only for their presence.
