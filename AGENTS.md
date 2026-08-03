# PhaseAtlas contributor guidance

## Toolchain

- Use Node.js `24.14.0` or a newer Node 24+ release.
- Use the pnpm version pinned by the root `packageManager` field.
- Run `pnpm check`, `pnpm test`, and `pnpm build` before handing off changes.

## Architectural boundaries

- Keep the Svelte renderer free of Node.js and Electron imports.
- Expose desktop capabilities only through the typed preload API.
- Keep domain parsing and agent execution out of the Electron main process.
- Bind each repository worker to one canonical checkout root at process startup.
- Treat model-generated task proposals and agent results as untrusted until validated.
- Do not let an agent result directly mark a canonical task complete.

## Data ownership

- Git-tracked `.phaseatlas/` files own repository, workspace, task, policy, and promoted-evidence contracts.
- Application-support storage owns run events, logs, caches, retries, and transient UI state.
- Credentials belong in the operating-system credential store or provider-owned authentication state.

## Changes

- Add shared request, response, and event types to `packages/contracts` before wiring IPC.
- Keep one task per YAML file to reduce merge conflicts.
- Update the relevant ADR or contract document when changing a trust boundary or authority rule.
- Prefer fail-closed behavior when a repository source is missing, invalid, or ambiguous.

