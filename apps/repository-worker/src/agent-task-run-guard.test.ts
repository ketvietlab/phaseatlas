import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalTask, TaskSnapshot } from "@phaseatlas/contracts";
import { AgentTaskRunGuard, canonicalAgentTaskKey, resolveAgentTaskReference } from "./agent-task-run-guard.js";

function task(workspaceSlug: string, taskId: string): CanonicalTask {
  return {
    schemaVersion: "phaseatlas.task/v1",
    key: { repositoryId: "repo-1", workspaceSlug, taskId },
    revision: `${workspaceSlug}-${taskId}`,
    title: taskId,
    objective: "Test the run guard.",
    phaseId: "execution",
    kind: "code",
    state: "ready",
    priority: "normal",
    owners: [],
    scope: {
      allowedPaths: [],
      forbiddenPaths: [],
      writable: false,
      allowDependencyChanges: false,
      allowDatabaseMigrations: false,
      allowExternalNetwork: false,
    },
    acceptanceCriteria: [],
    dependencies: [],
    verification: [],
    evidenceRequirements: [],
    source: { documents: [], extractedAt: "2026-08-04T00:00:00.000Z", warnings: [] },
  };
}

function snapshot(tasks: CanonicalTask[]): TaskSnapshot {
  return {
    repositoryId: "repo-1",
    generatedAt: "2026-08-04T00:00:00.000Z",
    tasks,
    issues: [],
    graph: { edges: [], hasCycles: false },
  };
}

test("normalizes task aliases before guarding a concurrent start", () => {
  const current = snapshot([task("phaseatlas-core", "PHA-001")]);
  const fromId = resolveAgentTaskReference(current, "PHA-001");
  const fromCanonicalKey = resolveAgentTaskReference(current, "phaseatlas-core/PHA-001");
  const guard = new AgentTaskRunGuard();
  const release = guard.acquire(canonicalAgentTaskKey(fromId));

  assert.throws(
    () => guard.acquire(canonicalAgentTaskKey(fromCanonicalKey)),
    /already starting/,
  );
  release();
  assert.doesNotThrow(() => guard.acquire(canonicalAgentTaskKey(fromCanonicalKey))());
});

test("rejects an ambiguous bare task id", () => {
  const current = snapshot([
    task("phaseatlas-core", "PHA-001"),
    task("phaseatlas-chat", "PHA-001"),
  ]);

  assert.throws(() => resolveAgentTaskReference(current, "PHA-001"), /does not resolve/);
});
