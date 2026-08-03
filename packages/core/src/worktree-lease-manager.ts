import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorktreeLeaseRecord, WorktreeLeaseStatus } from "@phaseatlas/contracts";
import type { CheckoutOperationalStore } from "./checkout-operational-store.js";

const execFileAsync = promisify(execFile);
const LEASE_EVENT_TYPES = new Set(["lease.allocating", "lease.active", "lease.releasing", "lease.released", "lease.abandoned"]);

export type LeaseGitCommand = (args: string[], cwd: string) => Promise<string>;

const defaultGitCommand: LeaseGitCommand = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return stdout;
};

function leaseStatus(type: string): WorktreeLeaseStatus {
  if (type === "lease.allocating") return "allocating";
  if (type === "lease.active") return "active";
  if (type === "lease.releasing") return "releasing";
  if (type === "lease.released") return "released";
  return "abandoned";
}

function leaseFromEvent(event: { runId: string; type: string; timestamp: string; payload: Record<string, unknown> }): WorktreeLeaseRecord {
  const { leaseId, checkoutId, worktreePath, branch, recoveryReason, disposition, createdAt } = event.payload;
  if (
    typeof leaseId !== "string" || !leaseId || typeof checkoutId !== "string" ||
    typeof worktreePath !== "string" || !path.isAbsolute(worktreePath) || typeof branch !== "string" || !branch
  ) throw new Error("Operational store contains invalid worktree lease metadata.");
  return {
    leaseId,
    runId: event.runId,
    checkoutId,
    worktreePath,
    branch,
    status: leaseStatus(event.type),
    createdAt: typeof createdAt === "string" ? createdAt : event.timestamp,
    updatedAt: event.timestamp,
    ...(typeof recoveryReason === "string" ? { recoveryReason } : {}),
    ...(typeof disposition === "string" ? { disposition } : {}),
  };
}

export class WorktreeLeaseManager {
  readonly managedRoot: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly repositoryPath: string,
    private readonly checkoutId: string,
    private readonly store: CheckoutOperationalStore,
    private readonly git: LeaseGitCommand = defaultGitCommand,
  ) {
    if (!path.isAbsolute(repositoryPath)) throw new Error("Lease manager repository path must be absolute.");
    if (store.checkoutId !== checkoutId) throw new Error("Lease manager checkout identity does not match its store.");
    this.managedRoot = path.join(path.dirname(store.databasePath), "worktrees");
  }

  list(): WorktreeLeaseRecord[] {
    const latest = new Map<string, WorktreeLeaseRecord>();
    for (const run of this.store.listRuns().filter((candidate) => candidate.kind === "agent")) {
      for (const event of this.store.listEvents(run.runId).filter((candidate) => LEASE_EVENT_TYPES.has(candidate.type))) {
        const lease = leaseFromEvent(event);
        const previous = latest.get(lease.leaseId);
        if (previous && (previous.runId !== lease.runId || previous.checkoutId !== lease.checkoutId)) {
          throw new Error("Operational store contains conflicting worktree lease ownership.");
        }
        latest.set(lease.leaseId, lease);
      }
    }
    return [...latest.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async reconcileAbandoned(reason = "worker_restarted"): Promise<WorktreeLeaseRecord[]> {
    return this.exclusive(async () => {
      const abandoned: WorktreeLeaseRecord[] = [];
      for (const lease of this.list().filter((candidate) => ["allocating", "active", "releasing"].includes(candidate.status))) {
        abandoned.push(this.appendLeaseEvent({ ...lease, status: "abandoned", recoveryReason: reason }));
      }
      return abandoned;
    });
  }

  async acquire(runId: string): Promise<WorktreeLeaseRecord> {
    return this.exclusive(async () => {
      const run = this.store.listRuns().find((candidate) => candidate.runId === runId && candidate.kind === "agent");
      if (!run) throw new Error(`Agent run ${runId} must be registered before acquiring a lease.`);
      if (this.list().some((lease) => lease.runId === runId)) throw new Error(`Agent run ${runId} already owns a lease record.`);
      const leaseId = randomUUID();
      const createdAt = new Date().toISOString();
      const branch = `phaseatlas/${this.checkoutId.slice(0, 8)}/${runId.slice(0, 8)}-${leaseId.slice(0, 8)}`;
      const allocating: WorktreeLeaseRecord = {
        leaseId,
        runId,
        checkoutId: this.checkoutId,
        worktreePath: path.join(this.managedRoot, leaseId),
        branch,
        status: "allocating",
        createdAt,
        updatedAt: createdAt,
      };
      await mkdir(this.managedRoot, { recursive: true });
      this.appendLeaseEvent(allocating);
      try {
        await this.git(["worktree", "add", "-b", branch, allocating.worktreePath, "HEAD"], this.repositoryPath);
        return this.appendLeaseEvent({ ...allocating, status: "active", updatedAt: new Date().toISOString() });
      } catch (error) {
        this.appendLeaseEvent({
          ...allocating,
          status: "abandoned",
          updatedAt: new Date().toISOString(),
          recoveryReason: `allocation_failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
        throw error;
      }
    });
  }

  async release(runId: string, reason = "run_finished"): Promise<WorktreeLeaseRecord | null> {
    return this.exclusive(async () => {
      const lease = this.list().find((candidate) => candidate.runId === runId);
      if (!lease || lease.status === "released") return lease ?? null;
      if (lease.status !== "active") throw new Error(`Lease ${lease.leaseId} requires explicit recovery.`);
      this.assertManagedLease(lease);
      const releasing = this.appendLeaseEvent({ ...lease, status: "releasing", updatedAt: new Date().toISOString() });
      try {
        const worktreeList = await this.git(["worktree", "list", "--porcelain"], this.repositoryPath);
        const canonicalLeasePath = await realpath(lease.worktreePath);
        const registeredPaths = worktreeList.split("\n")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice("worktree ".length));
        const registered = (await Promise.all(registeredPaths.map(async (candidate) => {
          try {
            return await realpath(candidate);
          } catch {
            return "";
          }
        }))).includes(canonicalLeasePath);
        if (!registered) throw new Error("Lease worktree is not registered to the canonical checkout.");
        await this.git(["worktree", "remove", "--force", lease.worktreePath], this.repositoryPath);
        return this.appendLeaseEvent({
          ...releasing,
          status: "released",
          updatedAt: new Date().toISOString(),
          disposition: reason,
        });
      } catch (error) {
        this.appendLeaseEvent({
          ...releasing,
          status: "abandoned",
          updatedAt: new Date().toISOString(),
          recoveryReason: `cleanup_failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
        throw error;
      }
    });
  }

  private appendLeaseEvent(lease: WorktreeLeaseRecord): WorktreeLeaseRecord {
    const timestamp = lease.updatedAt || new Date().toISOString();
    this.store.appendEvent({
      runId: lease.runId,
      type: `lease.${lease.status}`,
      timestamp,
      payload: {
        leaseId: lease.leaseId,
        checkoutId: lease.checkoutId,
        worktreePath: lease.worktreePath,
        branch: lease.branch,
        createdAt: lease.createdAt,
        ...(lease.recoveryReason ? { recoveryReason: lease.recoveryReason } : {}),
        ...(lease.disposition ? { disposition: lease.disposition } : {}),
      },
    });
    return { ...lease, updatedAt: timestamp };
  }

  private assertManagedLease(lease: WorktreeLeaseRecord): void {
    if (lease.checkoutId !== this.checkoutId) throw new Error("Lease belongs to a different checkout.");
    const relative = path.relative(this.managedRoot, lease.worktreePath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Lease worktree is outside the managed runtime root.");
    }
    if (path.basename(lease.worktreePath) !== lease.leaseId) throw new Error("Lease path does not match its identity.");
  }

  private async exclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
