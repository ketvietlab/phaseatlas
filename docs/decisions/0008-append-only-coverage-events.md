# ADR 0008: Append-only documentation coverage events

- Status: accepted
- Date: 2026-08-11

## Context

A workspace-level `coverage.yaml` combined a generated inventory of every file below `docs/` with
human audit decisions. Any audit rewrote the complete document. Concurrent audits therefore changed
the same Git path and frequently conflicted, even when the users reviewed unrelated documentation.
A custom merge driver, lock, or per-document mutable file can reduce this failure rate but cannot
remove the shared mutable write that causes it.

## Decision

Documentation coverage is an immutable event log on the configured task registry ref. One audit
result creates exactly one uniquely named file:

```text
.phaseatlas/workspaces/<workspace>/coverage-events/<uuid>.yaml
```

An event binds a result to the documentation path, byte size, SHA-256 content hash, and source code
commit that was reviewed. PhaseAtlas derives the current inventory from Git-tracked files below
`docs/`; generated inventory rows are not stored. A file is pending when its current hash has no
matching event and covered when it has a matching active event.

Events are never edited or deleted by the application. A later event may name earlier events in
`resolves`. Different active semantic results for the same path and content hash produce an explicit
projection conflict. They do not ask Git to merge YAML.

The trusted repository worker validates the current file and expected hash, generates the UUID and
timestamp, and writes the event using Git plumbing. Publishing uses an expected-head lease. If a
concurrent publisher advances the registry, PhaseAtlas fetches the new head, adds the same unique
event path to a new commit, and retries. It never overwrites an unexpected head. Invalid paths,
unknown fields, malformed events, unsafe resolutions, and unreadable tracked files fail closed.

The legacy `coverage.yaml` is not part of this contract. Repository migration converts its latest
decisions to immutable events and then removes the monolith in one reviewed registry change.

## Consequences

- Independent coverage writes are commutative and do not create a shared Git file conflict.
- A documentation edit automatically makes the new content revision pending without mutating the
  historical event.
- Conflicting audit conclusions remain visible until a resolution event supersedes them.
- Coverage history grows by small files and can be compacted only through a separately designed,
  explicit migration; normal operation stays append-only.
- Raw edits in Theia are validated with the rest of the task registry before publication.
