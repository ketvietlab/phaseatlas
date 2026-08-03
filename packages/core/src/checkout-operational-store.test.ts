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
