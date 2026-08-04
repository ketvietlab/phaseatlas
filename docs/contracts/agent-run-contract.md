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

Preparation failure after allocation, normal success, execution failure, cancellation, or adapter
rejection releases the exact registered worktree in a guaranteed cleanup path. Before removal, the
manager revalidates checkout identity, managed-root containment, lease/path identity, and Git worktree
registration. It never accepts a caller path.

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

`command.output` text is persisted in `agent_command_outputs`, separate from the replay payload.
Timeline replay exposes only the command ID and character count. The renderer must explicitly request
a command and receives at most 50,000 characters per page; the workbench uses 20,000-character pages
and replaces the visible page during navigation. Collapsing a command removes its output from renderer
state and the DOM. Live events therefore cannot push raw command output across IPC.

## Provider and model discovery

Repository workers expose providers through stable runner IDs, never executable paths. A runner
descriptor contains a bounded execution capability projection plus a model catalog discovered from
the installed, authenticated provider CLI. Each model entry contains only its stable ID, display
name, provider-default marker, and supported reasoning-effort labels. Raw provider catalog payloads,
instructions, credentials, executable locations, and authentication details do not cross the worker
boundary.

Repository UI preferences store only the selected runner ID, model ID, and optional reasoning-effort
label for a checkout. The active selection remains visible in the repository header. Model and effort
share one compact selector because effort belongs to a specific model catalog entry. Before any
planning, task-content, chat, isolated edit, or task-run handoff, the repository worker compares both
values with a fresh descriptor and rejects a model or effort that is not present. When discovery is
unavailable, the UI disables model-dependent actions; it never substitutes a free-form field or a
hardcoded catalog.

Execution adapters receive the same trusted model and effort selection through the provider-neutral
execution boundary. They may translate those values into private CLI arguments, but they cannot
accept a renderer-supplied executable, command, working directory, or permission flag. Agent run
specifications and chat sessions persist the selected effort so replay and retry do not silently use
a different provider policy after restart.

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

## Durable lifecycle and terminal ordering

The checkout operational store is the lifecycle authority. A scheduler first persists the immutable
run specification, then starts the provider. Each normalized event is assigned and committed with the
next checkout-local sequence before it is published live. A validated result is persisted before a
terminal event can be observed.

Runs have one of these terminal states:

```text
completed | failed | cancelled | interrupted
```

Completion, cancellation, adapter failure, and startup recovery all compete through one atomic
compare-and-set transition. The winner establishes the terminal state; later terminal attempts are
idempotent and provider output after terminalization is rejected. Only recognized lease audit events
and result-revalidation records may be appended after terminal state.

Task references are resolved and normalized before scheduling. A checkout permits at most one
starting or active agent run for a canonical task, while different tasks may still execute in
parallel. Once an adapter emits a terminal failure or cancellation, the scheduler cannot validate or
persist a later success result from that adapter.

## Cursor replay

Consumers read bounded pages strictly after a durable sequence cursor:

```text
events where sequence > afterSequence, ordered ascending, limit 1..500
```

The returned `nextSequence` is the last event in the page, or the supplied cursor for an empty page.
`hasMore` indicates that persisted events remain. A reconnecting renderer replays from its last
contiguous sequence and merges live events by sequence; timestamps, provider sequence numbers, and
arrival order are never cursor authority.

## Cancellation and process ownership

Cancellation is idempotent. The worker aborts the owned provider process group, first requests graceful
termination, waits for confirmed process close, and applies bounded force termination when necessary.
It stops accepting provider output as soon as cancellation is requested. Only after the process is
confirmed closed may the run become `cancelled` and its exact lease be released or retained under the
worktree recovery policy.

The renderer cannot supply a process identifier, signal, command, executable, working directory, or
grace period. Those remain private adapter and worker concerns.

## Interruption and recovery

At startup, a previously active run becomes `interrupted`; it is never presented as completed and is
not silently restarted. Recovery is an explicit choice:

- leave the original run interrupted; or
- create a new run with a new identifier from the current validated canonical task and link it to the
  interrupted attempt.

The new attempt receives a fresh specification, runner/model validation, revision, and worktree lease.
The original run, events, result if any, and retry linkage remain immutable audit history.

## Result freshness and promotion

Every persisted result records the immutable task revision used by its run. Core review compares that
revision with the current canonical task before any evidence or state promotion:

- an exact match is `current`;
- a mismatch is `stale` and non-promotable;
- a missing or invalid current task is `unverifiable` and non-promotable.

A trusted revalidation may restore `current` only when it records the exact current revision for the
same result. If the canonical task changes again, that revalidation no longer matches and the result
immediately becomes stale. Renderer state and provider output cannot create revalidation authority.
