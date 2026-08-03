# Task contract

## Three contracts, three authorities

PhaseAtlas does not use one mutable task object for planning, execution, and results:

```text
TaskProposal -> CanonicalTask -> AgentRunSpec -> AgentRunResult
```

- `TaskProposal` is model-generated and untrusted.
- `CanonicalTask` is validated, approved, and Git-tracked.
- `AgentRunSpec` is an immutable snapshot of a canonical task revision.
- `AgentRunResult` is structured output awaiting independent verification.

## Canonical location

```text
.phaseatlas/workspaces/<workspace-slug>/tasks/<task-id>.yaml
```

One file per task reduces merge conflicts and makes task changes reviewable in pull requests.

## Minimum task shape

```yaml
schemaVersion: phaseatlas.task/v1
id: PHA-001
title: Establish the desktop runtime boundary
kind: code
phase: foundation
state: ready
priority: high

objective: >
  Open a Git repository through Electron and inspect its PhaseAtlas workspaces in an isolated worker.

content:
  path: PHA-001.md

owners:
  - PhaseAtlas Core

dependencies: []

scope:
  allowedPaths:
    - apps/desktop/**
    - apps/repository-worker/**
    - packages/**
  forbiddenPaths: []
  writable: true
  allowDependencyChanges: true
  allowDatabaseMigrations: false
  allowExternalNetwork: false

acceptanceCriteria:
  - id: AC-1
    statement: A selected Git repository receives one utility worker.
    verification:
      type: command
      commandId: verify

verification:
  - id: verify
    command: pnpm check && pnpm test
    timeoutSeconds: 300
    required: true

evidenceRequirements:
  - type: test
  - type: human_review
```

## Task body

The YAML file is the canonical task outline and remains valid before a body exists. Detailed content
is an optional Markdown sidecar stored beside it:

```text
.phaseatlas/workspaces/<workspace-slug>/tasks/PHA-001.yaml
.phaseatlas/workspaces/<workspace-slug>/tasks/PHA-001.md
```

The Markdown body is initialized only when a user requests it. It uses `Context`, `Requirements`,
`Implementation notes`, `Constraints`, and `Verification plan` sections so an implementation agent
can start without the planning conversation. The body can then be edited in the repository editor.
Its path and bytes participate in the canonical revision hash.

## State and readiness

Task state describes operational position:

```text
draft -> planned -> ready -> in_progress -> in_review -> done
```

`blocked`, `deferred`, and `cancelled` are explicit side states. Build, evidence, and release readiness
are separate projections; code being merged does not imply evidence is verified or release is open.

## Revision

Normalization produces a deterministic hash over the canonical task and its declared sources. Every
agent run stores this revision. If the task changes while a run is active, its result becomes stale and
requires revalidation before promotion.

## Runtime validation

Repository and workspace manifests fail closed when their schema, identity, or workspace-directory
binding is invalid. Invalid task files do not crash the repository worker: they are excluded from the
canonical task collection and returned as structured validation issues with a source path, field,
code, severity, and message.

Dependencies use explicit semantics:

```yaml
dependencies:
  - taskKey: PHA-001
    relation: blocks_start
    requiredState: done
```

Local task IDs resolve inside the repository and normalize to `<workspace-slug>/<task-id>`. Full keys
can reference another workspace. Task IDs must be unique within a repository; unresolved dependencies
and dependency cycles are reported in the task snapshot.

The worker exposes one `TaskSnapshot` containing canonical tasks, validation issues, normalized graph
edges, and a generated timestamp. Editing any file below `.phaseatlas/` invalidates the cached
projection and notifies the renderer to fetch a fresh snapshot.

## Model generation policy

Models generate task outlines in a read-only planning run using
`packages/contracts/schemas/task-proposal.schema.json`. Backend policy assigns final IDs, constrains
paths and commands, detects dependency cycles, and determines approval requirements. Repository-scoped
planning may also propose one reviewed workspace boundary with starter tasks. Proposal creation and
task execution are separate runs. Body initialization is also a separate, post-publish run using
`packages/contracts/schemas/task-content.schema.json`; it may target one task or a selected batch.
