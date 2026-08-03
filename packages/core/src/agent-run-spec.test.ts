import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalTask, RepositorySummary, TaskSnapshot } from "@phaseatlas/contracts";
import { createAgentRunSpec } from "./agent-run-spec.js";

const task: CanonicalTask = {
  schemaVersion: "phaseatlas.task/v1",
  key: { repositoryId: "repo-test", workspaceSlug: "core", taskId: "PHA-001" },
  revision: "a".repeat(64),
  title: "Implement foundation",
  objective: "Establish the execution boundary.",
  phaseId: "execution",
  kind: "code",
  state: "ready",
  priority: "high",
  owners: [],
  dependencies: [],
  scope: {
    allowedPaths: ["packages/core"],
    forbiddenPaths: ["packages/core/secrets"],
    writable: true,
    allowDependencyChanges: false,
    allowDatabaseMigrations: false,
    allowExternalNetwork: false,
  },
  acceptanceCriteria: [{ id: "AC-1", statement: "It works.", verification: { type: "human", reviewerRole: "maintainer" } }],
  verification: [],
  evidenceRequirements: [{ type: "human_review" }],
  source: { documents: [{ path: ".phaseatlas/task.yaml" }], extractedAt: "2026-08-03T00:00:00.000Z", warnings: [] },
};
const repository: RepositorySummary = {
  id: "repo-test",
  checkoutId: "a".repeat(20),
  name: "Test",
  path: "/tmp/repository",
  configuration: "configured",
  workspaceCount: 1,
  openedAt: "2026-08-03T00:00:00.000Z",
};
const snapshot: TaskSnapshot = {
  repositoryId: "repo-test",
  generatedAt: "2026-08-03T00:00:00.000Z",
  tasks: [task],
  issues: [],
  graph: { edges: [], hasCycles: false },
};

test("creates an immutable canonical run snapshot", () => {
  const spec = createAgentRunSpec({
    runId: "run-read",
    request: { taskKey: "core/PHA-001", action: "review", expectedTaskRevision: task.revision },
    repository,
    snapshot,
  });
  task.objective = "Changed after creation.";
  assert.equal(spec.objective, "Establish the execution boundary.");
  assert.equal(spec.sandbox, "read-only");
  assert.equal(spec.executionDirectory, repository.path);
  assert.equal(Object.isFrozen(spec), true);
  assert.equal(Object.isFrozen(spec.scope), true);
});

test("fails closed for stale, mismatched, and conflicting run requests", () => {
  assert.throws(() => createAgentRunSpec({
    runId: "run-stale",
    request: { taskKey: "core/PHA-001", action: "analyze", expectedTaskRevision: "stale" },
    repository,
    snapshot,
  }), /stale revision/);
  assert.throws(() => createAgentRunSpec({
    runId: "run-checkout",
    request: { taskKey: "core/PHA-001", action: "review", expectedCheckoutId: "b".repeat(20) },
    repository,
    snapshot,
  }), /different checkout/);
  assert.throws(() => createAgentRunSpec({
    runId: "run-sandbox",
    request: { taskKey: "core/PHA-001", action: "review", requestedSandbox: "workspace-write" },
    repository,
    snapshot,
  }), /requires the read-only sandbox/);
});
