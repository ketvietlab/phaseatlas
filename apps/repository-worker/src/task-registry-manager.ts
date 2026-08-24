import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CoverageEvent,
  TaskRegistryConfig,
  TaskRegistryPublishInput,
  TaskRegistrySource,
  TaskRegistryWorkspace,
} from "@phaseatlas/contracts";

const executeFile = promisify(execFile);
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const EVENT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export class TaskRegistryManager {
  private readonly localRef: string;
  /** False once a fetch could not reach the remote; reported as `offline`. */
  private reachable = true;

  private constructor(
    private readonly repositoryRoot: string,
    private readonly workspacePath: string,
    readonly config: TaskRegistryConfig,
  ) {
    const checkoutKey = path.basename(path.dirname(workspacePath)).replace(/[^a-zA-Z0-9._-]/g, "-");
    this.localRef = `refs/phaseatlas/task-registry/${checkoutKey}`;
  }

  static async open(options: {
    repositoryRoot: string;
    runtimeRoot: string;
    config: TaskRegistryConfig;
  }): Promise<TaskRegistryManager> {
    const manager = new TaskRegistryManager(
      options.repositoryRoot,
      path.join(options.runtimeRoot, "task-registry"),
      options.config,
    );
    await manager.ensureWorkspace();
    return manager;
  }

  async workspace(): Promise<TaskRegistryWorkspace> {
    return { path: this.workspacePath, source: await this.source() };
  }

  async source(): Promise<TaskRegistrySource> {
    const commit = await this.git(["rev-parse", "HEAD"], this.workspacePath);
    const remoteCommit = await this.git(["rev-parse", this.localRef], this.repositoryRoot).catch(() => commit);
    const changedPaths = await this.changedPaths();
    return {
      ...this.config,
      commit,
      // Unreachable outranks the rest: "current" would claim agreement with a
      // remote nobody has spoken to, and that is the one answer that misleads.
      syncState: !this.reachable
        ? "offline"
        : changedPaths.length
          ? remoteCommit === commit ? "draft" : "conflicted"
          : remoteCommit === commit ? "current" : "ahead",
      changedPaths,
    };
  }

  async sync(): Promise<TaskRegistrySource> {
    const reached = await this.fetch();
    if ((await this.changedPaths()).length) return this.source();
    // Offline, the local ref is where it already was; moving onto it again would
    // be a no-op that can only fail.
    if (reached && (await this.hasLocalRef())) {
      await this.git(["checkout", "--detach", this.localRef], this.workspacePath);
    }
    return this.source();
  }

  async publish(input: TaskRegistryPublishInput): Promise<TaskRegistrySource> {
    if (!COMMIT_PATTERN.test(input.expectedCommit)) throw new Error("The expected task registry commit is invalid.");
    const message = input.message.trim();
    if (!message || message.length > 120 || /[\r\n]/.test(message)) {
      throw new Error("The task registry commit message must contain 1–120 characters on one line.");
    }
    const head = await this.git(["rev-parse", "HEAD"], this.workspacePath);
    if (head !== input.expectedCommit) throw new Error("The task registry draft is based on a different commit.");
    const changedPaths = await this.changedPaths();
    if (!changedPaths.length) throw new Error("There are no task registry changes to publish.");
    if (changedPaths.some((candidate) => candidate !== ".phaseatlas" && !candidate.startsWith(".phaseatlas/"))) {
      throw new Error("Task registry drafts may change only .phaseatlas files.");
    }
    if (changedPaths.includes(".phaseatlas/repository.yaml")) {
      throw new Error("The repository manifest belongs to code branches and cannot be published from the task registry.");
    }

    await this.git(["add", "--", ".phaseatlas"], this.workspacePath);
    await this.git([
      "-c", "user.name=PhaseAtlas",
      "-c", "user.email=phaseatlas@local",
      "commit", "-m", message,
    ], this.workspacePath);
    let commit = await this.git(["rev-parse", "HEAD"], this.workspacePath);
    try {
      commit = await this.pushWithRebase(commit, input.expectedCommit);
      await this.fetch();
    } catch (error) {
      // Preserve the edited files as a draft while returning to the expected
      // base, so a rejected/non-fast-forward push can be reviewed and retried.
      await this.git(["reset", "--mixed", input.expectedCommit], this.workspacePath).catch(() => undefined);
      throw error;
    }
    return { ...this.config, commit, syncState: "current", changedPaths: [] };
  }

  async discard(expectedCommit: string): Promise<TaskRegistrySource> {
    if (!COMMIT_PATTERN.test(expectedCommit)) throw new Error("The expected task registry commit is invalid.");
    const head = await this.git(["rev-parse", "HEAD"], this.workspacePath);
    if (head !== expectedCommit) throw new Error("The task registry draft is based on a different commit.");
    await this.git(["restore", "--source", expectedCommit, "--staged", "--worktree", "--", ".phaseatlas"], this.workspacePath);
    await this.git(["clean", "-fd", "--", ".phaseatlas"], this.workspacePath);
    return this.source();
  }

  async appendImmutableCoverageEvent(workspaceSlug: string, event: CoverageEvent, content: string): Promise<TaskRegistrySource> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(workspaceSlug)) throw new Error("Coverage workspace slug is invalid.");
    if (!EVENT_ID_PATTERN.test(event.id)) throw new Error("Coverage event id is invalid.");
    const relativePath = `.phaseatlas/workspaces/${workspaceSlug}/coverage-events/${event.id}.yaml`;
    const message = `coverage: record ${event.path}`.slice(0, 120);
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("Coverage event exceeds the one MiB limit.");

    const temporaryRoot = await mkdtemp(path.join(path.dirname(this.workspacePath), "coverage-event-"));
    const eventPath = path.join(temporaryRoot, `${event.id}.yaml`);
    const indexPath = path.join(temporaryRoot, "index");
    await writeFile(eventPath, content, { encoding: "utf8", mode: 0o600 });
    try {
      const blob = await this.git(["hash-object", "-w", eventPath], this.repositoryRoot);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await this.fetch();
        const expectedCommit = await this.git(["rev-parse", this.localRef], this.repositoryRoot);
        const alreadyExists = await this.git(["ls-tree", "-z", "--name-only", expectedCommit, "--", relativePath], this.repositoryRoot);
        if (alreadyExists) throw new Error("Coverage event id already exists in the task registry.");

        const environment = { ...process.env, GIT_INDEX_FILE: indexPath };
        await rm(indexPath, { force: true });
        await this.git(["read-tree", expectedCommit], this.repositoryRoot, environment);
        await this.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${relativePath}`], this.repositoryRoot, environment);
        const tree = await this.git(["write-tree"], this.repositoryRoot, environment);
        const commit = await this.git([
          "-c", "user.name=PhaseAtlas",
          "-c", "user.email=phaseatlas@local",
          "commit-tree", tree, "-p", expectedCommit, "-m", message,
        ], this.repositoryRoot, environment);
        try {
          await this.git([
            "push",
            `--force-with-lease=${this.config.ref}:${expectedCommit}`,
            this.config.remote,
            `${commit}:${this.config.ref}`,
          ], this.repositoryRoot);
          await this.fetch();
          if (!(await this.changedPaths()).length) await this.git(["checkout", "--detach", this.localRef], this.workspacePath);
          return this.source();
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (attempt === 4 || !/(stale info|non-fast-forward|remote rejected|failed to update ref|cannot lock ref|fetch first)/i.test(message)) throw error;
        }
      }
      throw new Error("Coverage event could not be published after five attempts.");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  /**
   * Send the commit, and if somebody got there first, rebase onto them and retry.
   *
   * One task is one file, so two checkouts editing different tasks touch different
   * paths and the rebase is clean — which is the ordinary case and the one that
   * should not need a person. Two checkouts editing the same task is the case
   * nothing can decide: the rebase is aborted and the caller is told, so the draft
   * comes back for review instead of one version quietly replacing the other.
   *
   * The lease is recomputed from the ref each attempt rather than reused, because
   * after a rebase the commit being replaced is no longer the one we started from.
   */
  private async pushWithRebase(commit: string, expectedCommit: string): Promise<string> {
    let lease = expectedCommit;
    let head = commit;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.git([
          "push",
          `--force-with-lease=${this.config.ref}:${lease}`,
          this.config.remote,
          `HEAD:${this.config.ref}`,
        ], this.workspacePath);
        return head;
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const raced = /stale info|non-fast-forward|remote rejected|failed to update ref|cannot lock ref|fetch first|rejected/i.test(message);
        if (!raced || attempt === 3) throw error;
        if (!(await this.fetch())) throw error; // offline: nothing to rebase onto
        const theirs = await this.git(["rev-parse", this.localRef], this.repositoryRoot);
        if (theirs === lease) throw error; // rejected for some other reason
        try {
          await this.git(["rebase", theirs], this.workspacePath);
        } catch (rebaseError) {
          await this.git(["rebase", "--abort"], this.workspacePath).catch(() => undefined);
          throw new Error(
            `The task registry changed elsewhere and the same task changed on both sides. ${
              rebaseError instanceof Error ? rebaseError.message : ""
            }`.trim(),
          );
        }
        lease = theirs;
        head = await this.git(["rev-parse", "HEAD"], this.workspacePath);
      }
    }
    throw new Error("The task registry could not be published after several attempts.");
  }

  private async ensureWorkspace(): Promise<void> {
    await mkdir(path.dirname(this.workspacePath), { recursive: true, mode: 0o700 });
    await this.fetch();
    if (!(await exists(this.workspacePath))) {
      if (!(await this.hasLocalRef())) {
        // Nothing fetched and nothing stored: there is no registry to open. Say
        // which of the two it is, because the answers are different — one waits
        // for a network, the other waits for somebody to publish.
        throw new Error(
          this.reachable
            ? `The task registry ref ${this.config.ref} does not exist on ${this.config.remote} yet.`
            : `The task registry could not be opened: ${this.config.remote} is unreachable and this checkout has no local copy yet.`,
        );
      }
      await this.git(["worktree", "add", "--detach", this.workspacePath, this.localRef], this.repositoryRoot);
      return;
    }
    if (!(await exists(path.join(this.workspacePath, ".git")))) {
      throw new Error("The task registry workspace exists but is not a managed Git worktree.");
    }
    // An existing workspace is enough to work in. Offline only means it cannot be
    // moved onto anything newer, and a checkout that refuses to open because a
    // host is down is a local-first tool in name only.
    const changedPaths = await this.changedPaths();
    if (!changedPaths.length && (await this.hasLocalRef())) {
      await this.git(["checkout", "--detach", this.localRef], this.workspacePath);
    }
  }

  private async hasLocalRef(): Promise<boolean> {
    return Boolean(await this.git(["rev-parse", "--verify", "--quiet", `${this.localRef}^{commit}`], this.repositoryRoot).catch(() => ""));
  }

  /**
   * Bring the local copy of the registry ref up to date.
   *
   * Returns false when the remote could not be reached. Being unable to reach a
   * host is the ordinary state of a laptop on a train, and it says nothing about
   * the tasks: the local ref is still the authority, the workspace still opens,
   * and the work still saves. Only a remote that answers and refuses is a fact
   * worth failing on, which is what publish's compare-and-swap is for.
   */
  private async fetch(): Promise<boolean> {
    try {
      await this.git([
        "fetch",
        "--no-tags",
        this.config.remote,
        `+${this.config.ref}:${this.localRef}`,
      ], this.repositoryRoot);
      this.reachable = true;
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // A remote that simply has no registry ref yet is not an unreachable one:
      // that is what the first checkout to publish meets.
      if (/couldn't find remote ref|not our ref|no such ref/i.test(message)) {
        this.reachable = true;
        return true;
      }
      this.reachable = false;
      return false;
    }
  }

  private async changedPaths(): Promise<string[]> {
    const output = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], this.workspacePath);
    return [...new Set(output.split("\n")
      .map((line) => line.length >= 4 ? line.slice(3).replace(/^"|"$/g, "") : "")
      .map((candidate) => candidate.includes(" -> ") ? candidate.split(" -> ").at(-1) ?? candidate : candidate)
      .filter(Boolean))].sort();
  }

  private async git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
    try {
      const result = await executeFile("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000,
        ...(env ? { env } : {}),
      });
      return result.stdout.trimEnd();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Git command failed.";
      throw new Error(`Task registry Git operation failed: ${message}`);
    }
  }
}
