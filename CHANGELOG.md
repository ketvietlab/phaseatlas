# Changelog

All notable changes to PhaseAtlas are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). PhaseAtlas is pre-1.0, so a minor release
may contain a documented breaking change.

## [Unreleased]

### Changed

- Split the repository agent selector into separate model and reasoning-effort controls instead of one
  combined dropdown whose options multiplied every model by every effort level.
- Reasoning effort is now disabled with an explicit reason for providers that do not expose it, and
  provider summaries no longer claim a "default effort" for those providers.
- Repository chat now reports the provider, model, and reasoning effort frozen into the open
  conversation rather than the current repository-bar selection.

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
