import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type {
  AgentResultRevalidationRecord,
  AgentRunAction,
  AgentSandbox,
  PersistedAgentRunResult,
  PersistedRunEvent,
  PersistedRunEventPage,
  PersistedRunKind,
  PersistedRunRecord,
  PersistedRunStatus,
  ValidatedAgentRunResult,
} from "@phaseatlas/contracts";

const SCHEMA_VERSION = "1";
const RUN_KINDS = new Set<PersistedRunKind>(["planning", "task_content", "agent"]);
const RUN_STATUSES = new Set<PersistedRunStatus>(["starting", "running", "completed", "failed", "cancelled", "interrupted"]);
const TERMINAL_RUN_STATUSES = new Set<PersistedRunStatus>(["completed", "failed", "cancelled", "interrupted"]);
const POST_TERMINAL_AUDIT_PREFIXES = ["lease.", "result.revalidation"];
const { DatabaseSync } = createRequire(import.meta.url)("node:" + "sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

function parseTaskKeys(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Operational store contains invalid task keys.");
  }
  return parsed;
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("Operational store contains an invalid event payload.");
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Operational store event payload must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function parseValidatedResult(value: unknown): ValidatedAgentRunResult {
  if (typeof value !== "string") throw new Error("Operational store contains an invalid agent result.");
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("result" in parsed)) {
    throw new Error("Operational store contains an invalid agent result.");
  }
  return parsed as ValidatedAgentRunResult;
}

export interface PersistedAgentRunSpecRecord {
  runId: string;
  taskKey: string;
  taskRevision: string;
  action: AgentRunAction;
  sandbox: AgentSandbox;
  checkoutId: string;
  runnerId: string;
  model?: string;
  createdAt: string;
}

export class CheckoutOperationalStore {
  readonly databasePath: string;
  private readonly database: DatabaseSyncType;

  constructor(databasePath: string, readonly checkoutId: string) {
    if (!/^[a-f0-9]{20}$/.test(checkoutId)) throw new Error("checkoutId is invalid.");
    this.databasePath = path.resolve(databasePath);
    const existingDatabase = existsSync(this.databasePath);
    mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    this.initialize(existingDatabase);
  }

  recordRun(input: {
    runId: string;
    kind: PersistedRunKind;
    status?: PersistedRunStatus;
    taskKeys?: string[];
    timestamp?: string;
  }): PersistedRunRecord {
    const timestamp = input.timestamp ?? new Date().toISOString();
    const existing = this.database.prepare("SELECT kind FROM runs WHERE run_id = ?").get(input.runId) as { kind?: string } | undefined;
    if (existing && existing.kind !== input.kind) throw new Error(`Run ${input.runId} has a conflicting kind.`);
    if (existing) return this.getRun(input.runId);
    this.database.prepare(`
      INSERT INTO runs (run_id, kind, status, task_keys_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        task_keys_json = excluded.task_keys_json,
        updated_at = excluded.updated_at
    `).run(
      input.runId,
      input.kind,
      input.status ?? "starting",
      JSON.stringify(input.taskKeys ?? []),
      timestamp,
      timestamp,
    );
    return this.getRun(input.runId);
  }

  appendEvent(input: {
    runId: string;
    type: string;
    timestamp?: string;
    payload: Record<string, unknown>;
    status?: PersistedRunStatus;
  }): PersistedRunEvent {
    const timestamp = input.timestamp ?? new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.database.prepare("SELECT run_id, status FROM runs WHERE run_id = ?").get(input.runId) as { run_id?: string; status?: string } | undefined;
      if (!run) throw new Error(`Run ${input.runId} is not registered.`);
      if (TERMINAL_RUN_STATUSES.has(run.status as PersistedRunStatus) && !POST_TERMINAL_AUDIT_PREFIXES.some((prefix) => input.type.startsWith(prefix))) {
        throw new Error(`Run ${input.runId} is already terminal.`);
      }
      const row = this.database.prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM run_events WHERE run_id = ?",
      ).get(input.runId) as { next_sequence: number };
      this.database.prepare(`
        INSERT INTO run_events (run_id, sequence, event_type, timestamp, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.runId, row.next_sequence, input.type, timestamp, JSON.stringify(input.payload));
      if (input.status) {
        this.database.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?")
          .run(input.status, timestamp, input.runId);
      } else {
        this.database.prepare("UPDATE runs SET updated_at = ? WHERE run_id = ?")
          .run(timestamp, input.runId);
      }
      this.database.exec("COMMIT");
      return {
        runId: input.runId,
        sequence: row.next_sequence,
        type: input.type,
        timestamp,
        payload: input.payload,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listRuns(): PersistedRunRecord[] {
    const rows = this.database.prepare(`
      SELECT run_id, kind, status, task_keys_json, created_at, updated_at
      FROM runs ORDER BY created_at DESC, run_id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.runFromRow(row));
  }

  getRun(runId: string): PersistedRunRecord {
    const row = this.database.prepare(`
      SELECT run_id, kind, status, task_keys_json, created_at, updated_at FROM runs WHERE run_id = ?
    `).get(runId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Run ${runId} is not registered.`);
    return this.runFromRow(row);
  }

  listEvents(runId: string, afterSequence = 0): PersistedRunEvent[] {
    const rows = this.database.prepare(`
      SELECT run_id, sequence, event_type, timestamp, payload_json
      FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC
    `).all(runId, afterSequence) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      runId: String(row.run_id),
      sequence: Number(row.sequence),
      type: String(row.event_type),
      timestamp: String(row.timestamp),
      payload: parsePayload(row.payload_json),
    }));
  }

  listEventsPage(runId: string, afterSequence = 0, limit = 200): PersistedRunEventPage {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("afterSequence must be a non-negative integer.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be between 1 and 500.");
    this.getRun(runId);
    const rows = this.database.prepare(`
      SELECT run_id, sequence, event_type, timestamp, payload_json
      FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(runId, afterSequence, limit + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => ({
      runId: String(row.run_id),
      sequence: Number(row.sequence),
      type: String(row.event_type),
      timestamp: String(row.timestamp),
      payload: parsePayload(row.payload_json),
    }));
    return {
      runId,
      events,
      afterSequence,
      nextSequence: events.at(-1)?.sequence ?? afterSequence,
      hasMore,
    };
  }

  terminalizeRun(input: {
    runId: string;
    status: Extract<PersistedRunStatus, "completed" | "failed" | "cancelled" | "interrupted">;
    type: string;
    payload: Record<string, unknown>;
    timestamp?: string;
  }): { accepted: boolean; run: PersistedRunRecord; event?: PersistedRunEvent } {
    const timestamp = input.timestamp ?? new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare("SELECT status FROM runs WHERE run_id = ?").get(input.runId) as { status?: string } | undefined;
      if (!current) throw new Error(`Run ${input.runId} is not registered.`);
      if (TERMINAL_RUN_STATUSES.has(current.status as PersistedRunStatus)) {
        this.database.exec("COMMIT");
        return { accepted: false, run: this.getRun(input.runId) };
      }
      const row = this.database.prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM run_events WHERE run_id = ?",
      ).get(input.runId) as { next_sequence: number };
      this.database.prepare(`
        INSERT INTO run_events (run_id, sequence, event_type, timestamp, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.runId, row.next_sequence, input.type, timestamp, JSON.stringify(input.payload));
      this.database.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?")
        .run(input.status, timestamp, input.runId);
      this.database.exec("COMMIT");
      return {
        accepted: true,
        run: this.getRun(input.runId),
        event: {
          runId: input.runId,
          sequence: row.next_sequence,
          type: input.type,
          timestamp,
          payload: input.payload,
        },
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordAgentSpec(input: PersistedAgentRunSpecRecord): PersistedAgentRunSpecRecord {
    if (input.checkoutId !== this.checkoutId) throw new Error("Agent run spec belongs to a different checkout.");
    const run = this.getRun(input.runId);
    if (run.kind !== "agent") throw new Error("Agent run spec requires an agent run.");
    this.database.prepare(`
      INSERT INTO agent_run_specs (
        run_id, task_key, task_revision, action, sandbox, checkout_id, runner_id, model_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.taskKey,
      input.taskRevision,
      input.action,
      input.sandbox,
      input.checkoutId,
      input.runnerId,
      input.model ?? null,
      input.createdAt,
    );
    return input;
  }

  getAgentSpec(runId: string): PersistedAgentRunSpecRecord | null {
    const row = this.database.prepare("SELECT * FROM agent_run_specs WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      runId: String(row.run_id),
      taskKey: String(row.task_key),
      taskRevision: String(row.task_revision),
      action: String(row.action) as AgentRunAction,
      sandbox: String(row.sandbox) as AgentSandbox,
      checkoutId: String(row.checkout_id),
      runnerId: String(row.runner_id),
      ...(typeof row.model_id === "string" ? { model: row.model_id } : {}),
      createdAt: String(row.created_at),
    };
  }

  recordAgentResult(input: PersistedAgentRunResult): PersistedAgentRunResult {
    const spec = this.getAgentSpec(input.runId);
    if (!spec || spec.taskKey !== input.taskKey || spec.taskRevision !== input.taskRevision) {
      throw new Error("Agent result does not match its persisted run specification.");
    }
    if (TERMINAL_RUN_STATUSES.has(this.getRun(input.runId).status)) {
      throw new Error("Agent result cannot be recorded after terminal state.");
    }
    this.database.prepare(`
      INSERT INTO agent_run_results (run_id, task_key, task_revision, recorded_at, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.runId, input.taskKey, input.taskRevision, input.recordedAt, JSON.stringify(input.validated));
    return input;
  }

  getAgentResult(runId: string): PersistedAgentRunResult | null {
    const row = this.database.prepare("SELECT * FROM agent_run_results WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      runId: String(row.run_id),
      taskKey: String(row.task_key),
      taskRevision: String(row.task_revision),
      recordedAt: String(row.recorded_at),
      validated: parseValidatedResult(row.result_json),
    };
  }

  recordResultRevalidation(input: AgentResultRevalidationRecord): AgentResultRevalidationRecord {
    if (!input.reviewer.trim()) throw new Error("Revalidation reviewer is required.");
    if (!this.getAgentResult(input.runId)) throw new Error("Agent result does not exist.");
    this.database.prepare(`
      INSERT INTO agent_result_revalidations (run_id, task_revision, outcome, reviewer, recorded_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.runId, input.taskRevision, input.outcome, input.reviewer, input.recordedAt);
    return input;
  }

  latestResultRevalidation(runId: string): AgentResultRevalidationRecord | null {
    const row = this.database.prepare(`
      SELECT run_id, task_revision, outcome, reviewer, recorded_at
      FROM agent_result_revalidations WHERE run_id = ? ORDER BY id DESC LIMIT 1
    `).get(runId) as Record<string, unknown> | undefined;
    return row ? {
      runId: String(row.run_id),
      taskRevision: String(row.task_revision),
      outcome: String(row.outcome) as "passed" | "failed",
      reviewer: String(row.reviewer),
      recordedAt: String(row.recorded_at),
    } : null;
  }

  linkRunAttempt(runId: string, parentRunId: string): void {
    if (runId === parentRunId) throw new Error("A run cannot retry itself.");
    this.getRun(runId);
    this.getRun(parentRunId);
    this.database.prepare("INSERT INTO run_attempt_links (run_id, parent_run_id) VALUES (?, ?)")
      .run(runId, parentRunId);
  }

  parentRunId(runId: string): string | null {
    const row = this.database.prepare("SELECT parent_run_id FROM run_attempt_links WHERE run_id = ?").get(runId) as { parent_run_id?: string } | undefined;
    return row?.parent_run_id ?? null;
  }

  reconcileInterruptedRuns(timestamp = new Date().toISOString()): PersistedRunEvent[] {
    const interrupted: PersistedRunEvent[] = [];
    for (const run of this.listRuns().filter((item) => item.status === "starting" || item.status === "running")) {
      const terminal = this.terminalizeRun({
        runId: run.runId,
        type: "run.interrupted",
        timestamp,
        payload: { previousStatus: run.status, reason: "worker_restarted" },
        status: "interrupted",
      });
      if (terminal.event) interrupted.push(terminal.event);
    }
    return interrupted;
  }

  close(): void {
    this.database.close();
  }

  private runFromRow(row: Record<string, unknown>): PersistedRunRecord {
    const kind = String(row.kind) as PersistedRunKind;
    const status = String(row.status) as PersistedRunStatus;
    if (!RUN_KINDS.has(kind) || !RUN_STATUSES.has(status) || !String(row.run_id)) {
      throw new Error("Operational store contains invalid run metadata.");
    }
    return {
      runId: String(row.run_id),
      kind,
      status,
      taskKeys: parseTaskKeys(row.task_keys_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private initialize(existingDatabase: boolean): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('planning', 'task_content', 'agent')),
        status TEXT NOT NULL CHECK(status IN ('starting', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
        task_keys_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS agent_run_specs (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        task_key TEXT NOT NULL,
        task_revision TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('analyze', 'plan', 'implement', 'review')),
        sandbox TEXT NOT NULL CHECK(sandbox IN ('read-only', 'workspace-write')),
        checkout_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        model_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_run_results (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        task_key TEXT NOT NULL,
        task_revision TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_result_revalidations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES agent_run_results(run_id) ON DELETE CASCADE,
        task_revision TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('passed', 'failed')),
        reviewer TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_attempt_links (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        parent_run_id TEXT NOT NULL REFERENCES runs(run_id)
      );
    `);
    const schema = this.database.prepare("SELECT value FROM store_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    if (existingDatabase && !schema?.value) this.failInitialization("Checkout store schema metadata is missing.");
    if (schema?.value && schema.value !== SCHEMA_VERSION) {
      this.failInitialization(`Unsupported checkout store schema version ${schema.value}.`);
    }
    const identity = this.database.prepare("SELECT value FROM store_meta WHERE key = 'checkout_id'").get() as { value?: string } | undefined;
    if (existingDatabase && !identity?.value) this.failInitialization("Checkout store identity metadata is missing.");
    if (identity?.value && identity.value !== this.checkoutId) {
      this.failInitialization("Checkout store identity does not match its worker checkout.");
    }
    this.database.prepare("INSERT OR IGNORE INTO store_meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
    this.database.prepare("INSERT OR IGNORE INTO store_meta (key, value) VALUES ('checkout_id', ?)").run(this.checkoutId);
  }

  private failInitialization(message: string): never {
    this.database.close();
    throw new Error(message);
  }
}
