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

## Approved legacy candidate projection

Legacy ingestion is an inspection aid, not a second task authority. It is enabled only when
`.phaseatlas/repository.yaml` is missing. A present and valid manifest selects canonical YAML
exclusively; a present but invalid or unreadable manifest fails closed and never falls back to legacy
inspection. Legacy candidates remain outside `TaskSnapshot`, dependency graphs, task revisions,
execution, and completion state. Publishing one uses the existing reviewed proposal workflow.

The only supported source format is `markdown-checklist/v1`. Sources are inspected in this exact,
case-sensitive order, without recursive discovery or globs:

1. `TODO.md`
2. `docs/TODO.md`
3. `ROADMAP.md`
4. `docs/ROADMAP.md`

Each source must resolve inside the repository root to a regular, non-symlink file no larger than one
MiB. It must be strict UTF-8; an initial UTF-8 BOM is accepted. Other filenames and formats are
unsupported and are not guessed.

### Markdown grammar and normalization

Parsing ignores fenced code blocks. A phase heading and task entry use this exact shape:

```markdown
## Foundation {#foundation}
- [ ] [LEG-001] Add snapshot cache :: Cache repository inspection results.
```

Phase identifiers contain lowercase ASCII letters, digits, and hyphens, with a maximum length of 64.
Native task identifiers match `[A-Z0-9][A-Z0-9._-]{0,63}`. A task begins in column one beneath a valid
phase. Its title contains 1–160 Unicode scalar values and its objective contains 1–2,000. `[x]` and
`[X]` record only a non-authoritative `completed` hint; `[ ]` records `open`.

Text is normalized to NFC, line endings become LF, surrounding whitespace is removed, and runs of
ASCII horizontal whitespace collapse to one space. Native identifiers are preserved. Malformed
top-level checklist entries and unterminated fences produce issues instead of partial tasks.

The projection has the following boundary shape:

```ts
type LegacySourceFormat = "markdown-checklist/v1";
type LegacyCompletionHint = "open" | "completed";

interface LegacySourceLocation {
  path: string;
  nativeId: string;
  line: number;
  column: 1;
}

interface LegacyTaskCandidate {
  candidateId: string;
  sourceFormat: LegacySourceFormat;
  nativeId: string;
  title: string;
  objective: string;
  phaseId: string;
  completionHint: LegacyCompletionHint;
  provenance: {
    primary: LegacySourceLocation;
    identicalDuplicates: LegacySourceLocation[];
  };
  warnings: ValidationIssue[];
}

interface LegacyIngestionSnapshot {
  candidates: LegacyTaskCandidate[];
  issues: ValidationIssue[];
}
```

Candidate identity is `legacy_` followed by the first 32 lowercase hexadecimal characters of SHA-256
over the UTF-8 bytes of these NUL-separated values:

```text
phaseatlas.legacy-candidate/v1\0markdown-checklist/v1\0<native-id>
```

For example, `LEG-001` maps to `legacy_0d54e701694c91540eebd91fc0c0c990`, while `LEG-002` maps to
`legacy_68f2eece99e5a928337079abfbbeb8bc`. Identity therefore does not depend on an absolute checkout
path, source filename, filesystem order, or time.

### Precedence, duplicates, and ordering

Document precedence is the discovery order above; entries within a document use line order. After
validation, candidates sort by native identifier using ASCII byte order, then by candidate ID.
Issues sort by document rank, line, issue code, and message.

Repeated native identifiers with identical normalized phase, title, objective, and completion hint
produce one candidate. The highest-precedence occurrence is primary, lower-precedence occurrences are
recorded as `identicalDuplicates`, and `LEGACY_DUPLICATE_IDENTICAL` is emitted. If any normalized
semantic field differs, every occurrence is excluded and `LEGACY_DUPLICATE_CONFLICT` is emitted.
Distinct native identifiers that produce the same candidate ID are also excluded with
`LEGACY_IDENTITY_COLLISION`. Precedence never chooses a winner for ambiguous content.

### Stable issues and representative outcomes

Source failures use `LEGACY_SOURCE_MISSING` (warning), `LEGACY_SOURCE_NOT_REGULAR`,
`LEGACY_SOURCE_SYMLINK`, `LEGACY_SOURCE_UNREADABLE`, `LEGACY_SOURCE_TOO_LARGE`, and
`LEGACY_SOURCE_INVALID_UTF8` (errors). Unsupported input uses `LEGACY_SOURCE_UNSUPPORTED` (warning).
Parser failures use `LEGACY_MARKDOWN_UNTERMINATED_FENCE`, `LEGACY_PHASE_INVALID`,
`LEGACY_TASK_OUTSIDE_PHASE`, `LEGACY_TASK_SYNTAX_INVALID`, `LEGACY_TASK_ID_INVALID`, and
`LEGACY_TASK_FIELD_INVALID` (errors). Duplicate outcomes use the three codes defined above. Every
issue includes severity, repository-relative path, an optional source location or field, and an
actionable message.

- A single valid `TODO.md` entry above produces the documented `LEG-001` candidate with `TODO.md:2:1`
  as primary provenance.
- The same normalized `LEG-001` entry in `docs/TODO.md` produces one candidate, retains that second
  location as an identical duplicate, and emits `LEGACY_DUPLICATE_IDENTICAL`.
- A `ROADMAP.md` entry reusing `LEG-001` with a different objective excludes all `LEG-001`
  occurrences and emits `LEGACY_DUPLICATE_CONFLICT`; document precedence does not select either one.
- A checklist entry before a valid phase emits `LEGACY_TASK_OUTSIDE_PHASE`; an unterminated fence emits
  `LEGACY_MARKDOWN_UNTERMINATED_FENCE`; neither yields a partial candidate.
- `TASKS.md`, recursively nested TODO files, symlinks, oversized content, and invalid UTF-8 never yield
  candidates. They are ignored or reported using the source policy above.
- When `.phaseatlas/repository.yaml` exists, none of the four legacy documents are inspected. Valid
  canonical YAML remains the sole task source, while an invalid manifest remains a configuration
  error rather than activating legacy fallback.

The implemented core boundary is `RepositoryInspector.legacySnapshot()`. It caches one
`LegacyIngestionSnapshot` independently from the canonical `taskSnapshot()` and clears both caches on
`invalidate()`. The aggregate `inspectRepository()` result exposes both projections without combining
their candidates, issues, revisions, or graph semantics.

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
