# Repository chat contract

## Domain boundary

A repository chat session belongs to one checkout and one registered provider runner. It is not a
planning run, canonical task, task execution, or source of completion evidence. Public chat inputs do
not contain a workspace slug or task key, and chat output cannot publish contracts, transition task
state, or promote evidence.

PhaseAtlas owns the public session and turn identifiers. Provider conversation identifiers, process
handles, executable paths, authentication state, permission flags, and raw protocol payloads remain
private to the repository worker.

## Session and turn lifecycle

A caller creates a session with a runner and a model selected from that runner's discovered catalog.
The worker records the checkout identity with the session and revalidates the runner and model before
every send or retry. A missing runner, stale model, closed session, or concurrent active turn fails
closed.

Sessions are independently listable, resumable, renameable, and closeable. Closing a session retains
its messages, turns, and events for history. A closed session cannot accept another turn.

Turns transition through:

```text
starting -> running -> completed | failed | cancelled | interrupted
```

Only one active turn may exist in a session. Retrying is explicit, creates a new linked turn, and
reuses the original user message without mutating the interrupted attempt.

## Messages and attachments

Messages are checkout-owned operational data with a durable, gap-free sequence per session. Public
send requests contain bounded text and an optional bounded list of repository-relative references or
user-supplied images. The worker rejects traversal, `.git` targets, secret-like files, absolute paths,
unknown fields, unsupported image media types, and images outside the per-file or aggregate limits.

Repository attachments are references for provider context, not a generic local-file API. The
provider receives only safe paths beneath the worker's fixed repository root. Image attachments are
explicit user-provided visual context encoded in the typed chat request; they are treated as
untrusted content, validated before persistence, and projected only into providers that support the
declared media type. Credential-shaped message content is redacted before persistence, and raw
environments or provider payloads are never stored.

## Read-only execution

Repository chat is read-only. The Codex adapter uses a read-only sandbox and the Claude adapter
permits only repository inspection tools. Unknown tools, file-change events, or repository changes
during a turn invalidate the result. The renderer cannot supply a command, executable, working
directory, environment, sandbox, permission mode, or process identifier.

Mutation is intentionally outside this contract. A future user-authorized worktree workflow may use
chat context, but it must establish separate write authority and cannot retroactively turn a chat
response into a canonical task result.

## Normalized event stream

Provider-specific output is projected incrementally into shared activity. An assistant delta is
persisted and published as it arrives; the renderer does not wait for provider completion before
showing readable content:

```text
chat.turn.status
chat.assistant.delta
chat.reasoning
chat.tool.started
chat.tool.output
chat.tool.completed
chat.file.reference
chat.usage
chat.turn.completed | chat.turn.failed | chat.turn.cancelled | chat.turn.interrupted
```

The checkout operational store assigns the authoritative monotonically increasing sequence and
persists each event before live publication. Raw provider sequence values and arrival timestamps are
not cursor authority. Terminal events are unique, and output after terminalization is rejected.

## Replay, cancellation, and recovery

Consumers request bounded pages strictly after a durable sequence cursor. A reconnecting consumer
replays through the current tail and merges live events by sequence, so renderer, worker, and desktop
restarts do not create gaps or duplicates.

Cancellation aborts the worker-owned provider operation, waits for it to settle, and competes through
the same terminal-state guard as completion or failure. Repeated cancellation returns the existing
terminal result and cannot append another terminal event.

At worker startup, an active turn becomes `interrupted` exactly once. It is never silently resumed or
presented as completed; an explicit retry creates a linked attempt after current runner and model
validation.
