# Planning contract

## Purpose

Planning converts a natural-language request into untrusted workspace and task outlines. It does not
modify code branches. A human reviews the outlines before the backend may save registry draft YAML.

```text
request -> runner adapter -> task outlines -> review -> policy validation -> registry draft
                                                              |
                                                              +-> optional body initialization -> Markdown
```

Planning has two targets:

- `workspace`: propose tasks for one existing workspace; `workspaces` must be empty.
- `repository`: propose exactly one new workspace plus one or more starter tasks.

## Runner boundary

The renderer selects a registered runner ID and optional model. The repository worker owns runner
discovery, executable invocation, provider authentication state, cancellation, structured output,
and the fixed repository working directory.

Current planning adapters:

- `codex-cli`: ephemeral execution with a read-only sandbox and task-proposal output schema.
- `claude-code`: non-persistent plan mode with only repository read/search tools and JSON schema.

Both adapters produce the same `PlanningEvent` stream and `PlanningProposalSet`. Provider-specific raw
events never enter the canonical task domain.

## Event stream

Planning events carry a run ID, monotonically increasing sequence, and timestamp:

```text
planning.status
planning.delta
planning.completed
planning.failed
```

Text deltas are batched before crossing Electron IPC. `planning.completed` is accepted only after the
runner result passes runtime validation against the shared task-proposal contract.

## Review and draft

The renderer may edit workspace identity and description, plus task title, objective, kind, phase,
priority, paths, and acceptance criteria. Those edits remain untrusted. Saving validates the full
proposal set again, rejects unsafe paths, collisions, and workspace mismatches, assigns
deterministic workspace-prefixed task IDs, and resolves dependencies between temporary proposal IDs.

For a repository target, the backend writes the workspace manifest and starter tasks into a temporary
sibling directory, then renames it to `.phaseatlas/workspaces/<slug>` as one promoted unit. Any error
before promotion removes the temporary directory. Workspace-targeted task publishing retains its
exclusive-file creation and rollback behavior.

Draft tasks start in `planned`. Suggested capabilities are constrained to safe defaults:

- no external network;
- no dependency changes;
- no database migrations;
- human verification and human-review evidence;
- repository-relative paths only.

The registry `.phaseatlas/` watcher then invalidates projections and refreshes the local task
workbench. The draft becomes canonical only after the user opens Tasks in Theia, validates the full
registry, and chooses **Review & Publish**. The guarded push must still match the registry commit from
which the draft was created.

## Post-publish body initialization

Publishing never triggers another model call. This keeps token use explicit and allows task outlines
to exist without implementation detail. From the canonical task workbench, a user can initialize one
task or select a batch of tasks that do not yet have bodies.

Batch initialization runs up to four independent read-only provider processes concurrently. Each
process receives only one approved task outline, repository context, and the task-content schema.
Provider output streams under the canonical task key. Successful results are written to a Markdown
sidecar and referenced by the YAML task; failures remain isolated and can be retried individually.

Generated Markdown is not immutable. The embedded Theia IDE opens it inside the detached task
registry workspace and writes through the IDE's normal save flow. A save remains a local draft until
the explicit registry publish action succeeds.
