# Changelog

All notable changes to PhaseAtlas are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). PhaseAtlas is pre-1.0, so a minor release
may contain a documented breaking change.

## [Unreleased]

### Added

- Reasoning effort for Claude Code, discovered from the installed CLI's `--effort` levels and applied
  to planning, execution, chat, and isolated chat edits. CLI builds without `--effort` keep the
  control disabled instead of offering levels the binary would reject.
- A provider picker in the chat composer. It collapses the selection to one button reading
  `Claude / Sonnet / Medium`, and opens a searchable popover grouped by CLI with reasoning effort for
  the chosen model. It reports the provider the open conversation will actually answer with, and a
  change applies to that conversation and to the repository-wide selection at the same time.
- `chat.setSessionProvider`, which retargets an open conversation after validating the selection
  against the discovered catalog. Past turns keep the provider they were recorded with.

### Removed

- The chat composer's "Files & folders" and "Images" buttons. Context is attached by typing `@` and
  by pasting images, which both already worked and are the only supported mechanisms now.

### Changed

- Split the repository agent selector into separate model and reasoning-effort controls instead of one
  combined dropdown whose options multiplied every model by every effort level.
- Reasoning effort is now disabled with an explicit reason for providers that do not expose it, and
  provider summaries no longer claim a "default effort" for those providers.
- The chat header no longer carries a provider chip that showed the repository-bar selection while
  turns ran on the conversation's own provider. The composer picker replaces it.

## [0.1.0] - 2026-08-04

### Added

- Local-first Electron desktop runtime with a sandboxed Svelte renderer, typed preload boundary, and
  one isolated utility process per active repository checkout.
- Git-tracked repository, workspace, task, dependency, policy, and Markdown content contracts under
  `.phaseatlas/`.
- Provider-neutral workspace and task planning with Codex CLI and Claude Code, explicit proposal
  review, canonical publishing, and parallel on-demand task-content initialization.
- List and dependency-map task views, rendered Markdown and Mermaid task bodies, repository explorer,
  Monaco editor, and bounded repository terminal sessions.
- Durable `analyze`, `plan`, `implement`, and `review` runs with isolated Git worktrees, normalized
  provider events, SQLite replay, lazy command-output pages, cancellation, retry, and stale-result
  handling.
- Repository-scoped chat with durable conversations, read-only inspection, file references, and a
  separately confirmed isolated edit-and-review workflow.
- Verified macOS packaging with static renderer and worker bundles, ad-hoc signing, bundle manifests,
  smoke verification, dual-architecture GitHub artifacts, and published SHA-256 checksums. Developer
  ID signing and notarization remain a documented future hardening path.
- Public release engineering, Semantic Versioning, Keep a Changelog release notes, and contributor
  documentation.
- MIT licensing for unrestricted use, modification, distribution, sublicensing, and commercial use
  with preservation of the copyright and license notice.
- Public developer attribution and website link for KétViệt.

### Security

- The first macOS artifacts are ad-hoc signed and not notarized. Verify the ZIP against
  `SHA256SUMS.txt` before running `xattr -dr com.apple.quarantine /Applications/PhaseAtlas.app` when
  Gatekeeper blocks the application.
- Provider credentials, executable paths, raw payloads, worktree paths, process identifiers, and
  arbitrary commands remain outside the renderer contract.
- Model output cannot directly publish canonical task contracts, promote evidence, or mark a task
  complete.

[Unreleased]: https://github.com/ketvietlab/phaseatlas/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ketvietlab/phaseatlas/releases/tag/v0.1.0
