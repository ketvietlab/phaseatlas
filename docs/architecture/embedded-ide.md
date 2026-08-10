# Embedded repository IDE

PhaseAtlas uses a checkout-bound Eclipse Theia surface for reviewing and editing task bodies and
repository source. It replaces the former renderer-owned Monaco editor, so repository editing has one
explorer, one set of tabs, and one language-service environment.

## Runtime boundary

The renderer selects a registered checkout ID or a retained worktree lease. Electron main resolves
that identity to a canonical absolute path, starts one loopback-only Theia backend for the target, and
paints its sandboxed native view into the repository content column. The renderer cannot choose a
backend entry, port, process, or arbitrary filesystem root.

Each target has isolated configuration, plugins, session storage, and a stable port. Hiding the IDE
keeps editors, terminals, and language servers alive; Stop is the explicit action that releases the
backend. The full trust-boundary decision is recorded in [ADR 0006](../decisions/0006-embedded-theia-runtime.md).

## Workspace surface and AI chat

Theia is the only repository-wide coding and chat surface. PhaseAtlas no longer renders a parallel
repository chat window. Its **AI Chat** action opens the selected repository's canonical IDE target
and then opens Theia's native AI Chat view; the same view remains available from Theia's right activity
bar. When the active repository changes while IDE is visible, PhaseAtlas switches to that repository's
canonical target before presenting source or chat.

The renderer receives one bounded `ide.openChat()` operation. Electron main waits for the Theia shell
and invokes only Theia's fixed AI Chat toggle; it does not expose a generic command or script channel.
Theia registers `Codex` and `ClaudeCode` agents. Fresh target settings enable AI and bypass the unrelated
language-model-provider gate. The repository's PhaseAtlas agent, model, and reasoning-effort selection
is inherited before the target opens and appears in a compact synchronized bar above Theia's chat input.
Changing that bar, or pinning Codex/Claude Code with Theia's native agent control, updates the repository
selection in PhaseAtlas. Every change is checked by Electron main against the repository worker's current
runner catalog before either surface accepts it.

Each backend reads the validated target-local selection at the start of a turn. Codex receives the model
and reasoning effort through the current pinned Codex SDK; Claude Code receives its model and effort
through the pinned Agent SDK. A Codex model/effort change starts a new SDK thread for the next turn so a
cached thread cannot silently keep the old model. Both agents use their existing CLI authentication.

The renderer reports the available CSS-pixel rectangle and Electron main converts it using the host
zoom factor before setting native bounds. This keeps Theia aligned with the PhaseAtlas sidebar,
terminal, and window edges at every application zoom level.

## Presentation

The sandboxed IDE preload applies a bounded PhaseAtlas theme through Theia's public CSS color-token
boundary. The light and dark palettes share PhaseAtlas surfaces, typography, borders, focus color,
selection treatment, tabs, activity bar, buttons, and status bar. Monaco remains an internal Theia
implementation detail; PhaseAtlas no longer bundles or owns a second Monaco editor in its renderer.
Fresh target configuration starts in the source workspace without the generic example welcome page
or extension-recommendation prompt. Missing PhaseAtlas defaults are added to existing target settings,
while the default chat agent is a managed per-repository value synchronized with PhaseAtlas.

## Task body initialization

Publishing never triggers another model call. Users initialize detailed task bodies explicitly, one
task or a bounded batch at a time. Successful Markdown sidecars remain Git-tracked repository files
and can be opened and saved through Theia like any other source file.
