# ADR 0002: Git for contracts, application storage for runtime state

- Status: Accepted
- Date: 2026-08-03

## Decision

Repository and workspace manifests, canonical task contracts, policies, task Markdown, and promoted
evidence remain in Git under `.phaseatlas/`.

The Electron main process resolves a private runtime root beneath `app.getPath("userData")` and owns:

```text
<userData>/runtime/catalog.sqlite
```

The catalog stores bounded checkout identity, display, visibility, lifecycle, recovery, and last-error
metadata. It is not a registry of live processes and survives expected shutdown, idle shutdown, and
application restart.

Each checkout worker is the sole writer of its own operational database:

```text
<userData>/runtime/checkouts/<checkoutId>/operations.sqlite
```

That store contains normalized run records and ordered events. A checkout ID is recorded in the
database metadata and must match when reopened. Different checkout IDs never share a store, including
when their checkouts share the same configured repository ID.

Both databases use explicit schema version `1`, WAL journaling, and full synchronous commits. An
unknown schema version or identity mismatch fails closed. This release initializes the known schema;
it does not provide a general migration mechanism and does not silently replace incompatible data.

## Security and authority boundary

Operational storage must not contain provider credentials, authentication state, environment dumps,
raw provider protocol payloads, canonical task manifests, policies, or task-completion authority.
Secrets stay in the operating-system credential store or the provider CLI's authenticated state.

Persisted run events are recoverable operational evidence. Only reviewed Git changes can alter the
canonical task contract, promote evidence, or mark work complete.

## Consequences

Task changes remain diffable and reviewable while high-frequency events do not pollute Git. Multiple
clones and worktrees share repository identity but retain isolated local histories. The main process
can restore its repository catalog without eagerly starting every worker, and workers can reconcile
interrupted runs without treating them as successful.
