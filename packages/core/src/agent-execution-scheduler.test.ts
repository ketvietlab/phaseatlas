import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AgentExecutionScheduler, type AgentExecutionAdapter } from "./agent-execution-scheduler.js";
import { reviewAgentResult } from "./agent-result-review.js";
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
  const observedEvents: string[] = [];
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
  }, adapter, new AbortController().signal, (event) => observedEvents.push(event.type));
  assert.deepEqual(validated.inspectedChanges.map((change) => change.path), ["packages/core/output.ts"]);
  assert.equal(validated.policyViolations.length, 0);
  assert.equal(validated.result.proposedTaskState, "done");
  await assert.rejects(access(path.join(runtime.root, "packages", "core", "output.ts")));
  assert.equal(await readFile(runtime.taskPath, "utf8"), taskBefore);
  assert.equal(runtime.leases.list()[0]?.status, "released");
  assert.equal(runtime.store.listRuns()[0]?.status, "completed");
  assert.equal(observedEvents.filter((type) => type === "agent.result").length, 1);
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

test("does not duplicate a normalized adapter failure", async (context) => {
  const runtime = await fixture(context);
  const adapter: AgentExecutionAdapter = {
    supportedSandboxes: ["workspace-write"],
    async execute({ emit }) {
      emit({ type: "run.failed", message: "Normalized provider failure." });
      throw new Error("private provider failure");
    },
  };
  await assert.rejects(runtime.scheduler.execute({ taskKey: "core/PHA-001", action: "implement" }, adapter, new AbortController().signal));
  const run = runtime.store.listRuns()[0];
  assert.ok(run);
  assert.equal(runtime.store.listEvents(run.runId).filter((event) => event.type === "run.failed").length, 1);
  assert.equal(run.status, "failed");
  runtime.store.close();
});

test("records one cancelled terminal state when cancellation races execution", async (context) => {
  const runtime = await fixture(context);
  const controller = new AbortController();
  const observedEvents: string[] = [];
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const adapter: AgentExecutionAdapter = {
    supportedSandboxes: ["workspace-write"],
    async execute({ signal }) {
      markStarted?.();
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const execution = runtime.scheduler.execute(
    { taskKey: "core/PHA-001", action: "implement" },
    adapter,
    controller.signal,
    (event) => observedEvents.push(event.type),
  );
  await started;
  controller.abort(new Error("user cancelled"));
  await assert.rejects(execution, /user cancelled/);

  const run = runtime.store.listRuns()[0];
  assert.ok(run);
  assert.equal(run.status, "cancelled");
  assert.equal(runtime.store.listEvents(run.runId).filter((event) =>
    event.type === "run.cancelled" || event.type === "run.failed" || event.type === "agent.result"
  ).length, 1);
  assert.equal(observedEvents.filter((type) => type === "run.cancelled").length, 1);
  assert.equal(runtime.leases.list()[0]?.status, "released");
  runtime.store.close();
});

test("fails promotion closed when the canonical task revision becomes stale", async (context) => {
  const runtime = await fixture(context);
  const adapter: AgentExecutionAdapter = {
    supportedSandboxes: ["workspace-write"],
    async execute() {
      return successfulResult;
    },
  };
  await runtime.scheduler.execute({ taskKey: "core/PHA-001", action: "implement" }, adapter, new AbortController().signal);
  const runId = runtime.store.listRuns()[0]?.runId;
  assert.ok(runId);
  const current = await reviewAgentResult(runtime.store, runtime.inspector, runId);
  assert.equal(current.freshness, "current");
  assert.equal(current.promotable, true);

  const originalTask = await readFile(runtime.taskPath, "utf8");
  await writeFile(runtime.taskPath, originalTask.replace(
    "objective: Execute in an isolated worktree.",
    "objective: Execute in an isolated worktree with revised scope.",
  ));
  runtime.inspector.invalidate();
  const stale = await reviewAgentResult(runtime.store, runtime.inspector, runId);
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.promotable, false);
  assert.ok(stale.currentTaskRevision);

  runtime.store.recordResultRevalidation({
    runId,
    taskRevision: stale.currentTaskRevision,
    outcome: "passed",
    reviewer: "maintainer",
    recordedAt: "2026-08-03T01:00:00.000Z",
  });
  const revalidated = await reviewAgentResult(runtime.store, runtime.inspector, runId);
  assert.equal(revalidated.freshness, "current");
  assert.equal(revalidated.promotable, true);

  runtime.store.recordResultRevalidation({
    runId,
    taskRevision: stale.currentTaskRevision,
    outcome: "failed",
    reviewer: "maintainer",
    recordedAt: "2026-08-03T01:01:00.000Z",
  });
  const failedRevalidation = await reviewAgentResult(runtime.store, runtime.inspector, runId);
  assert.equal(failedRevalidation.freshness, "stale");
  assert.equal(failedRevalidation.promotable, false);

  runtime.store.recordResultRevalidation({
    runId,
    taskRevision: stale.currentTaskRevision,
    outcome: "passed",
    reviewer: "maintainer",
    recordedAt: "2026-08-03T01:02:00.000Z",
  });

  await writeFile(runtime.taskPath, (await readFile(runtime.taskPath, "utf8")).replace(
    "objective: Execute in an isolated worktree with revised scope.",
    "objective: Execute in an isolated worktree with another revision.",
  ));
  runtime.inspector.invalidate();
  const staleAgain = await reviewAgentResult(runtime.store, runtime.inspector, runId);
  assert.equal(staleAgain.freshness, "stale");
  assert.equal(staleAgain.promotable, false);
  runtime.store.close();
});
