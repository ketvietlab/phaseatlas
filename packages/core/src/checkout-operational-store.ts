import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type {
  PersistedRunEvent,
  PersistedRunKind,
  PersistedRunRecord,
  PersistedRunStatus,
} from "@phaseatlas/contracts";

const SCHEMA_VERSION = "1";
const RUN_KINDS = new Set<PersistedRunKind>(["planning", "task_content", "agent"]);
const RUN_STATUSES = new Set<PersistedRunStatus>(["starting", "running", "completed", "failed", "cancelled", "interrupted"]);
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
      const run = this.database.prepare("SELECT run_id FROM runs WHERE run_id = ?").get(input.runId);
      if (!run) throw new Error(`Run ${input.runId} is not registered.`);
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

  reconcileInterruptedRuns(timestamp = new Date().toISOString()): PersistedRunEvent[] {
    const interrupted: PersistedRunEvent[] = [];
    for (const run of this.listRuns().filter((item) => item.status === "starting" || item.status === "running")) {
      interrupted.push(this.appendEvent({
        runId: run.runId,
        type: "run.interrupted",
        timestamp,
        payload: { previousStatus: run.status, reason: "worker_restarted" },
        status: "interrupted",
      }));
    }
    return interrupted;
  }

  close(): void {
    this.database.close();
  }

  private getRun(runId: string): PersistedRunRecord {
    const row = this.database.prepare(`
      SELECT run_id, kind, status, task_keys_json, created_at, updated_at FROM runs WHERE run_id = ?
    `).get(runId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Run ${runId} is not registered.`);
    return this.runFromRow(row);
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
