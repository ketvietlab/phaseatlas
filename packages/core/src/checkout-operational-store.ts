import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type {
  AgentResultRevalidationRecord,
  AgentRunAction,
  AgentRunCommandOutputPage,
  AgentSandbox,
  PersistedAgentRunResult,
  PersistedRunEvent,
  PersistedRunEventPage,
  PersistedRunKind,
  PersistedRunRecord,
  PersistedRunStatus,
  PersistedRepositoryChatEvent,
  RepositoryChatAttachment,
  RepositoryChatEventPage,
  RepositoryChatMessage,
  RepositoryChatSession,
  RepositoryChatTurn,
  RepositoryChatTurnStatus,
  ValidatedAgentRunResult,
} from "@phaseatlas/contracts";

const SCHEMA_VERSION = "3";
const RUN_KINDS = new Set<PersistedRunKind>(["planning", "task_content", "agent"]);
const RUN_STATUSES = new Set<PersistedRunStatus>(["starting", "running", "completed", "failed", "cancelled", "interrupted"]);
const TERMINAL_RUN_STATUSES = new Set<PersistedRunStatus>(["completed", "failed", "cancelled", "interrupted"]);
const POST_TERMINAL_AUDIT_PREFIXES = ["lease.", "result.revalidation", "chat.edit.audit."];
const TERMINAL_CHAT_TURN_STATUSES = new Set<RepositoryChatTurnStatus>(["completed", "failed", "cancelled", "interrupted"]);
const CHAT_EVENT_TYPES = new Set<PersistedRepositoryChatEvent["type"]>([
  "chat.turn.status",
  "chat.assistant.delta",
  "chat.reasoning",
  "chat.tool.started",
  "chat.tool.output",
  "chat.tool.completed",
  "chat.file.reference",
  "chat.usage",
  "chat.turn.completed",
  "chat.turn.failed",
  "chat.turn.cancelled",
  "chat.turn.interrupted",
]);
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

function parseAttachments(value: unknown): RepositoryChatAttachment[] {
  if (typeof value !== "string") throw new Error("Operational store contains invalid chat attachments.");
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== "object" || Array.isArray(item) || typeof (item as { path?: unknown }).path !== "string")) {
    throw new Error("Operational store contains invalid chat attachments.");
  }
  return parsed as RepositoryChatAttachment[];
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
  reasoningEffort?: string;
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
    let persistedPayload = input.payload;
    let commandOutput: { commandId: string; text: string } | undefined;
    if (input.type === "command.output") {
      const commandId = input.payload.commandId;
      const text = input.payload.text;
      if (typeof commandId !== "string" || !commandId.trim() || typeof text !== "string") {
        throw new Error("Command output requires commandId and text.");
      }
      commandOutput = { commandId, text };
      persistedPayload = { commandId, characterCount: [...text].length };
    }
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
      if (commandOutput) {
        this.database.prepare(`
          INSERT INTO agent_command_outputs (
            run_id, command_id, chunk_sequence, text, character_count, created_at
          ) VALUES (?, ?, ?, ?, length(?), ?)
        `).run(input.runId, commandOutput.commandId, row.next_sequence, commandOutput.text, commandOutput.text, timestamp);
      }
      this.database.prepare(`
        INSERT INTO run_events (run_id, sequence, event_type, timestamp, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.runId, row.next_sequence, input.type, timestamp, JSON.stringify(persistedPayload));
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
        payload: persistedPayload,
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

  readAgentCommandOutput(
    runId: string,
    commandId: string,
    offset = 0,
    limit = 20_000,
  ): AgentRunCommandOutputPage {
    if (!commandId.trim()) throw new Error("commandId is required.");
    if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50_000) throw new Error("limit must be between 1 and 50000.");
    const run = this.getRun(runId);
    if (run.kind !== "agent") throw new Error("Command output belongs to an agent run.");
    const command = this.database.prepare(`
      SELECT 1 FROM run_events
      WHERE run_id = ? AND event_type = 'command.started'
        AND json_extract(payload_json, '$.commandId') = ?
      LIMIT 1
    `).get(runId, commandId);
    if (!command) throw new Error("Command does not exist in this run.");
    const totalRow = this.database.prepare(`
      SELECT COALESCE(SUM(character_count), 0) AS total
      FROM agent_command_outputs WHERE run_id = ? AND command_id = ?
    `).get(runId, commandId) as { total: number };
    const totalCharacters = Number(totalRow.total);
    const pageOffset = Math.min(offset, totalCharacters);
    const end = Math.min(pageOffset + limit, totalCharacters);
    const chunks = this.database.prepare(`
      SELECT chunk_sequence, character_count
      FROM agent_command_outputs
      WHERE run_id = ? AND command_id = ?
      ORDER BY chunk_sequence
    `).all(runId, commandId) as Array<{ chunk_sequence: number; character_count: number }>;
    let chunkStart = 0;
    let text = "";
    for (const chunk of chunks) {
      const chunkEnd = chunkStart + Number(chunk.character_count);
      if (chunkEnd > pageOffset && chunkStart < end) {
        const localStart = Math.max(pageOffset - chunkStart, 0);
        const take = Math.min(chunkEnd, end) - (chunkStart + localStart);
        const row = this.database.prepare(`
          SELECT substr(text, ?, ?) AS text FROM agent_command_outputs
          WHERE run_id = ? AND command_id = ? AND chunk_sequence = ?
        `).get(localStart + 1, take, runId, commandId, chunk.chunk_sequence) as { text?: string };
        text += row.text ?? "";
      }
      chunkStart = chunkEnd;
      if (chunkStart >= end) break;
    }
    return {
      runId,
      commandId,
      offset: pageOffset,
      nextOffset: end,
      totalCharacters,
      hasMore: end < totalCharacters,
      text,
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
        run_id, task_key, task_revision, action, sandbox, checkout_id, runner_id, model_id, reasoning_effort, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.taskKey,
      input.taskRevision,
      input.action,
      input.sandbox,
      input.checkoutId,
      input.runnerId,
      input.model ?? null,
      input.reasoningEffort ?? null,
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
      ...(typeof row.reasoning_effort === "string" ? { reasoningEffort: row.reasoning_effort } : {}),
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

  createChatSession(input: RepositoryChatSession): RepositoryChatSession {
    if (input.checkoutId !== this.checkoutId) throw new Error("Chat session belongs to a different checkout.");
    if (!input.sessionId.trim() || !input.runnerId.trim() || !input.model.trim() || !input.title.trim()) {
      throw new Error("Chat session metadata is incomplete.");
    }
    this.database.prepare(`
      INSERT INTO chat_sessions (
        session_id, checkout_id, runner_id, model_id, reasoning_effort, title, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      input.checkoutId,
      input.runnerId,
      input.model,
      input.reasoningEffort ?? null,
      input.title,
      input.state,
      input.createdAt,
      input.updatedAt,
    );
    return this.getChatSession(input.sessionId);
  }

  listChatSessions(): RepositoryChatSession[] {
    const rows = this.database.prepare(`
      SELECT * FROM chat_sessions ORDER BY updated_at DESC, session_id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.chatSessionFromRow(row));
  }

  getChatSession(sessionId: string): RepositoryChatSession {
    const row = this.database.prepare("SELECT * FROM chat_sessions WHERE session_id = ?").get(sessionId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Chat session ${sessionId} is not registered.`);
    return this.chatSessionFromRow(row);
  }

  renameChatSession(sessionId: string, title: string, timestamp = new Date().toISOString()): RepositoryChatSession {
    if (!title.trim()) throw new Error("Chat session title is required.");
    this.getChatSession(sessionId);
    this.database.prepare("UPDATE chat_sessions SET title = ?, updated_at = ? WHERE session_id = ?")
      .run(title.trim(), timestamp, sessionId);
    return this.getChatSession(sessionId);
  }

  closeChatSession(sessionId: string, timestamp = new Date().toISOString()): RepositoryChatSession {
    const session = this.getChatSession(sessionId);
    const active = this.database.prepare(`
      SELECT turn_id FROM chat_turns WHERE session_id = ? AND status IN ('starting', 'running') LIMIT 1
    `).get(sessionId) as { turn_id?: string } | undefined;
    if (active?.turn_id) throw new Error("Cancel the active chat turn before closing this session.");
    if (session.state !== "closed") {
      this.database.prepare("UPDATE chat_sessions SET state = 'closed', updated_at = ? WHERE session_id = ?")
        .run(timestamp, sessionId);
    }
    return this.getChatSession(sessionId);
  }

  createChatTurn(input: {
    turn: RepositoryChatTurn;
    userMessage?: RepositoryChatMessage;
  }): RepositoryChatTurn {
    const session = this.getChatSession(input.turn.sessionId);
    if (session.state !== "open") throw new Error("Chat session is closed.");
    if (
      input.turn.runnerId !== session.runnerId || input.turn.model !== session.model ||
      input.turn.reasoningEffort !== session.reasoningEffort
    ) {
      throw new Error("Chat turn provider does not match its session.");
    }
    if (!input.turn.turnId.trim() || !input.turn.userMessageId.trim() || input.turn.status !== "starting") {
      throw new Error("Chat turn metadata is invalid.");
    }
    const active = this.database.prepare(`
      SELECT turn_id FROM chat_turns WHERE session_id = ? AND status IN ('starting', 'running') LIMIT 1
    `).get(session.sessionId) as { turn_id?: string } | undefined;
    if (active?.turn_id) throw new Error("Chat session already has an active turn.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (input.userMessage) {
        if (input.userMessage.sessionId !== session.sessionId || input.userMessage.role !== "user") {
          throw new Error("Chat user message does not match its turn.");
        }
        if (
          input.userMessage.messageId !== input.turn.userMessageId ||
          input.userMessage.turnId !== input.turn.turnId ||
          !input.userMessage.content.trim() ||
          !Number.isInteger(input.userMessage.sequence) || input.userMessage.sequence < 1
        ) {
          throw new Error("Chat user message metadata is invalid.");
        }
        this.database.prepare(`
          INSERT INTO chat_messages (
            message_id, session_id, turn_id, role, content, attachments_json, sequence, created_at
          ) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)
        `).run(
          input.userMessage.messageId,
          session.sessionId,
          input.turn.turnId,
          input.userMessage.content,
          JSON.stringify(input.userMessage.attachments),
          input.userMessage.sequence,
          input.userMessage.createdAt,
        );
      } else {
        const existing = this.getChatMessage(input.turn.userMessageId);
        if (existing.sessionId !== session.sessionId || existing.role !== "user") {
          throw new Error("Retry message does not belong to this chat session.");
        }
        if (!input.turn.parentTurnId) throw new Error("A reused chat message requires a parent turn.");
        const parent = this.getChatTurn(input.turn.parentTurnId);
        if (
          parent.sessionId !== session.sessionId || parent.status !== "interrupted" ||
          parent.userMessageId !== input.turn.userMessageId
        ) {
          throw new Error("Chat retry does not match an interrupted parent turn.");
        }
      }
      this.database.prepare(`
        INSERT INTO chat_turns (
          turn_id, session_id, status, runner_id, model_id, reasoning_effort, user_message_id,
          assistant_message_id, parent_turn_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `).run(
        input.turn.turnId,
        session.sessionId,
        input.turn.status,
        input.turn.runnerId,
        input.turn.model,
        input.turn.reasoningEffort ?? null,
        input.turn.userMessageId,
        input.turn.parentTurnId ?? null,
        input.turn.createdAt,
        input.turn.updatedAt,
      );
      this.database.prepare("UPDATE chat_sessions SET updated_at = ? WHERE session_id = ?")
        .run(input.turn.updatedAt, session.sessionId);
      this.database.exec("COMMIT");
      return this.getChatTurn(input.turn.turnId);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  nextChatMessageSequence(sessionId: string): number {
    this.getChatSession(sessionId);
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM chat_messages WHERE session_id = ?",
    ).get(sessionId) as { next_sequence: number };
    return row.next_sequence;
  }

  listChatMessages(sessionId: string): RepositoryChatMessage[] {
    this.getChatSession(sessionId);
    const rows = this.database.prepare(`
      SELECT * FROM chat_messages WHERE session_id = ? ORDER BY sequence, message_id
    `).all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.chatMessageFromRow(row));
  }

  getChatMessage(messageId: string): RepositoryChatMessage {
    const row = this.database.prepare("SELECT * FROM chat_messages WHERE message_id = ?").get(messageId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Chat message ${messageId} is not registered.`);
    return this.chatMessageFromRow(row);
  }

  listChatTurns(sessionId: string): RepositoryChatTurn[] {
    this.getChatSession(sessionId);
    const rows = this.database.prepare(`
      SELECT * FROM chat_turns WHERE session_id = ? ORDER BY created_at, turn_id
    `).all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.chatTurnFromRow(row));
  }

  getChatTurn(turnId: string): RepositoryChatTurn {
    const row = this.database.prepare("SELECT * FROM chat_turns WHERE turn_id = ?").get(turnId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Chat turn ${turnId} is not registered.`);
    return this.chatTurnFromRow(row);
  }

  appendChatEvent(input: {
    turnId: string;
    type: PersistedRepositoryChatEvent["type"];
    payload: Record<string, unknown>;
    status?: Extract<RepositoryChatTurnStatus, "running">;
    timestamp?: string;
  }): PersistedRepositoryChatEvent {
    if (!CHAT_EVENT_TYPES.has(input.type) || input.type.startsWith("chat.turn.") && input.type !== "chat.turn.status") {
      throw new Error("Chat adapter event type is invalid.");
    }
    const timestamp = input.timestamp ?? new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const turn = this.getChatTurn(input.turnId);
      if (TERMINAL_CHAT_TURN_STATUSES.has(turn.status)) throw new Error(`Chat turn ${input.turnId} is already terminal.`);
      const row = this.database.prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM chat_turn_events WHERE turn_id = ?",
      ).get(input.turnId) as { next_sequence: number };
      this.database.prepare(`
        INSERT INTO chat_turn_events (turn_id, sequence, event_type, timestamp, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.turnId, row.next_sequence, input.type, timestamp, JSON.stringify(input.payload));
      this.database.prepare("UPDATE chat_turns SET status = COALESCE(?, status), updated_at = ? WHERE turn_id = ?")
        .run(input.status ?? null, timestamp, input.turnId);
      this.database.prepare("UPDATE chat_sessions SET updated_at = ? WHERE session_id = ?")
        .run(timestamp, turn.sessionId);
      this.database.exec("COMMIT");
      return { turnId: input.turnId, sequence: row.next_sequence, type: input.type, timestamp, payload: input.payload };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listChatEventPage(turnId: string, afterSequence = 0, limit = 200): RepositoryChatEventPage {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error("afterSequence must be a non-negative integer.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be between 1 and 500.");
    this.getChatTurn(turnId);
    const rows = this.database.prepare(`
      SELECT * FROM chat_turn_events WHERE turn_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
    `).all(turnId, afterSequence, limit + 1) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => this.chatEventFromRow(row));
    return {
      turnId,
      events,
      afterSequence,
      nextSequence: events.at(-1)?.sequence ?? afterSequence,
      hasMore,
    };
  }

  completeChatTurn(input: {
    turnId: string;
    assistantMessage: RepositoryChatMessage;
    timestamp?: string;
  }): { accepted: boolean; turn: RepositoryChatTurn; event?: PersistedRepositoryChatEvent } {
    const timestamp = input.timestamp ?? input.assistantMessage.createdAt;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const turn = this.getChatTurn(input.turnId);
      if (TERMINAL_CHAT_TURN_STATUSES.has(turn.status)) {
        this.database.exec("COMMIT");
        return { accepted: false, turn };
      }
      if (input.assistantMessage.sessionId !== turn.sessionId || input.assistantMessage.role !== "assistant") {
        throw new Error("Assistant message does not match its chat turn.");
      }
      if (
        input.assistantMessage.turnId !== input.turnId || !input.assistantMessage.messageId.trim() ||
        !input.assistantMessage.content.trim() || !Number.isInteger(input.assistantMessage.sequence) ||
        input.assistantMessage.sequence < 1 || input.assistantMessage.attachments.length
      ) {
        throw new Error("Assistant message metadata is invalid.");
      }
      const eventRow = this.database.prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM chat_turn_events WHERE turn_id = ?",
      ).get(input.turnId) as { next_sequence: number };
      this.database.prepare(`
        INSERT INTO chat_messages (
          message_id, session_id, turn_id, role, content, attachments_json, sequence, created_at
        ) VALUES (?, ?, ?, 'assistant', ?, '[]', ?, ?)
      `).run(
        input.assistantMessage.messageId,
        turn.sessionId,
        input.turnId,
        input.assistantMessage.content,
        input.assistantMessage.sequence,
        input.assistantMessage.createdAt,
      );
      this.database.prepare(`
        INSERT INTO chat_turn_events (turn_id, sequence, event_type, timestamp, payload_json)
        VALUES (?, ?, 'chat.turn.completed', ?, ?)
      `).run(input.turnId, eventRow.next_sequence, timestamp, JSON.stringify({ messageId: input.assistantMessage.messageId }));
      this.database.prepare(`
        UPDATE chat_turns SET status = 'completed', assistant_message_id = ?, updated_at = ? WHERE turn_id = ?
      `).run(input.assistantMessage.messageId, timestamp, input.turnId);
      this.database.prepare("UPDATE chat_sessions SET updated_at = ? WHERE session_id = ?")
        .run(timestamp, turn.sessionId);
      this.database.exec("COMMIT");
      return {
        accepted: true,
        turn: this.getChatTurn(input.turnId),
        event: {
          turnId: input.turnId,
          sequence: eventRow.next_sequence,
          type: "chat.turn.completed",
          timestamp,
          payload: { messageId: input.assistantMessage.messageId },
        },
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  terminalizeChatTurn(input: {
    turnId: string;
    status: Extract<RepositoryChatTurnStatus, "failed" | "cancelled" | "interrupted">;
    type: Extract<PersistedRepositoryChatEvent["type"], "chat.turn.failed" | "chat.turn.cancelled" | "chat.turn.interrupted">;
    payload: Record<string, unknown>;
    timestamp?: string;
  }): { accepted: boolean; turn: RepositoryChatTurn; event?: PersistedRepositoryChatEvent } {
    const timestamp = input.timestamp ?? new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const turn = this.getChatTurn(input.turnId);
      if (TERMINAL_CHAT_TURN_STATUSES.has(turn.status)) {
        this.database.exec("COMMIT");
        return { accepted: false, turn };
      }
      const row = this.database.prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM chat_turn_events WHERE turn_id = ?",
      ).get(input.turnId) as { next_sequence: number };
      this.database.prepare(`
        INSERT INTO chat_turn_events (turn_id, sequence, event_type, timestamp, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.turnId, row.next_sequence, input.type, timestamp, JSON.stringify(input.payload));
      this.database.prepare("UPDATE chat_turns SET status = ?, updated_at = ? WHERE turn_id = ?")
        .run(input.status, timestamp, input.turnId);
      this.database.prepare("UPDATE chat_sessions SET updated_at = ? WHERE session_id = ?")
        .run(timestamp, turn.sessionId);
      this.database.exec("COMMIT");
      return {
        accepted: true,
        turn: this.getChatTurn(input.turnId),
        event: { turnId: input.turnId, sequence: row.next_sequence, type: input.type, timestamp, payload: input.payload },
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  reconcileInterruptedChatTurns(timestamp = new Date().toISOString()): PersistedRepositoryChatEvent[] {
    const events: PersistedRepositoryChatEvent[] = [];
    const rows = this.database.prepare(`
      SELECT turn_id FROM chat_turns WHERE status IN ('starting', 'running') ORDER BY created_at, turn_id
    `).all() as Array<{ turn_id: string }>;
    for (const row of rows) {
      const terminal = this.terminalizeChatTurn({
        turnId: row.turn_id,
        status: "interrupted",
        type: "chat.turn.interrupted",
        payload: { reason: "worker_restarted" },
        timestamp,
      });
      if (terminal.event) events.push(terminal.event);
    }
    return events;
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

  private chatSessionFromRow(row: Record<string, unknown>): RepositoryChatSession {
    const state = String(row.state);
    if (
      !String(row.session_id) || String(row.checkout_id) !== this.checkoutId ||
      !String(row.runner_id) || !String(row.model_id) || !String(row.title) ||
      !["open", "closed"].includes(state)
    ) {
      throw new Error("Operational store contains invalid chat session metadata.");
    }
    return {
      sessionId: String(row.session_id),
      checkoutId: String(row.checkout_id),
      runnerId: String(row.runner_id),
      model: String(row.model_id),
      ...(typeof row.reasoning_effort === "string" ? { reasoningEffort: row.reasoning_effort } : {}),
      title: String(row.title),
      state: state as RepositoryChatSession["state"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private chatMessageFromRow(row: Record<string, unknown>): RepositoryChatMessage {
    const role = String(row.role);
    if (
      !String(row.message_id) || !String(row.session_id) || !String(row.content) ||
      !["user", "assistant"].includes(role) || !Number.isInteger(Number(row.sequence)) || Number(row.sequence) < 1
    ) {
      throw new Error("Operational store contains invalid chat message metadata.");
    }
    return {
      messageId: String(row.message_id),
      sessionId: String(row.session_id),
      ...(typeof row.turn_id === "string" ? { turnId: row.turn_id } : {}),
      role: role as RepositoryChatMessage["role"],
      content: String(row.content),
      attachments: parseAttachments(row.attachments_json),
      sequence: Number(row.sequence),
      createdAt: String(row.created_at),
    };
  }

  private chatTurnFromRow(row: Record<string, unknown>): RepositoryChatTurn {
    const status = String(row.status) as RepositoryChatTurnStatus;
    if (
      !String(row.turn_id) || !String(row.session_id) || !String(row.runner_id) ||
      !String(row.model_id) || !String(row.user_message_id) ||
      !["starting", "running", "completed", "failed", "cancelled", "interrupted"].includes(status)
    ) {
      throw new Error("Operational store contains invalid chat turn metadata.");
    }
    return {
      turnId: String(row.turn_id),
      sessionId: String(row.session_id),
      status,
      runnerId: String(row.runner_id),
      model: String(row.model_id),
      ...(typeof row.reasoning_effort === "string" ? { reasoningEffort: row.reasoning_effort } : {}),
      userMessageId: String(row.user_message_id),
      ...(typeof row.assistant_message_id === "string" ? { assistantMessageId: row.assistant_message_id } : {}),
      ...(typeof row.parent_turn_id === "string" ? { parentTurnId: row.parent_turn_id } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private chatEventFromRow(row: Record<string, unknown>): PersistedRepositoryChatEvent {
    const type = String(row.event_type) as PersistedRepositoryChatEvent["type"];
    const sequence = Number(row.sequence);
    if (!String(row.turn_id) || !CHAT_EVENT_TYPES.has(type) || !Number.isInteger(sequence) || sequence < 1) {
      throw new Error("Operational store contains invalid chat event metadata.");
    }
    return {
      turnId: String(row.turn_id),
      sequence,
      type,
      timestamp: String(row.timestamp),
      payload: parsePayload(row.payload_json),
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
        reasoning_effort TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_run_results (
        run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
        task_key TEXT NOT NULL,
        task_revision TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_command_outputs (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        command_id TEXT NOT NULL,
        chunk_sequence INTEGER NOT NULL,
        text TEXT NOT NULL,
        character_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, command_id, chunk_sequence)
      );
      CREATE INDEX IF NOT EXISTS agent_command_outputs_lookup
        ON agent_command_outputs(run_id, command_id, chunk_sequence);
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
      CREATE TABLE IF NOT EXISTS chat_sessions (
        session_id TEXT PRIMARY KEY,
        checkout_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        reasoning_effort TEXT,
        title TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('open', 'closed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
        turn_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS chat_turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('starting', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
        runner_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        reasoning_effort TEXT,
        user_message_id TEXT NOT NULL REFERENCES chat_messages(message_id),
        assistant_message_id TEXT REFERENCES chat_messages(message_id),
        parent_turn_id TEXT REFERENCES chat_turns(turn_id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_turn_events (
        turn_id TEXT NOT NULL REFERENCES chat_turns(turn_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (turn_id, sequence)
      );
    `);
    const schema = this.database.prepare("SELECT value FROM store_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    if (existingDatabase && !schema?.value) this.failInitialization("Checkout store schema metadata is missing.");
    let schemaVersion = schema?.value;
    if (schemaVersion === "1") {
      this.migrateVersionOne();
      schemaVersion = "2";
    }
    if (schemaVersion === "2") {
      this.migrateVersionTwo();
      schemaVersion = "3";
    }
    if (schemaVersion && schemaVersion !== SCHEMA_VERSION) {
      this.failInitialization(`Unsupported checkout store schema version ${schemaVersion}.`);
    }
    const identity = this.database.prepare("SELECT value FROM store_meta WHERE key = 'checkout_id'").get() as { value?: string } | undefined;
    if (existingDatabase && !identity?.value) this.failInitialization("Checkout store identity metadata is missing.");
    if (identity?.value && identity.value !== this.checkoutId) {
      this.failInitialization("Checkout store identity does not match its worker checkout.");
    }
    this.database.prepare("INSERT OR IGNORE INTO store_meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
    this.database.prepare("INSERT OR IGNORE INTO store_meta (key, value) VALUES ('checkout_id', ?)").run(this.checkoutId);
  }

  private migrateVersionOne(): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        INSERT OR IGNORE INTO agent_command_outputs (
          run_id, command_id, chunk_sequence, text, character_count, created_at
        )
        SELECT
          run_id,
          json_extract(payload_json, '$.commandId'),
          sequence,
          json_extract(payload_json, '$.text'),
          length(json_extract(payload_json, '$.text')),
          timestamp
        FROM run_events
        WHERE event_type = 'command.output'
          AND json_type(payload_json, '$.commandId') = 'text'
          AND json_type(payload_json, '$.text') = 'text';

        UPDATE run_events
        SET payload_json = json_object(
          'commandId', json_extract(payload_json, '$.commandId'),
          'characterCount', length(json_extract(payload_json, '$.text'))
        )
        WHERE event_type = 'command.output'
          AND json_type(payload_json, '$.commandId') = 'text'
          AND json_type(payload_json, '$.text') = 'text';

        UPDATE run_events
        SET event_type = 'run.cancelled'
        WHERE event_type = 'run.status'
          AND json_extract(payload_json, '$.status') = 'cancelled';

        UPDATE store_meta SET value = '2' WHERE key = 'schema_version';
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateVersionTwo(): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.addColumnIfMissing("agent_run_specs", "reasoning_effort", "TEXT");
      this.addColumnIfMissing("chat_sessions", "reasoning_effort", "TEXT");
      this.addColumnIfMissing("chat_turns", "reasoning_effort", "TEXT");
      this.database.prepare("UPDATE store_meta SET value = '3' WHERE key = 'schema_version'").run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (!columns.some((candidate) => candidate.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private failInitialization(message: string): never {
    this.database.close();
    throw new Error(message);
  }
}
