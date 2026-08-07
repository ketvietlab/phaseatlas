# Changelog

All notable changes to PhaseAtlas are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). PhaseAtlas is pre-1.0, so a minor release
may contain a documented breaking change.

## [Unreleased]

### Added

- File paths cited by the model are clickable. A path in a result summary, next action, verification
  note, blocker, evidence reference, or conversation reply opens that file in a panel on the right of
  the run workbench, so a claim about the repository can be checked where it is made. Markdown opens
  rendered, with a Preview and Source toggle.

- The task conversation can change the repository: an Ask/Edit toggle in its composer runs the
  existing confirmed, isolated, reviewed edit path, with accept and discard offered inline once the
  edit completes.

- A task conversation: one durable chat session bound to a canonical task, so the four pipeline
  stages and the user's own questions share a single thread. Turns in that thread receive the task
  contract and the results of completed stages as context. The run panel now shows that thread —
  stages and questions interleaved in one transcript with a composer — in place of the per-run
  command list.

- Reasoning effort for Claude Code, discovered from the installed CLI's `--effort` levels and applied
  to planning, execution, chat, and isolated chat edits. CLI builds without `--effort` keep the
  control disabled instead of offering levels the binary would reject.
- A provider picker in the chat composer. It collapses the selection to one button reading
  `Claude / Sonnet / Medium`, and opens a searchable popover grouped by CLI with reasoning effort for
  the chosen model. It reports the provider the open conversation will actually answer with, and a
  change applies to that conversation and to the repository-wide selection at the same time.
- `chat.setSessionProvider`, which retargets an open conversation after validating the selection
  against the discovered catalog. Past turns keep the provider they were recorded with.

- The task run panel now presents `analyze → plan → implement → review` as one connected pipeline
  with per-stage state, a check mark on completed stages, and a "Start here" marker on the stage to
  run next. It carries its own agent picker, which also moves the repository-wide selection.
- Agent runs receive the results of earlier pipeline stages for the same task revision, and each
  action states what it is for instead of relying on the model to infer it from an action name.

### Fixed

- Model prose that arrived with double-escaped newlines rendered as one paragraph with literal `\n`
  sequences in it. Such a field is now repaired at render time, leaving the persisted result
  untouched, and only when the text contains no real newline at all — a text that already breaks
  lines and also mentions the sequence is describing it, not escaping it.

- Agent narration and chat answers were mangled: the sanitizer treated a slash anywhere in a word as
  the start of an absolute path, so `Legal/Compliance` became `Legal<path>` and `docs/01-pilot.md`
  became `docs<path>` — redacting exactly the repository-relative paths the run contract requires a
  result to carry. Redaction is now anchored to the start of a token.

- Claude Code runs completed their work and then failed with a JSON parse error. The agent result
  schema carries a `$schema` dialect key, and Claude Code silently abandons structured output when it
  is present — the run returned prose instead. The key is now dropped before the schema is handed to
  the CLI.

- Claude Code always reported itself as signed out inside PhaseAtlas, even for a signed-in user. The
  repository worker's environment allowlist dropped `USER`, which the CLI needs to resolve its stored
  credentials, so no Claude Code run could ever authenticate.

- Claude Code was offered as an available provider, with a full model catalog, while signed out —
  its version and model discovery never needed authentication, so every run failed at sign-in
  instead. Discovery now probes `claude auth status` and reports the runner as unavailable with the
  reason.
- A failing Claude Code run reported only "exited with code 1:" with no reason. Claude writes its
  failure into the stdout stream and leaves stderr empty, so the diagnostic it already parsed was
  discarded in favour of an empty process error.
- Every Claude Code invocation failed with "When using --print, --output-format=stream-json requires
  --verbose". Planning, execution, chat, and isolated chat edits now pass the required flag.

### Removed

- The chat composer's "Files & folders" and "Images" buttons. Context is attached by typing `@` and
  by pasting images, which both already worked and are the only supported mechanisms now.

### Changed

- Model prose is rendered as Markdown wherever it appears — the validated result summary, next
  action, verification details and blockers, and the task conversation — so a path written as
  `infra/identity/login/` reads as code instead of showing its backticks. Links never resolve and
  images are never fetched, matching how the chat transcript already treats untrusted model output.

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
