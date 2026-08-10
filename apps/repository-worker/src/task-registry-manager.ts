import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  TaskRegistryConfig,
  TaskRegistryPublishInput,
  TaskRegistrySource,
  TaskRegistryWorkspace,
} from "@phaseatlas/contracts";

const executeFile = promisify(execFile);
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

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
      syncState: changedPaths.length
        ? remoteCommit === commit ? "draft" : "conflicted"
        : remoteCommit === commit ? "current" : "ahead",
      changedPaths,
    };
  }

  async sync(): Promise<TaskRegistrySource> {
    await this.fetch();
    if ((await this.changedPaths()).length) return this.source();
    await this.git(["checkout", "--detach", this.localRef], this.workspacePath);
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
    const commit = await this.git(["rev-parse", "HEAD"], this.workspacePath);
    try {
      await this.git([
        "push",
        `--force-with-lease=${this.config.ref}:${input.expectedCommit}`,
        this.config.remote,
        `HEAD:${this.config.ref}`,
      ], this.workspacePath);
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

  private async ensureWorkspace(): Promise<void> {
    await mkdir(path.dirname(this.workspacePath), { recursive: true, mode: 0o700 });
    await this.fetch();
    if (!(await exists(this.workspacePath))) {
      await this.git(["worktree", "add", "--detach", this.workspacePath, this.localRef], this.repositoryRoot);
      return;
    }
    if (!(await exists(path.join(this.workspacePath, ".git")))) {
      throw new Error("The task registry workspace exists but is not a managed Git worktree.");
    }
    const changedPaths = await this.changedPaths();
    if (!changedPaths.length) await this.git(["checkout", "--detach", this.localRef], this.workspacePath);
  }

  private async fetch(): Promise<void> {
    await this.git([
      "fetch",
      "--no-tags",
      this.config.remote,
      `+${this.config.ref}:${this.localRef}`,
    ], this.repositoryRoot);
  }

  private async changedPaths(): Promise<string[]> {
    const output = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], this.workspacePath);
    return [...new Set(output.split("\n")
      .map((line) => line.length >= 4 ? line.slice(3).replace(/^"|"$/g, "") : "")
      .map((candidate) => candidate.includes(" -> ") ? candidate.split(" -> ").at(-1) ?? candidate : candidate)
      .filter(Boolean))].sort();
  }

  private async git(args: string[], cwd: string): Promise<string> {
    try {
      const result = await executeFile("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000,
      });
      return result.stdout.trimEnd();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Git command failed.";
      throw new Error(`Task registry Git operation failed: ${message}`);
    }
  }
}
