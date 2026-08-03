# ADR 0004: Keep planning provider-neutral

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

## Consequences

Adding a provider requires an adapter and capability mapping, not renderer changes. Provider
credentials remain in provider-owned authentication state. A successful model response is still
untrusted until backend validation and explicit human publication.
