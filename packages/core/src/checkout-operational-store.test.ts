import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckoutOperationalStore } from "./checkout-operational-store.js";

const CHECKOUT_A = "a".repeat(20);
const CHECKOUT_B = "b".repeat(20);

test("persists ordered run events across reopen", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-store-"));
  const databasePath = path.join(root, "checkouts", CHECKOUT_A, "operations.sqlite");
  try {
    const first = new CheckoutOperationalStore(databasePath, CHECKOUT_A);
    first.recordRun({ runId: "run-1", kind: "planning", taskKeys: [] });
    const firstEvent = first.appendEvent({ runId: "run-1", type: "planning.status", payload: { status: "starting" }, status: "starting" });
    first.close();

    const reopened = new CheckoutOperationalStore(databasePath, CHECKOUT_A);
    const secondEvent = reopened.appendEvent({ runId: "run-1", type: "planning.status", payload: { status: "running" }, status: "running" });
    const concurrentEvents = await Promise.all(Array.from({ length: 12 }, (_, index) => Promise.resolve().then(() =>
      reopened.appendEvent({ runId: "run-1", type: "planning.delta", payload: { index } }),
    )));
    assert.equal(firstEvent.sequence, 1);
    assert.equal(secondEvent.sequence, 2);
    assert.deepEqual(concurrentEvents.map((event) => event.sequence), Array.from({ length: 12 }, (_, index) => index + 3));
    assert.deepEqual(reopened.listEvents("run-1").map((event) => event.sequence), Array.from({ length: 14 }, (_, index) => index + 1));
    assert.equal(reopened.listRuns()[0]?.status, "running");
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconciles interrupted runs exactly once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-recovery-"));
  const databasePath = path.join(root, "operations.sqlite");
  try {
    const store = new CheckoutOperationalStore(databasePath, CHECKOUT_A);
    store.recordRun({ runId: "run-active", kind: "task_content", status: "running", taskKeys: ["core/PHA-001"] });
    const firstRecovery = store.reconcileInterruptedRuns("2026-08-03T00:00:00.000Z");
    const repeatedRecovery = store.reconcileInterruptedRuns("2026-08-03T00:01:00.000Z");
    assert.equal(firstRecovery.length, 1);
    assert.equal(repeatedRecovery.length, 0);
    assert.equal(store.listRuns()[0]?.status, "interrupted");
    assert.equal(store.listEvents("run-active").filter((event) => event.type === "run.interrupted").length, 1);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolates operational state by checkout identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-isolation-"));
  try {
    const first = new CheckoutOperationalStore(path.join(root, CHECKOUT_A, "operations.sqlite"), CHECKOUT_A);
    const second = new CheckoutOperationalStore(path.join(root, CHECKOUT_B, "operations.sqlite"), CHECKOUT_B);
    first.recordRun({ runId: "run-a", kind: "planning" });
    second.recordRun({ runId: "run-b", kind: "planning" });
    assert.deepEqual(first.listRuns().map((run) => run.runId), ["run-a"]);
    assert.deepEqual(second.listRuns().map((run) => run.runId), ["run-b"]);
    first.close();
    second.close();
    assert.throws(() => new CheckoutOperationalStore(path.join(root, CHECKOUT_A, "operations.sqlite"), CHECKOUT_B), /identity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when an existing store has no schema metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-corrupt-store-"));
  const databasePath = path.join(root, "operations.sqlite");
  try {
    await writeFile(databasePath, "");
    assert.throws(() => new CheckoutOperationalStore(databasePath, CHECKOUT_A), /schema metadata/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminalizes once and rejects provider output after the winning terminal state", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-terminal-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new CheckoutOperationalStore(path.join(root, "operations.sqlite"), CHECKOUT_A);
  store.recordRun({ runId: "run-terminal", kind: "agent", status: "running", taskKeys: ["core/PHA-001"] });
  store.recordAgentSpec({
    runId: "run-terminal",
    taskKey: "core/PHA-001",
    taskRevision: "a".repeat(64),
    action: "review",
    sandbox: "read-only",
    checkoutId: CHECKOUT_A,
    runnerId: "codex-cli",
    createdAt: "2026-08-03T00:00:00.000Z",
  });
  const first = store.terminalizeRun({
    runId: "run-terminal",
    status: "cancelled",
    type: "run.cancelled",
    payload: { reason: "requested" },
  });
  const repeated = store.terminalizeRun({
    runId: "run-terminal",
    status: "completed",
    type: "agent.result",
    payload: { outcome: "completed" },
  });
  assert.equal(first.accepted, true);
  assert.equal(repeated.accepted, false);
  assert.equal(store.getRun("run-terminal").status, "cancelled");
  assert.equal(store.listEvents("run-terminal").filter((event) => ["run.cancelled", "agent.result"].includes(event.type)).length, 1);
  assert.throws(() => store.appendEvent({ runId: "run-terminal", type: "agent.delta", payload: { text: "late" } }), /terminal/);
  assert.throws(() => store.recordAgentResult({
    runId: "run-terminal",
    taskKey: "core/PHA-001",
    taskRevision: "a".repeat(64),
    recordedAt: "2026-08-03T00:01:00.000Z",
    validated: {
      result: {
        outcome: "completed",
        summary: "Late result.",
        changedFiles: [],
        verification: [],
        producedEvidence: [],
        blockers: [],
        nextAction: "None.",
        requiresHumanReview: true,
        proposedTaskState: "in_review",
      },
      inspectedChanges: [],
      policyViolations: [],
    },
  }), /after terminal/);
  assert.doesNotThrow(() => store.appendEvent({ runId: "run-terminal", type: "lease.released", payload: { disposition: "cancelled" } }));
  store.close();
});

test("paginates replay cursors without gaps or duplicates", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-pages-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new CheckoutOperationalStore(path.join(root, "operations.sqlite"), CHECKOUT_A);
  store.recordRun({ runId: "run-page", kind: "planning" });
  for (let index = 0; index < 7; index += 1) {
    store.appendEvent({ runId: "run-page", type: "planning.delta", payload: { index } });
  }
  const first = store.listEventsPage("run-page", 0, 3);
  const second = store.listEventsPage("run-page", first.nextSequence, 3);
  const third = store.listEventsPage("run-page", second.nextSequence, 3);
  assert.deepEqual([...first.events, ...second.events, ...third.events].map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, true);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextSequence, 7);
  store.close();
});

test("persists agent specs, results, revalidation, and retry linkage", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-agent-result-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "operations.sqlite");
  const store = new CheckoutOperationalStore(databasePath, CHECKOUT_A);
  store.recordRun({ runId: "run-original", kind: "agent", taskKeys: ["core/PHA-001"] });
  store.recordAgentSpec({
    runId: "run-original",
    taskKey: "core/PHA-001",
    taskRevision: "a".repeat(64),
    action: "review",
    sandbox: "read-only",
    checkoutId: CHECKOUT_A,
    runnerId: "codex-cli",
    model: "gpt-safe",
    createdAt: "2026-08-03T00:00:00.000Z",
  });
  store.recordAgentResult({
    runId: "run-original",
    taskKey: "core/PHA-001",
    taskRevision: "a".repeat(64),
    recordedAt: "2026-08-03T00:01:00.000Z",
    validated: {
      result: {
        outcome: "completed",
        summary: "Reviewed.",
        changedFiles: [],
        verification: [],
        producedEvidence: [],
        blockers: [],
        nextAction: "Request review.",
        requiresHumanReview: true,
        proposedTaskState: "in_review",
      },
      inspectedChanges: [],
      policyViolations: [],
    },
  });
  store.recordResultRevalidation({
    runId: "run-original",
    taskRevision: "b".repeat(64),
    outcome: "passed",
    reviewer: "maintainer",
    recordedAt: "2026-08-03T00:02:00.000Z",
  });
  store.recordRun({ runId: "run-retry", kind: "agent", taskKeys: ["core/PHA-001"] });
  store.linkRunAttempt("run-retry", "run-original");
  store.close();

  const reopened = new CheckoutOperationalStore(databasePath, CHECKOUT_A);
  assert.equal(reopened.getAgentSpec("run-original")?.model, "gpt-safe");
  assert.equal(reopened.getAgentResult("run-original")?.validated.result.summary, "Reviewed.");
  assert.equal(reopened.latestResultRevalidation("run-original")?.taskRevision, "b".repeat(64));
  assert.equal(reopened.parentRunId("run-retry"), "run-original");
  reopened.close();
});
