import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CheckoutOperationalStore } from "./checkout-operational-store.js";
import { WorktreeLeaseManager } from "./worktree-lease-manager.js";

const execFileAsync = promisify(execFile);
const CHECKOUT_ID = "c".repeat(20);

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root });
}

test("allocates unique concurrent worktrees, releases normal leases, and reports abandoned leases", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-leases-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repositoryPath = path.join(root, "repository");
  await mkdir(repositoryPath);
  await git(repositoryPath, "init");
  await git(repositoryPath, "config", "user.email", "phaseatlas@example.test");
  await git(repositoryPath, "config", "user.name", "PhaseAtlas Test");
  await writeFile(path.join(repositoryPath, "README.md"), "lease fixture\n");
  await git(repositoryPath, "add", "README.md");
  await git(repositoryPath, "commit", "-m", "fixture");

  const databasePath = path.join(root, "runtime", CHECKOUT_ID, "operations.sqlite");
  const store = new CheckoutOperationalStore(databasePath, CHECKOUT_ID);
  for (const runId of ["run-1", "run-2", "run-3", "run-abandoned"]) {
    store.recordRun({ runId, kind: "agent", taskKeys: ["core/PHA-001"] });
  }
  const manager = new WorktreeLeaseManager(repositoryPath, CHECKOUT_ID, store);
  const leases = await Promise.all(["run-1", "run-2", "run-3"].map((runId) => manager.acquire(runId)));
  assert.equal(new Set(leases.map((lease) => lease.leaseId)).size, 3);
  assert.equal(new Set(leases.map((lease) => lease.worktreePath)).size, 3);
  assert.equal(new Set(leases.map((lease) => lease.branch)).size, 3);
  await Promise.all(leases.map((lease) => access(lease.worktreePath)));
  await Promise.all(leases.map((lease) => manager.release(lease.runId)));
  assert.equal(manager.list().filter((lease) => lease.status === "released").length, 3);

  const active = await manager.acquire("run-abandoned");
  store.close();
  const reopened = new CheckoutOperationalStore(databasePath, CHECKOUT_ID);
  reopened.reconcileInterruptedRuns();
  const recovered = new WorktreeLeaseManager(repositoryPath, CHECKOUT_ID, reopened);
  const abandoned = await recovered.reconcileAbandoned();
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0]?.leaseId, active.leaseId);
  assert.equal(abandoned[0]?.status, "abandoned");
  await access(active.worktreePath);
  reopened.close();
});
