# ADR 0004: Keep planning and execution providers neutral

- Status: accepted
- Date: 2026-08-03

## Context

PhaseAtlas must coordinate multiple model CLIs. Provider output formats, sandbox flags,
authentication, models, streaming protocols, and structured-output controls differ.

## Decision

Repository workers own a runner registry. Every adapter exposes common discovery, capabilities,
read-only planning, streaming, cancellation, and structured-result behavior. The renderer addresses
runners by stable ID and consumes only shared contracts.

Codex CLI and Claude Code are the first two planning adapters. Supporting both in the first planning
vertical slice prevents provider-specific assumptions from becoming part of `TaskProposal`,
`CanonicalTask`, IPC, or the UI.

Planning targets either an existing workspace or the repository. Repository-scoped planning returns
one `WorkspaceProposal` with starter tasks; only the reviewed publisher may promote that proposal into
the canonical `.phaseatlas/workspaces/` tree.

The same registry exposes an execution facet for immutable agent specifications. Codex CLI and
Claude Code translate their private JSONL, stream-JSON, sandbox, cancellation, and structured-output
mechanisms into the same normalized events and validated result. Provider success does not bypass
shared validation or grant canonical task authority.

Model selection follows provider discovery. The worker projects the installed CLI's current catalog
into a small shared descriptor and the renderer offers only those values. Reasoning effort is also
selected from the chosen model's discovered catalog, validated again by the worker, and translated
only inside the provider adapter. Repository preferences are operational
`{runnerId, modelId, reasoningEffort?}` data keyed by checkout; they are neither credentials nor
canonical repository configuration. The application does not offer arbitrary CLI paths, free-form
model IDs, or free-form effort labels.

## Consequences

Adding a provider requires an adapter, model-discovery projection, and capability mapping, not
provider-specific renderer changes. Provider
credentials remain in provider-owned authentication state. A successful model response is still
untrusted until backend validation and explicit human publication.
