# Isolated chat edit attempts

Repository chat is read-only by default. Edit mode is a separate isolated operation; it
does not make `AgentRunSpec` task fields optional and it does not grant a conversation canonical task
authority.

## Lifecycle

1. `chat.edit.prepare` validates the open chat session, provider-discovered model, application-level
   access mode, attachments, current checkout identity, and base revision. It snapshots a bounded window
   of the session transcript so follow-up requests retain their Ask-mode context across reload. Recent
   safe attachments are inherited within the existing attachment limits. It returns a confirmation digest
   and does not allocate a worktree or start a provider. `ask_for_approval` displays the prepared request
   before start; `full_access` lets the renderer start it immediately.
2. `chat.edit.start` accepts only the prepared edit ID and exact digest. It revalidates the base and
   provider catalog, then allocates a PhaseAtlas-owned worktree and invokes the provider there.
3. PhaseAtlas persists normalized activity and derives changed files and the bounded patch from Git.
   Model-reported files are advisory. Forbidden, unsafe, or escaping paths become blockers.
4. A completed attempt remains isolated in `pending_review`. The user may accept, discard, continue with
   a newly confirmed attempt, or retain it for recovery.
5. Accept requires an unchanged base, a clean canonical checkout, no blockers, and a clean cherry-pick of
   the reviewed isolated commit. Conflicts are aborted and the worktree remains available. Discard removes
   only the owned worktree. Retain never mutates the canonical checkout.

After a worker restart, active retained leases become abandoned and require `chat.edit.recover` with an
explicit `resume_review` or `discard` decision. Lease identity and containment are revalidated before
either action.

## Fixed policy

- No write-capable provider runs in the canonical checkout.
- Edit attempts may change the whole repository, including dependencies and database migrations; `.git`
  and `.phaseatlas` remain protected.
- External network access, caller-supplied worktree paths, and canonical-checkout writes are not accepted
  by the edit API.
- Repository path references and user-supplied images are available in Edit mode under the same bounded
  attachment policy as Ask mode.
- The current edit request has final authority over the captured chronological conversation. Assistant
  messages and attachment contents are context, not higher-priority instructions.
- The renderer receives bounded patches and public normalized events, never provider credentials or raw
  private runtime paths.
- Chat cannot publish YAML, change task state, promote evidence, or auto-accept a diff.

“Create task” hands advisory conversation context to the existing planning UI. The user reviews and edits
the proposals, and publication still goes through the canonical planning publisher and validation rules.
