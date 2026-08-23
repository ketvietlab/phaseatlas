# ADR 0006: Canonical tasks live in a Git ref, not on the branch you work on

- Status: Accepted
- Date: 2026-08-23

## Context

[ADR 0002](0002-storage-boundaries.md) put canonical task contracts in Git under `.phaseatlas/`, and
that part was right: a task should be versioned, diffable, reviewable, and readable with no PhaseAtlas
running. What it did not settle was *where in Git*, and the answer it implied — ordinary tracked files
on the working branch — put planning metadata in the same namespace as the code.

The consequences were not theoretical:

- an intermediate `phaseatlas/tasks` branch had to be reconciled with `main` by hand, and drifted to
  one commit ahead and forty-eight behind;
- editing one task meant a commit and a push on a code branch;
- merging code meant merging task metadata with it, and a rebase moved both;
- two writers editing different tasks still contended for the same branch tip.

GitHub Projects was considered as an alternative source of truth and rejected. It is a hosted service:
adopting it would end offline operation, move authority out of the repository, and bind a
host-neutral tool to one forge — three properties the product is built on. Being on GitHub is not the
same as being a GitHub application.

## Decision

Canonical tasks are stored in a dedicated Git ref, written with plumbing and never checked out.
`.phaseatlas/` in the working tree becomes a materialized cache and is ignored by Git.

```text
refs/heads/phaseatlas/task-store     the tasks, and nothing else
.phaseatlas/                         a cache of that ref, gitignored
```

A task remains a Git object: versioned, pushable, shareable, inspectable with `git ls-tree` and no
application running. What changes is only that it is no longer in the namespace the code occupies, so
it cannot appear in `git status`, a rebase, a merge, or a pull request for a code change.

The default is a branch rather than a true hidden ref (`refs/phaseatlas/*`) for one unglamorous
reason: GitHub refuses a push to any ref outside `refs/heads/*` and `refs/tags/*`. Because it is never
checked out, it behaves like a hidden ref in every way that caused the original problem. A
self-hosted deployment can set `PHASEATLAS_TASK_REF` to a true hidden ref and lose nothing.

A ref whose tree holds anything besides `.phaseatlas` is refused as a task store, so the mistake this
ADR undoes cannot be made again by pointing the store at a working branch.

## Concurrency

Writes are safe in three layers, because the failure worth preventing is the silent one.

1. **Serialized per checkout.** One worker owns one checkout, and writes queue inside it.
2. **Compare-and-swap.** `update-ref` is given the old value, so a ref that moved makes the write fail
   rather than overwrite. There is no lost update.
3. **Three-way merge.** A write is committed against the commit its cache was built from. If the ref
   has moved past it, the two are a fork and are merged with `git merge-tree`. One task is one file,
   so two writers editing different tasks merge cleanly — the common case. Two writers editing the
   same task is the case nothing can decide, and it stops with `E_TASK_REF_CONFLICT` naming the tasks
   rather than picking a winner. Both versions remain in the ref history.

Tracking the merge base matters more than it looks. A compare-and-swap alone only asks "did the ref
move *while* I was writing"; it misses the ref having moved *before* the write, where committing the
cache would quietly drop whatever arrived in between.

## Consequences

Local edits are never discarded. On open, a cache that differs from the ref is committed before
anything is written back over it, so hand-editing `.phaseatlas/` outside PhaseAtlas is still safe.

A repository whose tasks are still tracked files seeds the ref from them the first time it is opened,
so adopting this costs nobody a migration step. Untracking `.phaseatlas/` is a one-time
`git rm -r --cached .phaseatlas` on the code branch; the files stay on disk as the cache.

The cost is real and worth stating: tasks no longer appear as files in a code branch, so they are not
visible in a pull-request diff or in a forge's file browser, and a plain `git clone` does not bring
them without also fetching the ref. Reviewing a task change means reading the ref's history rather
than a PR. A repository that wants tasks reviewed alongside code in the same pull request should not
adopt this and should commit `.phaseatlas/` on the working branch instead.
