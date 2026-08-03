# ADR 0002: Git for contracts, application storage for runtime state

- Status: Accepted
- Date: 2026-08-03

## Decision

Store repository and workspace manifests, canonical task contracts, policies, and promoted evidence in
the repository under `.phaseatlas/`. Store volatile run state, JSONL events, logs, UI state, and caches
under the operating system's application-support directory.

Use one global catalog database owned by the main process and one database per checkout owned by its
repository worker. Do not let multiple workers write the same SQLite database in the first release.

Secrets belong in the operating system credential store or the provider CLI's own authenticated state.

## Consequences

Task changes are diffable and reviewable. High-frequency execution events do not pollute Git. Multiple
clones of the same repository share a stable repository identity while retaining separate local run
state through checkout identity.

