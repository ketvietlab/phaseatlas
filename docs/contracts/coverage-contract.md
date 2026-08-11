# Documentation coverage contract

PhaseAtlas stores one immutable YAML event for each documentation audit at
`.phaseatlas/workspaces/<workspace-slug>/coverage-events/<event-id>.yaml` on the repository's task
registry ref.

```yaml
schemaVersion: phaseatlas.coverage-event/v1
id: 10000000-0000-4000-8000-000000000001
path: docs/guide.md
contentSha256: 9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a
size: 4
sourceCommit: 0123456789abcdef0123456789abcdef01234567
recordedAt: 2026-08-11T08:00:00.000Z
result: clean
codeScopes: []
stagingStatus: not-applicable
inlineFixes: []
taskRefs: []
workItemRefs: []
resolves: []
```

`path` must identify a regular Git-tracked file below `docs/`. `contentSha256` and `size` bind the
decision to one exact revision. `result` is `clean`, `fixed`, or `issue`; staging status is
`not-applicable`, `not-verified`, or `verified-read-only`. All list fields are required in stored
events and are normalized to unique sorted values.

The worker, rather than the renderer, supplies `id`, `sourceCommit`, `recordedAt`, and the observed
size. It rejects an append if the current content hash differs from the renderer's expected hash.
Event filenames must match their UUID and event files are flat: subdirectories and other files below
`coverage-events/` are invalid.

A resolution event has the same path, hash, and size and lists active event IDs in `resolves`. An
unknown ID, a self-reference, or a reference to another document revision is invalid. Multiple active
events with identical semantic fields are harmless duplicates. Resolution cycles are invalid.
Different semantic fields yield a
`conflicted` projection until a valid resolution event supersedes them.

The coverage snapshot is derived from the code checkout and the task registry:

- `pending`: current tracked content has no active matching event;
- `covered`: current tracked content has one semantic result;
- `conflicted`: current tracked content has multiple active semantic results.

Historical events for old content hashes remain valid history but never cover new content.
Every snapshot identifies both the code checkout commit and, for configured repositories, the task
registry remote, ref, and commit used to load the events.
