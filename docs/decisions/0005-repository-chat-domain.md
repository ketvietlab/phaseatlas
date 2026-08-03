# ADR 0005: Keep repository chat separate from canonical task execution

- Status: accepted
- Date: 2026-08-04

## Context

Users need to ask an agent about an open repository without first creating a workspace or canonical
task. PhaseAtlas already has planning and task-execution contracts, but making their task identifiers
optional would blur authority, persistence, sandbox, and completion semantics.

## Decision

Introduce a checkout-scoped repository chat domain with its own sessions, messages, turns, normalized
events, cancellation, replay, and recovery contracts. Chat sessions use stable PhaseAtlas identifiers
and a runner/model pair from the repository's current provider discovery. Codex CLI and Claude Code
remain behind one provider-neutral adapter boundary.

Persist chat history in the checkout operational store, never under `.phaseatlas/`. Keep the public
API free of workspace and task identifiers. Chat runs read-only, accepts only safe repository-relative
attachment references, and has no authority to modify files, publish planning output, transition
canonical tasks, or promote evidence.

Provider continuation state is private adapter state. This first implementation uses ephemeral
provider invocations with a bounded PhaseAtlas transcript, so restart and provider switching behavior
do not depend on an opaque provider session identifier.

## Consequences

- Multiple conversations can survive application restart independently of workspace and task state.
- Renderer code can consume one event vocabulary for supported providers.
- Task execution remains strict: a chat response cannot be mistaken for a validated `AgentRunResult`.
- Longer conversations require bounded transcript projection until a private continuation or
  summarization strategy is introduced.
- Repository mutation requires a separate, explicit worktree workflow.
