// Canonical tasks live in a Git ref of their own, not in the branch you work on.
//
// They used to be ordinary tracked files. That made them versioned and reviewable,
// and it also put them in the same namespace as the code: every task edit was a
// commit on a working branch, the intermediate `phaseatlas/tasks` branch had to be
// reconciled with `main` by hand, and merging code meant merging planning metadata
// with it.
//
// The fix is not to leave Git — a task is still a Git object, still versioned,
// still pushable, still readable with no PhaseAtlas running. The fix is to stop
// putting it where the code lives. This ref is written with plumbing and never
// checked out, so nothing about it reaches `git status`, a rebase, or a pull
// request. `.phaseatlas/` in the working tree becomes a cache this materializes.
//
// Concurrency is three layers, because the interesting failure is silent:
//   1. the worker serializes writes for one checkout (one worker per checkout);
//   2. `update-ref` takes the old value, so a racing write fails instead of
//      overwriting — there is no lost update, ever;
//   3. a failed compare-and-swap is retried through a real three-way merge, which
//      succeeds when two writers touched different tasks (the common case, since
//      one task is one file) and fails loudly when they touched the same one.
//
// The same three layers carry the ref to and from a remote, so a second machine is
// not a manual `git fetch` away. Network failure is not a data failure: being
// unable to reach the remote leaves the local ref authoritative and the
// application working, because the point of a local-first tool is that the network
// is an optimisation. A conflict between two machines is a data failure and is
// reported exactly as a conflict between two local writers is.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Where the tasks live. A path under `.phaseatlas/` and nothing else. */
export const TASK_ROOT = ".phaseatlas";

/**
 * A branch rather than `refs/phaseatlas/*` by default, for one unglamorous reason:
 * GitHub refuses a push to any ref outside `refs/heads/*` and `refs/tags/*`. This
 * is never checked out, so it behaves like a hidden ref in every way that caused
 * the original problem — it simply remains pushable to the host most people use.
 * A self-hosted deployment can point `PHASEATLAS_TASK_REF` at a true hidden ref.
 */
export const DEFAULT_TASK_REF = "refs/heads/phaseatlas/task-store";

export type TaskRefGit = (
  args: string[],
  options?: { env?: Record<string, string>; timeoutMs?: number },
) => Promise<string>;

export class TaskRefError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly conflicts: string[];

  constructor(code: string, message: string, hint: string, conflicts: string[] = []) {
    super(message);
    this.name = "TaskRefError";
    this.code = code;
    this.hint = hint;
    this.conflicts = conflicts;
  }
}

export interface TaskRefCommit {
  /** Null when the store held no tasks and none were written. */
  readonly commit: string | null;
  /** True when nothing in `.phaseatlas/` differed from what the ref already held. */
  readonly unchanged: boolean;
  /** True when a concurrent write was merged in rather than overwritten. */
  readonly merged: boolean;
  readonly remote: TaskRefRemote;
}

export interface TaskRefSync {
  readonly commit: string | null;
  /** What the sync had to do — useful in a log, and in a test. */
  readonly action: "empty" | "seeded" | "materialized" | "committed" | "merged";
  readonly remote: TaskRefRemote;
}

/**
 * What talking to the remote achieved, if anything.
 *
 * `unreachable` is not an error the caller has to handle: it is the ordinary state
 * of a laptop on a train, and the local ref remains the authority until the
 * network comes back.
 */
export interface TaskRefRemote {
  readonly attempted: boolean;
  readonly fetched: "none" | "up-to-date" | "fast-forward" | "merged";
  readonly pushed: "none" | "up-to-date" | "pushed";
  readonly reason?: "disabled" | "no-remote" | "no-remote-ref" | "unreachable";
  readonly detail?: string;
}

const QUIET: TaskRefRemote = { attempted: false, fetched: "none", pushed: "none" };

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class TaskRefStore {
  readonly ref: string;
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * The commit the working-tree cache was last built from.
   *
   * Without it a write can only ask "did the ref move while I was writing", which
   * misses the case that actually loses data: the ref moved *before* the write, so
   * the cache describes an older state and committing it would drop whatever
   * arrived in between. This is the merge base — the answer to "what did both
   * sides start from".
   */
  private base: string | null = null;

  private readonly remoteName: string | null;
  private readonly networkTimeoutMs: number;

  constructor(
    private readonly repositoryPath: string,
    options: { ref?: string; git?: TaskRefGit; remote?: string | null; networkTimeoutMs?: number } = {},
  ) {
    if (!path.isAbsolute(repositoryPath)) throw new Error("Task ref store needs an absolute repository path.");
    this.ref = options.ref ?? DEFAULT_TASK_REF;
    this.remoteName = options.remote === undefined ? "origin" : options.remote;
    // Bounded on purpose: an unreachable host must cost a moment, not a hang. A
    // publish that waits on the network is a publish the user experiences as broken.
    this.networkTimeoutMs = options.networkTimeoutMs ?? 15_000;
    if (options.git) this.git = options.git;
  }

  private git: TaskRefGit = async (args, options = {}) => {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.repositoryPath,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...(options.env ?? {}) },
      ...(options.timeoutMs ? { timeout: options.timeoutMs, killSignal: "SIGKILL" as const } : {}),
    });
    return stdout;
  };

  /** The commit the ref points at, or null when it does not exist yet. */
  async head(): Promise<string | null> {
    try {
      return (await this.git(["rev-parse", "--verify", "--quiet", `${this.ref}^{commit}`])).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Bring the working-tree cache and the ref into agreement.
   *
   * Local edits are never discarded: if `.phaseatlas/` differs from the ref, that
   * difference is committed before anything is written back over it. That is what
   * makes it safe to treat the directory as a cache — the only way to lose an edit
   * would be to overwrite it, and this commits first.
   */
  async sync(message = "phaseatlas: sync task store"): Promise<TaskRefSync> {
    return this.exclusive(async () => {
      // Whatever another machine recorded arrives first, so the local write below
      // is made against it rather than on top of it.
      const beforeWork = await this.exchange(message);
      const working = await this.workingTree();
      let head = await this.head();

      if (!head) {
        if (working === EMPTY_TREE) return { commit: null, action: "empty" as const, remote: beforeWork };
        const commit = await this.write(working, null, "phaseatlas: seed task store");
        this.base = commit;
        return { commit, action: "seeded" as const, remote: await this.exchange(message) };
      }

      await this.assertTaskOnly(head);
      const stored = (await this.git(["rev-parse", `${head}^{tree}`])).trim();
      if (stored === working) {
        this.base = head;
        await this.materializeTree(head);
        return { commit: head, action: "materialized" as const, remote: beforeWork };
      }

      // An empty cache that was never filled is not an opinion about the tasks.
      // A checkout opening the store for the first time — a second machine, a fresh
      // clone — has no `.phaseatlas/` yet, and reading that as "every task was
      // deleted" would commit an empty tree over the whole store. Only a cache this
      // store has actually materialized can speak for a deletion.
      if (this.base === null && working === EMPTY_TREE) {
        this.base = head;
        await this.materializeTree(head);
        return { commit: head, action: "materialized" as const, remote: beforeWork };
      }

      const result = await this.commitTree(working, message);
      if (result.commit) await this.materializeTree(result.commit);
      head = result.commit;
      return {
        commit: head,
        action: result.merged ? "merged" : "committed",
        remote: await this.exchange(message),
      };
    });
  }

  /**
   * Record whatever `.phaseatlas/` currently holds as the next state of the ref.
   *
   * Called after a publish or a save has already written its files, so the write
   * path above stays exactly as it was: ordinary files, atomic rename, no Git.
   */
  async commit(message: string): Promise<TaskRefCommit> {
    return this.exclusive(async () => {
      const result = await this.commitTree(await this.workingTree(), message);
      // Sending it on is part of recording it. A push that cannot reach the host
      // leaves the local ref authoritative and is reported, not thrown.
      const remote = result.unchanged ? QUIET : await this.exchange(message);
      return { ...result, remote };
    });
  }

  /** Write the ref's tree into the working tree, replacing the cache. */
  async materialize(): Promise<string | null> {
    return this.exclusive(async () => {
      const head = await this.head();
      if (head) {
        await this.assertTaskOnly(head);
        await this.materializeTree(head);
      }
      // The cache now describes exactly this commit, so it is the base any later
      // write forks from.
      this.base = head;
      return head;
    });
  }

  // ── remote ───────────────────────────────────────────────────────────────

  /**
   * Bring the remote's tasks in, then send ours out.
   *
   * Called around every sync and every write, so a second machine needs no manual
   * fetch. Everything here is best-effort with respect to the network and strict
   * with respect to the data: a host that cannot be reached is reported and
   * ignored, a task changed on both machines is reported and refused.
   */
  private async exchange(message: string): Promise<TaskRefRemote> {
    if (process.env.PHASEATLAS_TASK_SYNC === "off") {
      return { attempted: false, fetched: "none", pushed: "none", reason: "disabled" };
    }
    const remote = await this.resolveRemote();
    if (!remote) return { attempted: false, fetched: "none", pushed: "none", reason: "no-remote" };

    let fetched: TaskRefRemote["fetched"] = "none";
    try {
      const before = await this.head();
      fetched = await this.pull(remote, message);
      const after = await this.head();
      if (after && after !== before) {
        // The ref took on work from another machine. Leaving the cache behind would
        // make the next write read those tasks as absent, and commit their deletion.
        await this.materializeTree(after);
        this.base = after;
      }
    } catch (error) {
      if (error instanceof TaskRefError) throw error; // a conflict is data, not network
      return {
        attempted: true,
        fetched: "none",
        pushed: "none",
        reason: "unreachable",
        detail: (error as Error).message,
      };
    }

    try {
      return { attempted: true, fetched, pushed: await this.push(remote) };
    } catch (error) {
      if (error instanceof TaskRefError) throw error;
      return {
        attempted: true,
        fetched,
        pushed: "none",
        reason: "unreachable",
        detail: (error as Error).message,
      };
    }
  }

  private async resolveRemote(): Promise<string | null> {
    if (!this.remoteName) return null;
    const remotes = (await this.git(["remote"])).trim().split("\n").filter(Boolean);
    if (!remotes.length) return null;
    return remotes.includes(this.remoteName) ? this.remoteName : (remotes[0] as string);
  }

  /** Where a fetched copy of the remote's task ref is kept locally. */
  private trackingRef(remote: string): string {
    return this.ref.startsWith("refs/heads/")
      ? `refs/remotes/${remote}/${this.ref.slice("refs/heads/".length)}`
      : `refs/phaseatlas/remotes/${remote}/${this.ref.replace(/^refs\//, "")}`;
  }

  private async pull(remote: string, message: string): Promise<TaskRefRemote["fetched"]> {
    const tracking = this.trackingRef(remote);
    try {
      await this.git(["fetch", "--no-tags", "--quiet", remote, `+${this.ref}:${tracking}`], {
        timeoutMs: this.networkTimeoutMs,
      });
    } catch (error) {
      // A remote that has never been given the task ref is not an unreachable one.
      // The distinction matters: the first machine to publish reaches exactly this
      // path, and treating it as a network failure would stop it ever pushing.
      const detail = `${String((error as { stderr?: string }).stderr ?? "")}${(error as Error).message ?? ""}`;
      if (!/couldn't find remote ref|not our ref|no such ref/i.test(detail)) throw error;
      return "none";
    }
    const theirs = (await this.git(["rev-parse", "--verify", "--quiet", `${tracking}^{commit}`]).catch(() => ""))
      .trim();
    if (!theirs) return "none";
    await this.assertTaskOnly(theirs);

    const ours = await this.head();
    if (!ours) {
      // Nothing here yet: adopt the remote wholesale.
      await this.git(["update-ref", this.ref, theirs]);
      this.base = null;
      return "fast-forward";
    }
    if (ours === theirs) return "up-to-date";
    if (await this.isAncestor(theirs, ours)) return "up-to-date"; // we are ahead
    if (await this.isAncestor(ours, theirs)) {
      await this.git(["update-ref", this.ref, theirs, ours]);
      // The cache was built from a commit that is still an ancestor, so it stays a
      // valid merge base for anything uncommitted in it.
      return "fast-forward";
    }
    // mergeCommits writes the commit and moves the ref under compare-and-swap, so
    // there is nothing left to update here.
    await this.mergeCommits(ours, theirs, `${message} (merge remote)`);
    return "merged";
  }

  private async push(remote: string): Promise<TaskRefRemote["pushed"]> {
    const head = await this.head();
    if (!head) return "none";
    const tracking = this.trackingRef(remote);
    const known = (await this.git(["rev-parse", "--verify", "--quiet", `${tracking}^{commit}`]).catch(() => ""))
      .trim();
    if (known === head) return "up-to-date";
    await this.git(["push", remote, `${head}:${this.ref}`], { timeoutMs: this.networkTimeoutMs });
    // Keep the tracking ref honest so the next push can tell "already sent" from
    // "not sent yet" without another round trip.
    await this.git(["update-ref", tracking, head]);
    return "pushed";
  }

  private async isAncestor(candidate: string, descendant: string): Promise<boolean> {
    try {
      await this.git(["merge-base", "--is-ancestor", candidate, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Merge two commits that both exist, using their real merge base.
   *
   * Distinct from the cache-versus-ref merge below, which has a tree on one side
   * and no commit at all, and so has to be told what the base was.
   */
  private async mergeCommits(ours: string, theirs: string, message: string): Promise<string> {
    const base = (await this.git(["merge-base", ours, theirs]).catch(() => "")).trim();
    const baseTree = base ? (await this.git(["rev-parse", `${base}^{tree}`])).trim() : EMPTY_TREE;
    const ourTree = (await this.git(["rev-parse", `${ours}^{tree}`])).trim();
    const theirTree = (await this.git(["rev-parse", `${theirs}^{tree}`])).trim();
    const merged = await this.mergeTrees(baseTree, ourTree, theirTree);
    return this.write(merged, ours, message, [theirs]);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async commitTree(working: string, message: string): Promise<TaskRefCommit> {
    const head = await this.head();
    if (head) await this.assertTaskOnly(head);
    const stored = head ? (await this.git(["rev-parse", `${head}^{tree}`])).trim() : EMPTY_TREE;
    if (stored === working) {
      this.base = head;
      return { commit: head, unchanged: true, merged: false, remote: QUIET };
    }

    // The cache was built from `base`. If the ref has moved past it, this write and
    // whatever moved it are two sides of a fork, and replacing one with the other
    // would be the lost update the compare-and-swap exists to prevent.
    const diverged = (head ?? null) !== (this.base ?? null);
    if (diverged) {
      const commit = await this.mergeOnto(working, message);
      this.base = commit;
      return { commit, unchanged: false, merged: true, remote: QUIET };
    }

    try {
      const commit = await this.write(working, head, message);
      this.base = commit;
      return { commit, unchanged: false, merged: false, remote: QUIET };
    } catch (error) {
      if (!(error instanceof TaskRefError) || error.code !== "E_TASK_REF_RACE") throw error;
      // Someone moved the ref between reading it and writing. Same fork, found a
      // moment later.
      const commit = await this.mergeOnto(working, message);
      this.base = commit;
      return { commit, unchanged: false, merged: true, remote: QUIET };
    }
  }

  private async mergeOnto(working: string, message: string): Promise<string> {
    const theirs = await this.head();
    if (!theirs) throw new TaskRefError("E_TASK_REF_RACE", "The task ref disappeared mid-write.", "retry the operation");
    await this.assertTaskOnly(theirs);
    const theirTree = (await this.git(["rev-parse", `${theirs}^{tree}`])).trim();
    const base = this.base;
    const baseTree = base ? (await this.git(["rev-parse", `${base}^{tree}`])).trim() : EMPTY_TREE;

    const merged = await this.mergeTrees(baseTree, working, theirTree);
    return this.write(merged, theirs, message, base && base !== theirs ? [base] : []);
  }

  /**
   * Three trees in, one tree out — or a refusal.
   *
   * One task is one file, so two writers editing different tasks touch different
   * paths and this merges cleanly, which is the ordinary case. Editing the same
   * task is the case nothing can decide, and it stops here rather than picking a
   * winner: both versions stay reachable in the ref history either way.
   */
  private async mergeTrees(baseTree: string, ourTree: string, theirTree: string): Promise<string> {
    try {
      return (
        (await this.git(["merge-tree", "--write-tree", "--merge-base", baseTree, ourTree, theirTree]))
          .trim()
          .split("\n")[0] as string
      ).trim();
    } catch (error) {
      // merge-tree reports the conflicting paths on stdout and exits non-zero.
      const output = `${String((error as { stdout?: string }).stdout ?? "")}\n${String((error as { stderr?: string }).stderr ?? "")}`;
      const pattern = new RegExp(`${TASK_ROOT}/[^\\s"]+`, "g");
      const conflicts = [...new Set(output.match(pattern) ?? [])];
      throw new TaskRefError(
        "E_TASK_REF_CONFLICT",
        `The task store changed concurrently and the same ${conflicts.length === 1 ? "task was" : "tasks were"} changed on both sides${conflicts.length ? `: ${conflicts.join(", ")}` : ""}.`,
        "reload the workspace and reapply the edit; both versions remain in the ref history",
        conflicts,
      );
    }
  }

  /** Hash the working-tree cache into a tree object without touching the real index. */
  private async workingTree(): Promise<string> {
    return this.withTemporaryIndex(async (env) => {
      // -f because `.phaseatlas/` is deliberately ignored: it is a cache, and an
      // ignored path is exactly what stops it reaching a commit on a code branch.
      await this.git(["add", "-f", "-A", "--", TASK_ROOT], { env }).catch(() => "");
      return (await this.git(["write-tree"], { env })).trim();
    });
  }

  private async materializeTree(commit: string): Promise<void> {
    const tree = (await this.git(["rev-parse", `${commit}^{tree}`])).trim();
    // Removed first: checkout-index writes and overwrites, but never deletes, so a
    // task deleted elsewhere would otherwise linger in the cache forever.
    await rm(path.join(this.repositoryPath, TASK_ROOT), { recursive: true, force: true });
    if (tree === EMPTY_TREE) return;
    await this.withTemporaryIndex(async (env) => {
      await this.git(["read-tree", tree], { env });
      await this.git(["checkout-index", "-a", "-f"], { env });
    });
  }

  private async write(tree: string, parent: string | null, message: string, extraParents: string[] = []): Promise<string> {
    const parents = [...(parent ? [parent] : []), ...extraParents].flatMap((sha) => ["-p", sha]);
    const commit = (
      await this.git(["commit-tree", tree, ...parents, "-m", message], {
        env: {
          GIT_AUTHOR_NAME: "PhaseAtlas",
          GIT_AUTHOR_EMAIL: "phaseatlas@local",
          GIT_COMMITTER_NAME: "PhaseAtlas",
          GIT_COMMITTER_EMAIL: "phaseatlas@local",
        },
      })
    ).trim();
    try {
      // The old value is the whole point: a ref that moved since we read it makes
      // this fail rather than silently discarding whoever moved it.
      await this.git(["update-ref", "-m", message, this.ref, commit, parent ?? ""]);
    } catch (error) {
      throw new TaskRefError(
        "E_TASK_REF_RACE",
        "The task ref moved while this write was being prepared.",
        "the write is retried against the new state automatically",
        [String((error as Error).message)],
      );
    }
    return commit;
  }

  /**
   * A ref that carries code is a branch someone works on, and writing task commits
   * onto it would be the very mistake this exists to undo.
   */
  private async assertTaskOnly(commit: string): Promise<void> {
    const entries = (await this.git(["ls-tree", "--name-only", `${commit}^{tree}`])).trim();
    const outside = entries.split("\n").filter((name) => name && name !== TASK_ROOT);
    if (!outside.length) return;
    throw new TaskRefError(
      "E_TASK_REF_NOT_A_STORE",
      `${this.ref} holds ${outside.slice(0, 3).join(", ")}${outside.length > 3 ? ", …" : ""} beside ${TASK_ROOT}, so it is a branch rather than a task store.`,
      `point PHASEATLAS_TASK_REF at an unused ref, or delete ${this.ref} once its history is no longer needed`,
      outside,
    );
  }

  private async withTemporaryIndex<T>(body: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(path.join(tmpdir(), "phaseatlas-task-ref-"));
    try {
      return await body({ GIT_INDEX_FILE: path.join(directory, "index") });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** One checkout has one worker, and inside it these run one at a time. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
