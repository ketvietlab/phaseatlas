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

## Sharing

The same three layers carry the ref to and from a remote, so a second machine is not a manual
`git fetch` away: opening a repository fetches, and recording a task pushes.

Network failure is not data failure. A remote that cannot be reached is reported and ignored, leaving
the local ref authoritative — the point of a local-first tool is that the network is an optimisation.
A remote that simply has no task ref yet is not a failure either; that is what the first machine to
publish encounters, and treating it as one would stop it ever pushing.

Two consequences of moving the ref from underneath the cache are worth stating, because both were
found by tests rather than by reasoning:

- a checkout opening the store for the first time has no `.phaseatlas/` at all, and reading that empty
  directory as "every task was deleted" would commit an empty tree over the whole store. Only a cache
  this store has itself materialized can speak for a deletion;
- when a fetch brings another machine's work in, the cache must be rebuilt from the new commit, or the
  next write reads those tasks as absent and commits their deletion.

## Consequences

Local edits are never discarded. On open, a cache that differs from the ref is committed before
anything is written back over it, so hand-editing `.phaseatlas/` outside PhaseAtlas is still safe.

A repository whose tasks are still tracked files seeds the ref from them the first time it is opened,
so the data moves with no migration step. Untracking them is a separate matter, and deliberately not
automatic: `git rm --cached` stages a deletion in somebody's index and editing `.gitignore` changes a
tracked file, and a tool that did either unasked would eventually fold those changes into an unrelated
commit.

Seeding therefore leaves a repository half moved, which is worse than either end state because it is
quiet: everything looks correct until the first task is deleted or renamed, at which point the change
surfaces as a modification to a tracked file on a code branch. The worker detects that state on open
and reports it, and `task-storage.migrate` completes it when a person asks — untracking the files,
ignoring the cache, and leaving the staged result for them to commit. Migration refuses to untrack
tasks that exist nowhere else, so it can never be the step that loses them.

The cost is real and worth stating: tasks no longer appear as files in a code branch, so they are not
visible in a pull-request diff or in a forge's file browser. Reviewing a task change means reading the
ref's history rather than a PR. A repository that wants tasks reviewed alongside code in the same pull
request should not adopt this and should commit `.phaseatlas/` on the working branch instead.

A plain `git clone` still does not bring the ref, since Git fetches only branches by default. It costs
nobody anything in practice — opening the repository in PhaseAtlas fetches it — but a script that
expects to read tasks straight out of a fresh clone needs the refspec:

```bash
git fetch origin +refs/heads/phaseatlas/task-store:refs/heads/phaseatlas/task-store
```
