# Agent run contract

## Trusted creation boundary

Callers create a run with identifiers and intent only:

```text
taskKey + expected revision/checkout + action + optional requested sandbox
```

They cannot supply a command, repository path, worktree path, branch, or execution directory. The
checkout-bound repository worker resolves the task from its validated `TaskSnapshot`, rejects any
snapshot with contract errors, verifies repository and checkout identity, and compares the expected
revision before it records or schedules the run.

The resulting `AgentRunSpec` is a deeply frozen snapshot of the task revision, objective, optional
Markdown body, source documents, scope, acceptance criteria, verification steps, action, checkout
identity, sandbox, and trusted execution directory. Later edits to canonical task files do not mutate
an existing spec.

## Sandbox derivation

Trusted scheduling code derives the sandbox from the action:

| Action | Sandbox | Working directory |
| --- | --- | --- |
| `analyze`, `plan`, `review` | `read-only` | canonical checkout |
| `implement` | `workspace-write` | exclusive leased worktree |

An implementation run is rejected when the canonical task is not writable. A caller-requested
sandbox must exactly match the derived sandbox. Executors declare the sandbox modes they can enforce;
the scheduler refuses an executor before handoff when it cannot honor the required mode. The executor
receives only the immutable spec, abort signal, normalized-event sink, and scheduler-selected working
directory.

## Worktree leases

The checkout-scoped lease manager serializes allocation. Every write run receives a random lease ID,
unique `phaseatlas/...` branch, and unique worktree beneath the checkout's application-support runtime
directory. Allocation is recorded in the checkout operational stream before Git worktree creation and
becomes `active` only after creation succeeds.

Normal success, failure, cancellation, or adapter rejection releases the exact registered worktree in
a guaranteed cleanup path. Before removal, the manager revalidates checkout identity, managed-root
containment, lease/path identity, and Git worktree registration. It never accepts a caller path.

On startup, an `allocating`, `active`, or `releasing` lease is changed to `abandoned` and reported through durable
lease events plus `lease.recovery`. Abandoned worktrees are retained for explicit recovery and are
never silently removed, assigned, or reused.

## Event stream

Raw provider output is normalized before it reaches the renderer:

```text
run.status
agent.delta
command.started
command.output
command.completed
file.changed
turn.completed
run.failed
```

The checkout operational store assigns the durable monotonically increasing sequence. Provider
sequence values are not trusted as persistence authority.

## Provider and model discovery

Repository workers expose providers through stable runner IDs, never executable paths. A runner
descriptor contains a bounded execution capability projection plus a model catalog discovered from
the installed, authenticated provider CLI. Each model entry contains only its stable ID, display
name, provider-default marker, and supported reasoning-effort labels. Raw provider catalog payloads,
instructions, credentials, executable locations, and authentication details do not cross the worker
boundary.

Repository UI preferences store only the selected runner and model IDs for a checkout. Before a
planning or task-content provider handoff, the repository worker compares a supplied model ID with a
fresh descriptor and rejects an ID that is not present. When model discovery is unavailable, the UI
disables model-dependent actions; it never substitutes a free-form field or a hardcoded catalog.

Execution adapters receive the same trusted model selection through the provider-neutral execution
boundary when execution orchestration is enabled. They may translate the ID into their private CLI
argument, but they cannot accept a renderer-supplied executable, command, working directory, or
permission flag.

## Git-derived changes and result validation

For write runs, changed files are independently derived from Git in the leased worktree. Paths are
normalized repository-relative paths and checked for traversal, `.git` targets, symlink escape,
forbidden scope, and missing allowed scope. Model-reported `changedFiles` remain advisory and cannot
replace this inspection.

Runner results are validated against `packages/contracts/schemas/agent-run-result.schema.json` and the
shared runtime validator before acceptance. Unsupported fields, unsafe paths, invalid outcomes,
verification records, evidence records, or proposed states fail closed.

The result schema is strict-compatible: every declared object property is required, including the
advisory `proposedTaskState`. This keeps the JSON Schema and TypeScript contract aligned for provider
structured-output APIs.

`proposedTaskState` is always advisory, including `done`. Result acceptance and lease completion never
write canonical task files, promote evidence, or transition task state. Those actions require a
separate authorized verification and promotion workflow.
