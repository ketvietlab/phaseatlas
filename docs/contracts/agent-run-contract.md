# Agent run contract

## Immutable input

An `AgentRunSpec` freezes the task revision, objective, repository/worktree, scope, acceptance criteria,
verification commands, and sandbox choice. Runtime code must not reconstruct a prompt directly from
mutable source documents after the run starts.

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

Every persisted event has a monotonically increasing sequence number. Reconnects resume after the last
stored sequence, and the final message is fetched from persistence rather than reconstructed only from
in-memory deltas.

## Result

Runner adapters use `packages/contracts/schemas/agent-run-result.schema.json` for structured final
output. The result contains changed files, verification results, produced evidence, blockers, next
action, and a proposed state. Proposed state is advisory. Provider-specific output remains behind the
adapter boundary and never changes the canonical task contract.

## Safety defaults

- Planning, analysis, and review default to `read-only`.
- Implementing requires a unique worktree and `workspace-write`.
- The renderer cannot supply an arbitrary command or working directory.
- External network, migrations, dependency edits, and release actions are explicit capabilities.
- No API key or CLI credential crosses the renderer boundary.
