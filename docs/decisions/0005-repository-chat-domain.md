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
API free of workspace and task identifiers. Chat runs read-only, accepts safe repository-relative
attachment references and bounded user-supplied images as untrusted context, and has no authority to
modify files, publish planning output, transition canonical tasks, or promote evidence.

Provider continuation state is private adapter state. This first implementation uses ephemeral
provider invocations with a bounded PhaseAtlas transcript, so restart and provider switching behavior
do not depend on an opaque provider session identifier.

Provider command and repository-tool output is also private adapter state. Adapters count output
bytes for lightweight activity metadata but do not accumulate, publish, or persist the content.
Existing persisted chat tool output is scrubbed during operational-store migration, and no renderer
API can retrieve it. Assistant text and bounded reasoning summaries remain incrementally replayable.

## Consequences

- Multiple conversations can survive application restart independently of workspace and task state.
- Renderer code can consume one event vocabulary for supported providers.
- Large command output cannot grow renderer memory, IPC traffic, or chat replay payloads.
- Provider adapters validate and translate image attachments without exposing a generic local-file
  or arbitrary provider-payload channel to the renderer.
- Task execution remains strict: a chat response cannot be mistaken for a validated `AgentRunResult`.
- Longer conversations require bounded transcript projection until a private continuation or
  summarization strategy is introduced.
- Repository mutation requires a separate, explicit worktree workflow.
