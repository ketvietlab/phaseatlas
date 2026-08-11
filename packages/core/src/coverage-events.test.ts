import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import type { CoverageEvent } from "@phaseatlas/contracts";
import { createCoverageEvent, loadCoverageSnapshot, serializeCoverageEvent } from "./coverage-events.js";

const executeFile = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await executeFile("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-coverage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "develop"]);
  await git(root, ["config", "user.name", "Test"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, ".phaseatlas", "workspaces", "core", "coverage-events"), { recursive: true });
  await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n");
  await writeFile(path.join(root, ".phaseatlas", "workspaces", "core", "workspace.yaml"), "schemaVersion: phaseatlas.workspace/v1\nslug: core\nname: Core\ndescription: Core\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "seed"]);
  const hash = createHash("sha256").update(await readFile(path.join(root, "docs", "guide.md"))).digest("hex");
  return { root, hash };
}

async function snapshot(root: string) {
  return loadCoverageSnapshot({ repositoryRoot: root, contractRoot: root, repositoryId: "test", workspaceSlug: "core" });
}

test("projects tracked documentation as pending until its exact revision is covered", async (context) => {
  const { root, hash } = await fixture(context);
  assert.deepEqual((await snapshot(root)).summary, { pending: 1, covered: 0, conflicted: 0 });
  const event = await createCoverageEvent({
    repositoryRoot: root,
    input: { workspaceSlug: "core", path: "docs/guide.md", expectedContentSha256: hash, result: "clean" },
    id: "10000000-0000-4000-8000-000000000001",
    recordedAt: "2026-08-11T00:00:00.000Z",
  });
  await writeFile(path.join(root, ".phaseatlas", "workspaces", "core", "coverage-events", `${event.id}.yaml`), serializeCoverageEvent(event));
  assert.deepEqual((await snapshot(root)).summary, { pending: 0, covered: 1, conflicted: 0 });

  await writeFile(path.join(root, "docs", "guide.md"), "# Changed guide\n");
  assert.deepEqual((await snapshot(root)).summary, { pending: 1, covered: 0, conflicted: 0 });
});

test("turns concurrent semantic disagreement into a projection conflict and resolves it explicitly", async (context) => {
  const { root, hash } = await fixture(context);
  const first = await createCoverageEvent({
    repositoryRoot: root,
    input: { workspaceSlug: "core", path: "docs/guide.md", expectedContentSha256: hash, result: "clean" },
    id: "20000000-0000-4000-8000-000000000001",
    recordedAt: "2026-08-11T00:00:00.000Z",
  });
  const second: CoverageEvent = {
    ...first,
    id: "20000000-0000-4000-8000-000000000002",
    recordedAt: "2026-08-11T00:01:00.000Z",
    result: "issue",
    taskRefs: ["CORE-001"],
  };
  const eventRoot = path.join(root, ".phaseatlas", "workspaces", "core", "coverage-events");
  await writeFile(path.join(eventRoot, `${first.id}.yaml`), serializeCoverageEvent(first));
  await writeFile(path.join(eventRoot, `${second.id}.yaml`), serializeCoverageEvent(second));
  const conflicted = await snapshot(root);
  assert.equal(conflicted.documents[0]?.status, "conflicted");
  assert.ok(conflicted.issues.some((issue) => issue.code === "COVERAGE_PROJECTION_CONFLICT"));

  const resolution: CoverageEvent = {
    ...second,
    id: "20000000-0000-4000-8000-000000000003",
    recordedAt: "2026-08-11T00:02:00.000Z",
    resolves: [first.id, second.id],
  };
  await writeFile(path.join(eventRoot, `${resolution.id}.yaml`), serializeCoverageEvent(resolution));
  const covered = await snapshot(root);
  assert.equal(covered.documents[0]?.status, "covered");
  assert.equal(covered.documents[0]?.event?.id, resolution.id);
});

test("fails closed on malformed or path-mismatched event files", async (context) => {
  const { root } = await fixture(context);
  await writeFile(
    path.join(root, ".phaseatlas", "workspaces", "core", "coverage-events", "bad.yaml"),
    "schemaVersion: phaseatlas.coverage-event/v1\nid: not-an-id\npath: ../secret\n",
  );
  const result = await snapshot(root);
  assert.ok(result.issues.some((issue) => issue.code === "COVERAGE_EVENT_ID"));
  assert.ok(result.issues.some((issue) => issue.code === "COVERAGE_EVENT_PATH"));
  assert.equal(result.documents[0]?.status, "pending");
});

test("rejects resolution cycles instead of hiding every active decision", async (context) => {
  const { root, hash } = await fixture(context);
  const first = await createCoverageEvent({
    repositoryRoot: root,
    input: { workspaceSlug: "core", path: "docs/guide.md", expectedContentSha256: hash, result: "clean" },
    id: "40000000-0000-4000-8000-000000000001",
    recordedAt: "2026-08-11T00:00:00.000Z",
  });
  const second: CoverageEvent = {
    ...first,
    id: "40000000-0000-4000-8000-000000000002",
    recordedAt: "2026-08-11T00:01:00.000Z",
    resolves: [first.id],
  };
  first.resolves = [second.id];
  const eventRoot = path.join(root, ".phaseatlas", "workspaces", "core", "coverage-events");
  await writeFile(path.join(eventRoot, `${first.id}.yaml`), serializeCoverageEvent(first));
  await writeFile(path.join(eventRoot, `${second.id}.yaml`), serializeCoverageEvent(second));
  const result = await snapshot(root);
  assert.equal(result.documents[0]?.status, "covered");
  assert.equal(result.documents[0]?.activeEventIds.length, 2);
  assert.equal(result.issues.filter((issue) => issue.code === "COVERAGE_EVENT_RESOLUTION_CYCLE").length, 2);
});
