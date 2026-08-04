import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { CheckoutOperationalStore } from "./checkout-operational-store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:" + "sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

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

test("keeps command output out of replay payloads and reads bounded SQLite pages", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-command-output-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new CheckoutOperationalStore(path.join(root, "operations.sqlite"), CHECKOUT_A);
  store.recordRun({ runId: "run-command", kind: "agent", status: "running" });
  store.appendEvent({ runId: "run-command", type: "command.started", payload: { commandId: "command-1", command: "pnpm test" } });
  store.appendEvent({ runId: "run-command", type: "command.output", payload: { commandId: "command-1", text: "abc" } });
  store.appendEvent({ runId: "run-command", type: "command.output", payload: { commandId: "command-1", text: "def" } });
  store.appendEvent({ runId: "run-command", type: "command.completed", payload: { commandId: "command-1", exitCode: 0 } });

  const outputEvents = store.listEvents("run-command").filter((event) => event.type === "command.output");
  assert.deepEqual(outputEvents.map((event) => event.payload), [
    { commandId: "command-1", characterCount: 3 },
    { commandId: "command-1", characterCount: 3 },
  ]);
  const first = store.readAgentCommandOutput("run-command", "command-1", 0, 4);
  const second = store.readAgentCommandOutput("run-command", "command-1", first.nextOffset, 4);
  assert.deepEqual(first, {
    runId: "run-command",
    commandId: "command-1",
    offset: 0,
    nextOffset: 4,
    totalCharacters: 6,
    hasMore: true,
    text: "abcd",
  });
  assert.equal(second.text, "ef");
  assert.equal(second.hasMore, false);
  assert.deepEqual(store.readAgentCommandOutput("run-command", "command-1", 99, 4), {
    runId: "run-command",
    commandId: "command-1",
    offset: 6,
    nextOffset: 6,
    totalCharacters: 6,
    hasMore: false,
    text: "",
  });
  store.close();
});

test("migrates version one command output into lazy storage", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-command-migration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "operations.sqlite");
  const store = new CheckoutOperationalStore(databasePath, CHECKOUT_A);
  store.recordRun({ runId: "run-legacy-command", kind: "agent", status: "running" });
  store.appendEvent({ runId: "run-legacy-command", type: "command.started", payload: { commandId: "command-1", command: "pnpm check" } });
  const output = store.appendEvent({ runId: "run-legacy-command", type: "command.output", payload: { commandId: "command-1", text: "legacy output" } });
  store.close();

  const database = new DatabaseSync(databasePath);
  database.prepare("DELETE FROM agent_command_outputs").run();
  database.prepare("UPDATE run_events SET payload_json = ? WHERE run_id = ? AND sequence = ?")
    .run(JSON.stringify({ commandId: "command-1", text: "legacy output" }), "run-legacy-command", output.sequence);
  database.prepare("UPDATE store_meta SET value = '1' WHERE key = 'schema_version'").run();
  database.close();

  const migrated = new CheckoutOperationalStore(databasePath, CHECKOUT_A);
  assert.equal(migrated.readAgentCommandOutput("run-legacy-command", "command-1").text, "legacy output");
  assert.deepEqual(migrated.listEvents("run-legacy-command").at(-1)?.payload, {
    commandId: "command-1",
    characterCount: 13,
  });
  migrated.close();
});

test("scrubs legacy chat command output and rejects new output content", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-chat-output-migration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "operations.sqlite");
  const timestamp = "2026-08-04T00:00:00.000Z";
  const store = new CheckoutOperationalStore(databasePath, CHECKOUT_A);
  store.createChatSession({
    sessionId: "session-legacy-output",
    checkoutId: CHECKOUT_A,
    runnerId: "codex-cli",
    model: "gpt-fixture",
    title: "Legacy output",
    state: "open",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  store.createChatTurn({
    turn: {
      turnId: "turn-legacy-output",
      sessionId: "session-legacy-output",
      status: "starting",
      runnerId: "codex-cli",
      model: "gpt-fixture",
      userMessageId: "message-legacy-output",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    userMessage: {
      messageId: "message-legacy-output",
      sessionId: "session-legacy-output",
      turnId: "turn-legacy-output",
      role: "user",
      content: "Inspect output.",
      attachments: [],
      sequence: 1,
      createdAt: timestamp,
    },
  });
  store.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.prepare(`
    INSERT INTO chat_turn_events (turn_id, sequence, event_type, timestamp, payload_json)
    VALUES (?, 1, 'chat.tool.output', ?, ?)
  `).run("turn-legacy-output", timestamp, JSON.stringify({ toolCallId: "command-1", text: "legacy output" }));
  legacy.prepare("UPDATE store_meta SET value = '2' WHERE key = 'schema_version'").run();
  legacy.close();

  const migrated = new CheckoutOperationalStore(databasePath, CHECKOUT_A);
  assert.deepEqual(migrated.listChatEventPage("turn-legacy-output").events[0]?.payload, { hidden: true });
  assert.throws(() => migrated.appendChatEvent({
    turnId: "turn-legacy-output",
    type: "chat.tool.output",
    payload: { toolCallId: "command-1", text: "new output" },
  }), /not accepted/);
  migrated.close();

  const verified = new DatabaseSync(databasePath);
  const row = verified.prepare("SELECT payload_json FROM chat_turn_events WHERE turn_id = ? AND sequence = 1")
    .get("turn-legacy-output") as { payload_json: string };
  assert.deepEqual(JSON.parse(row.payload_json), { hidden: true, outputBytes: 13 });
  assert.equal(row.payload_json.includes("legacy output"), false);
  verified.close();
});

test("migrates version two provider selections to durable reasoning effort", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-effort-migration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "operations.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO store_meta (key, value) VALUES ('schema_version', '2'), ('checkout_id', '${CHECKOUT_A}');
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      task_keys_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_run_specs (
      run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
      task_key TEXT NOT NULL,
      task_revision TEXT NOT NULL,
      action TEXT NOT NULL,
      sandbox TEXT NOT NULL,
      checkout_id TEXT NOT NULL,
      runner_id TEXT NOT NULL,
      model_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE chat_sessions (
      session_id TEXT PRIMARY KEY,
      checkout_id TEXT NOT NULL,
      runner_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE chat_turns (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      runner_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL REFERENCES chat_messages(message_id),
      assistant_message_id TEXT REFERENCES chat_messages(message_id),
      parent_turn_id TEXT REFERENCES chat_turns(turn_id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  database.close();

  const migrated = new CheckoutOperationalStore(databasePath, CHECKOUT_A);
  migrated.recordRun({ runId: "run-effort", kind: "agent", taskKeys: ["core/PHA-001"] });
  migrated.recordAgentSpec({
    runId: "run-effort",
    taskKey: "core/PHA-001",
    taskRevision: "a".repeat(64),
    action: "review",
    sandbox: "read-only",
    checkoutId: CHECKOUT_A,
    runnerId: "codex-cli",
    model: "gpt-safe",
    reasoningEffort: "high",
    createdAt: "2026-08-04T00:00:00.000Z",
  });
  migrated.createChatSession({
    sessionId: "session-effort",
    checkoutId: CHECKOUT_A,
    runnerId: "codex-cli",
    model: "gpt-safe",
    reasoningEffort: "high",
    title: "Effort migration",
    state: "open",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
  });
  migrated.createChatTurn({
    turn: {
      turnId: "turn-effort",
      sessionId: "session-effort",
      status: "starting",
      runnerId: "codex-cli",
      model: "gpt-safe",
      reasoningEffort: "high",
      userMessageId: "message-effort",
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    },
    userMessage: {
      messageId: "message-effort",
      sessionId: "session-effort",
      turnId: "turn-effort",
      role: "user",
      content: "Verify migrated effort.",
      attachments: [],
      sequence: 1,
      createdAt: "2026-08-04T00:00:00.000Z",
    },
  });
  assert.equal(migrated.getAgentSpec("run-effort")?.reasoningEffort, "high");
  assert.equal(migrated.getChatSession("session-effort").reasoningEffort, "high");
  assert.equal(migrated.getChatTurn("turn-effort").reasoningEffort, "high");
  migrated.close();
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
    reasoningEffort: "high",
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
  assert.equal(reopened.getAgentSpec("run-original")?.reasoningEffort, "high");
  assert.equal(reopened.getAgentResult("run-original")?.validated.result.summary, "Reviewed.");
  assert.equal(reopened.latestResultRevalidation("run-original")?.taskRevision, "b".repeat(64));
  assert.equal(reopened.parentRunId("run-retry"), "run-original");
  reopened.close();
});
