import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AgentExecutionScheduler, type AgentExecutionAdapter } from "./agent-execution-scheduler.js";
import { CheckoutOperationalStore } from "./checkout-operational-store.js";
import { RepositoryInspector } from "./repository-inspector.js";
import { WorktreeLeaseManager } from "./worktree-lease-manager.js";

const execFileAsync = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
  return stdout;
}

async function fixture(context: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-scheduler-"));
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-scheduler-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await git(root, "init");
  await git(root, "config", "user.email", "phaseatlas@example.test");
  await git(root, "config", "user.name", "PhaseAtlas Test");
  await mkdir(path.join(root, "packages", "core"), { recursive: true });
  await mkdir(path.join(root, ".phaseatlas", "workspaces", "core", "tasks"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await writeFile(path.join(root, "packages", "core", "index.ts"), "export {};\n");
  await writeFile(path.join(root, ".phaseatlas", "repository.yaml"), "schemaVersion: phaseatlas.repository/v1\nid: repo-test\nname: Test\n");
  await writeFile(path.join(root, ".phaseatlas", "workspaces", "core", "workspace.yaml"), "schemaVersion: phaseatlas.workspace/v1\nslug: core\nname: Core\ndescription: Core workspace\n");
  const taskPath = path.join(root, ".phaseatlas", "workspaces", "core", "tasks", "PHA-001.yaml");
  await writeFile(taskPath, `schemaVersion: phaseatlas.task/v1
id: PHA-001
title: Execute safely
kind: code
phase: execution
state: ready
priority: high
objective: Execute in an isolated worktree.
owners: []
dependencies: []
scope:
  allowedPaths:
    - packages/core
  forbiddenPaths: []
  writable: true
  allowDependencyChanges: false
  allowDatabaseMigrations: false
  allowExternalNetwork: false
acceptanceCriteria:
  - id: AC-1
    statement: Work remains isolated.
    verification:
      type: human
      reviewerRole: maintainer
verification: []
evidenceRequirements:
  - type: human_review
`);
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  const inspector = await RepositoryInspector.open(root);
  const repository = await inspector.describe();
  const store = new CheckoutOperationalStore(path.join(runtimeRoot, repository.checkoutId, "operations.sqlite"), repository.checkoutId);
  const leases = new WorktreeLeaseManager(root, repository.checkoutId, store);
  const scheduler = new AgentExecutionScheduler(inspector, store, leases);
  return { root, taskPath, inspector, repository, store, leases, scheduler };
}

const successfulResult = {
  outcome: "completed",
  summary: "Implementation completed in the leased worktree.",
  changedFiles: [{ path: "README.md", changeType: "modified" }],
  verification: [],
  producedEvidence: [],
  blockers: [],
  nextAction: "Review the isolated result.",
  requiresHumanReview: true,
  proposedTaskState: "done",
};

test("executes writes only in a leased worktree and trusts Git-derived changes", async (context) => {
  const runtime = await fixture(context);
  const taskBefore = await readFile(runtime.taskPath, "utf8");
  const revision = (await runtime.inspector.taskSnapshot()).tasks[0]?.revision;
  const adapter: AgentExecutionAdapter = {
    supportedSandboxes: ["workspace-write"],
    async execute({ workingDirectory }) {
      await writeFile(path.join(workingDirectory, "packages", "core", "output.ts"), "export const isolated = true;\n");
      return successfulResult;
    },
  };
  const validated = await runtime.scheduler.execute({
    taskKey: "core/PHA-001",
    expectedTaskRevision: revision,
    expectedCheckoutId: runtime.repository.checkoutId,
    action: "implement",
  }, adapter, new AbortController().signal);
  assert.deepEqual(validated.inspectedChanges.map((change) => change.path), ["packages/core/output.ts"]);
  assert.equal(validated.policyViolations.length, 0);
  assert.equal(validated.result.proposedTaskState, "done");
  await assert.rejects(access(path.join(runtime.root, "packages", "core", "output.ts")));
  assert.equal(await readFile(runtime.taskPath, "utf8"), taskBefore);
  assert.equal(runtime.leases.list()[0]?.status, "released");
  assert.equal(runtime.store.listRuns()[0]?.status, "completed");
  runtime.store.close();
});

test("refuses an adapter that cannot honor read-only execution", async (context) => {
  const runtime = await fixture(context);
  let executed = false;
  const adapter: AgentExecutionAdapter = {
    supportedSandboxes: ["workspace-write"],
    async execute() {
      executed = true;
      return successfulResult;
    },
  };
  await assert.rejects(runtime.scheduler.execute({ taskKey: "core/PHA-001", action: "review" }, adapter, new AbortController().signal), /cannot honor read-only/);
  assert.equal(executed, false);
  assert.equal(await git(runtime.root, "status", "--porcelain"), "");
  runtime.store.close();
});

test("releases a write lease when execution fails", async (context) => {
  const runtime = await fixture(context);
  const adapter: AgentExecutionAdapter = {
    supportedSandboxes: ["workspace-write"],
    async execute() {
      throw new Error("adapter failed");
    },
  };
  await assert.rejects(runtime.scheduler.execute({ taskKey: "core/PHA-001", action: "implement" }, adapter, new AbortController().signal), /adapter failed/);
  assert.equal(runtime.leases.list()[0]?.status, "released");
  assert.equal(runtime.store.listRuns()[0]?.status, "failed");
  runtime.store.close();
});
