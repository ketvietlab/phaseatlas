# ADR 0007: One repository-wide task registry branch

- Status: accepted
- Date: 2026-08-10

## Context

Reading `.phaseatlas/workspaces` from the code checkout makes canonical project state depend on the
branch currently open in Theia. Two feature branches may then report different task states, while a
branch switch at one filesystem path reuses the same checkout identity and operational database.

## Decision

Configured repositories may declare one remote task registry ref in `.phaseatlas/repository.yaml`.
PhaseAtlas fetches that ref into a detached, application-managed Git worktree and loads workspace,
task, content, dependency, and evidence contracts from that worktree. Code inspection and execution
remain bound to the checkout the user opened.

For PhaseAtlas itself the canonical ref is `refs/heads/phaseatlas/tasks`, with `develop` as the default
delivery ref. Code branches retain only the repository manifest; canonical workspace and task files
live on the registry ref.

Theia may open the registry `.phaseatlas` directory as a separate, clearly labelled IDE target. File
saves create a draft in the detached worktree. Validation, an explicit review action, and a Git push
guarded by the expected registry commit are required before a draft becomes canonical. A rejected
push preserves the draft and never force-overwrites an unexpected remote head.

Operational run events remain checkout-local. Every task snapshot identifies the registry ref and
commit from which it was loaded, so switching code branches cannot silently change project status.

## Consequences

- The task registry has one repository-wide Git authority independent of code branches.
- Task edits no longer appear in feature-branch working trees or code pull requests.
- A registry fetch is required when a configured checkout starts; missing or inaccessible refs fail
  closed rather than falling back to branch-local task files.
- Raw Theia edits remain drafts until shared validation succeeds and the user publishes them.
- Concurrent publishers use expected-head semantics. Conflicts require review instead of force push.
- The application-support worktree contains Git-tracked contracts only; credentials and operational
  run history remain outside it.
