import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import type { CoverageEvent } from "@phaseatlas/contracts";
import { serializeCoverageEvent } from "@phaseatlas/core";
import { TaskRegistryManager } from "./task-registry-manager.js";

const executeFile = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await executeFile("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-task-registry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const repository = path.join(root, "repository");
  await mkdir(repository, { recursive: true });
  await git(root, ["init", "--bare", remote]);
  await git(repository, ["init", "-b", "develop"]);
  await git(repository, ["config", "user.name", "Test"]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await git(repository, ["remote", "add", "origin", remote]);
  const taskDirectory = path.join(repository, ".phaseatlas", "workspaces", "core", "tasks");
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(path.join(repository, ".phaseatlas", "repository.yaml"), "schemaVersion: phaseatlas.repository/v1\nid: test\nname: Test\n");
  await writeFile(path.join(repository, ".phaseatlas", "workspaces", "core", "workspace.yaml"), "schemaVersion: phaseatlas.workspace/v1\nslug: core\nname: Core\ndescription: Core tasks\n");
  await writeFile(path.join(taskDirectory, "TST-001.yaml"), "schemaVersion: phaseatlas.task/v1\nid: TST-001\ntitle: Registry task\nkind: code\nphase: delivery\nstate: ready\npriority: normal\nobjective: Verify the registry.\nowners: []\ndependencies: []\nscope:\n  allowedPaths: [src]\n  forbiddenPaths: []\n  writable: true\n  allowDependencyChanges: false\n  allowDatabaseMigrations: false\n  allowExternalNetwork: false\nacceptanceCriteria: []\nverification: []\nevidenceRequirements: []\n");
  await git(repository, ["add", ".phaseatlas"]);
  await git(repository, ["commit", "-m", "seed registry"]);
  await git(repository, ["branch", "phaseatlas/tasks"]);
  await git(repository, ["push", "origin", "phaseatlas/tasks"]);
  const manager = await TaskRegistryManager.open({
    repositoryRoot: repository,
    runtimeRoot: path.join(root, "runtime"),
    config: { remote: "origin", ref: "refs/heads/phaseatlas/tasks", defaultDeliveryRef: "refs/heads/develop" },
  });
  return { root, remote, repository, manager };
}

test("keeps task edits in a detached registry workspace and publishes with a lease", async (context) => {
  const { remote, manager } = await fixture(context);
  const workspace = await manager.workspace();
  assert.equal(workspace.source.syncState, "current");
  const taskPath = path.join(workspace.path, ".phaseatlas", "workspaces", "core", "tasks", "TST-001.yaml");
  await writeFile(taskPath, (await readFile(taskPath, "utf8")).replace("state: ready", "state: in_progress"));
  const draft = await manager.source();
  assert.equal(draft.syncState, "draft");
  assert.deepEqual(draft.changedPaths, [".phaseatlas/workspaces/core/tasks/TST-001.yaml"]);

  const published = await manager.publish({ expectedCommit: draft.commit, message: "tasks: start TST-001" });
  assert.equal(published.syncState, "current");
  const remoteTask = await git(remote, ["show", "refs/heads/phaseatlas/tasks:.phaseatlas/workspaces/core/tasks/TST-001.yaml"]);
  assert.match(remoteTask, /state: in_progress/);
});

test("discard restores the registry base without touching the code checkout", async (context) => {
  const { repository, manager } = await fixture(context);
  const workspace = await manager.workspace();
  const taskPath = path.join(workspace.path, ".phaseatlas", "workspaces", "core", "tasks", "TST-001.yaml");
  await writeFile(taskPath, (await readFile(taskPath, "utf8")).replace("state: ready", "state: blocked"));
  const discarded = await manager.discard(workspace.source.commit);
  assert.equal(discarded.syncState, "current");
  assert.match(await readFile(taskPath, "utf8"), /state: ready/);
  assert.equal(await git(repository, ["status", "--porcelain"]), "");
});

test("retries concurrent append-only coverage publishes without a shared-file conflict", async (context) => {
  const { root, remote, repository, manager: firstManager } = await fixture(context);
  const secondManager = await TaskRegistryManager.open({
    repositoryRoot: repository,
    runtimeRoot: path.join(root, "second-runtime"),
    config: { remote: "origin", ref: "refs/heads/phaseatlas/tasks", defaultDeliveryRef: "refs/heads/develop" },
  });
  const base: Omit<CoverageEvent, "id" | "result"> = {
    schemaVersion: "phaseatlas.coverage-event/v1",
    path: "docs/guide.md",
    contentSha256: "a".repeat(64),
    size: 8,
    sourceCommit: "b".repeat(40),
    recordedAt: "2026-08-11T00:00:00.000Z",
    codeScopes: [],
    stagingStatus: "not-applicable",
    inlineFixes: [],
    taskRefs: [],
    workItemRefs: [],
    resolves: [],
  };
  const first: CoverageEvent = { ...base, id: "30000000-0000-4000-8000-000000000001", result: "clean" };
  const second: CoverageEvent = { ...base, id: "30000000-0000-4000-8000-000000000002", result: "issue" };

  await Promise.all([
    firstManager.appendImmutableCoverageEvent("core", first, serializeCoverageEvent(first)),
    secondManager.appendImmutableCoverageEvent("core", second, serializeCoverageEvent(second)),
  ]);

  const tree = await git(remote, ["ls-tree", "-r", "--name-only", "refs/heads/phaseatlas/tasks", ".phaseatlas/workspaces/core/coverage-events"]);
  assert.deepEqual(tree.split("\n").sort(), [
    `.phaseatlas/workspaces/core/coverage-events/${first.id}.yaml`,
    `.phaseatlas/workspaces/core/coverage-events/${second.id}.yaml`,
  ]);
});
