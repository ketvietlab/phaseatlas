import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { utilityProcess, type UtilityProcess } from "electron";
import {
  type AgentResultReview,
  type AgentRunActionAvailability,
  type AgentRunActionQuery,
  type AgentRunCancellationResult,
  type AgentRunCommandOutputPage,
  type AgentRunRecoveryInput,
  type AgentRunRecoveryResult,
  type AgentRunStartInput,
  type AgentRunSummary,
  type ChatEditCancellationResult,
  type ChatEditConfirmation,
  type ChatEditPrepareInput,
  type ChatEditRecoveryInput,
  type ChatEditResult,
  type ChatEditStartInput,
  type CoverageEventAppendInput,
  type CoverageEventAppendResult,
  type CoverageSnapshot,
  isWorkerEvent,
  isWorkerResponse,
  type PersistedRunEvent,
  type PersistedRunEventPage,
  type PersistedRunRecord,
  type PlanningEvent,
  type PlanningPublishInput,
  type PlanningStartInput,
  type PersistedRepositoryChatEvent,
  type PhaseAtlasDesktopEvent,
  type RepositoryFileDocument,
  type RepositoryFileEntry,
  type RepositoryLifecycleState,
  type RepositoryChatCancellationResult,
  type RepositoryChatCreateInput,
  type RepositoryChatEventPage,
  type RepositoryChatMessage,
  type RepositoryChatProviderInput,
  type RepositoryChatRenameInput,
  type RepositoryChatRetryInput,
  type RepositoryChatSendInput,
  type RepositoryChatSession,
  type RepositoryChatTurn,
  type RepositorySummary,
  type RepositoryWorkerMethod,
  type RunnerDescriptor,
  type WorktreeLeaseRecord,
  type TaskContentEvent,
  type TaskContentRunSummary,
  type TaskContentStartInput,
  type TaskSnapshot,
  type TaskRegistryPublishInput,
  type TaskRegistryPublishResult,
  type TaskRegistrySource,
  type TaskRegistryValidation,
  type TaskRegistryWorkspace,
  type WorkerEvent,
  type WorkerRequest,
  type WorkerResponse,
  type WorkspaceSummary,
} from "@phaseatlas/contracts";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

interface CatalogEntry extends RepositorySummary {
  visible: boolean;
}

interface CatalogRow extends Record<string, unknown> {
  checkout_id: string;
  repository_id: string;
  name: string;
  canonical_path: string;
  configuration: "configured" | "legacy";
  workspace_count: number;
  opened_at: string;
  visible: number;
  lifecycle_state: RepositoryLifecycleState;
  recovery_required: number;
  last_error: string | null;
  updated_at: string;
  task_registry_json: string | null;
}

const CATALOG_SCHEMA_VERSION = "2";
const LIFECYCLE_STATES = new Set<RepositoryLifecycleState>(["closed", "starting", "online", "cooling", "recovery_required"]);
const ACTIVE_STATES = new Set(["starting", "running"]);
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const { DatabaseSync } = createRequire(import.meta.url)("node:" + "sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

function checkoutIdForPath(canonicalPath: string): string {
  return createHash("sha256").update(canonicalPath).digest("hex").slice(0, 20);
}

function isLegacyManifestUpgrade(descriptor: RepositorySummary, expected: RepositorySummary): boolean {
  return expected.configuration === "legacy" &&
    expected.id === `local-${expected.checkoutId}` &&
    descriptor.configuration === "configured" &&
    descriptor.checkoutId === expected.checkoutId &&
    descriptor.path === expected.path &&
    Boolean(descriptor.id) &&
    descriptor.id !== expected.id;
}

function workerEnvironment(repositoryPath: string, checkoutStorePath: string): Record<string, string> {
  const allowedKeys = [
    "PATH",
    "HOME",
    // Claude Code resolves its stored credentials through the account identity,
    // so stripping USER leaves the CLI reporting itself as signed out even when
    // the user is signed in. LOGNAME is its POSIX twin.
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "SSH_AUTH_SOCK",
    "LANG",
    "LC_ALL",
    "CODEX_HOME",
    "PHASEATLAS_CODEX_BIN",
    "PHASEATLAS_CLAUDE_BIN",
  ];
  const environment: Record<string, string> = {
    PHASEATLAS_REPO_ROOT: repositoryPath,
    PHASEATLAS_CHECKOUT_STORE_PATH: checkoutStorePath,
  };
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

class RepositoryCatalog {
  private readonly database: DatabaseSyncType;

  constructor(readonly applicationSupportRoot: string) {
    mkdirSync(applicationSupportRoot, { recursive: true });
    const databasePath = path.join(applicationSupportRoot, "catalog.sqlite");
    const existingDatabase = existsSync(databasePath);
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repositories (
        checkout_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        name TEXT NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE,
        configuration TEXT NOT NULL CHECK(configuration IN ('configured', 'legacy')),
        workspace_count INTEGER NOT NULL,
        opened_at TEXT NOT NULL,
        visible INTEGER NOT NULL DEFAULT 1,
        lifecycle_state TEXT NOT NULL,
        recovery_required INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        task_registry_json TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    const schema = this.database.prepare("SELECT value FROM catalog_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    if (existingDatabase && !schema?.value) throw new Error("Repository catalog schema metadata is missing.");
    if (schema?.value === "1") {
      this.database.exec("ALTER TABLE repositories ADD COLUMN task_registry_json TEXT;");
      this.database.prepare("UPDATE catalog_meta SET value = ? WHERE key = 'schema_version'").run(CATALOG_SCHEMA_VERSION);
    } else if (schema?.value && schema.value !== CATALOG_SCHEMA_VERSION) {
      throw new Error(`Unsupported repository catalog schema version ${schema.value}.`);
    }
    this.database.prepare("INSERT OR IGNORE INTO catalog_meta (key, value) VALUES ('schema_version', ?)")
      .run(CATALOG_SCHEMA_VERSION);
    const timestamp = new Date().toISOString();
    this.database.prepare(`
      UPDATE repositories
      SET lifecycle_state = 'recovery_required', recovery_required = 1,
          last_error = COALESCE(last_error, 'Application exited while the checkout worker was active.'),
          updated_at = ?
      WHERE lifecycle_state IN ('starting', 'online', 'cooling')
    `).run(timestamp);
  }

  listVisible(): RepositorySummary[] {
    return (this.database.prepare("SELECT * FROM repositories WHERE visible = 1 ORDER BY updated_at DESC").all() as CatalogRow[])
      .map((row) => this.summary(row));
  }

  get(checkoutId: string): CatalogEntry | null {
    const row = this.database.prepare("SELECT * FROM repositories WHERE checkout_id = ?").get(checkoutId) as CatalogRow | undefined;
    return row ? { ...this.summary(row), visible: Boolean(row.visible) } : null;
  }

  findByPath(canonicalPath: string): CatalogEntry | null {
    const row = this.database.prepare("SELECT * FROM repositories WHERE canonical_path = ?").get(canonicalPath) as CatalogRow | undefined;
    return row ? { ...this.summary(row), visible: Boolean(row.visible) } : null;
  }

  upsert(descriptor: RepositorySummary, state: RepositoryLifecycleState, visible = true): RepositorySummary {
    const timestamp = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO repositories (
        checkout_id, repository_id, name, canonical_path, configuration, workspace_count,
        opened_at, visible, lifecycle_state, recovery_required, last_error, task_registry_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
      ON CONFLICT(checkout_id) DO UPDATE SET
        repository_id = excluded.repository_id,
        name = excluded.name,
        canonical_path = excluded.canonical_path,
        configuration = excluded.configuration,
        workspace_count = excluded.workspace_count,
        visible = excluded.visible,
        lifecycle_state = excluded.lifecycle_state,
        recovery_required = 0,
        last_error = NULL,
        task_registry_json = excluded.task_registry_json,
        updated_at = excluded.updated_at
    `).run(
      descriptor.checkoutId,
      descriptor.id,
      descriptor.name,
      descriptor.path,
      descriptor.configuration,
      descriptor.workspaceCount,
      descriptor.openedAt,
      visible ? 1 : 0,
      state,
      descriptor.taskRegistry ? JSON.stringify(descriptor.taskRegistry) : null,
      timestamp,
    );
    return this.get(descriptor.checkoutId) as RepositorySummary;
  }

  setRuntime(checkoutId: string, state: RepositoryLifecycleState, error?: string): void {
    const timestamp = new Date().toISOString();
    this.database.prepare(`
      UPDATE repositories SET lifecycle_state = ?, recovery_required = ?, last_error = ?, updated_at = ?
      WHERE checkout_id = ?
    `).run(state, state === "recovery_required" ? 1 : 0, error ?? null, timestamp, checkoutId);
  }

  setVisible(checkoutId: string, visible: boolean): void {
    this.database.prepare("UPDATE repositories SET visible = ?, updated_at = ? WHERE checkout_id = ?")
      .run(visible ? 1 : 0, new Date().toISOString(), checkoutId);
  }

  close(): void {
    this.database.close();
  }

  private summary(row: CatalogRow): RepositorySummary {
    if (!/^[a-f0-9]{20}$/.test(row.checkout_id) || checkoutIdForPath(row.canonical_path) !== row.checkout_id) {
      throw new Error("Repository catalog contains an invalid checkout identity.");
    }
    if (!path.isAbsolute(row.canonical_path) || !row.repository_id || !row.name) {
      throw new Error("Repository catalog contains invalid repository metadata.");
    }
    if (!LIFECYCLE_STATES.has(row.lifecycle_state) || ![0, 1].includes(row.recovery_required) || ![0, 1].includes(row.visible)) {
      throw new Error("Repository catalog contains invalid lifecycle metadata.");
    }
    if (Boolean(row.recovery_required) !== (row.lifecycle_state === "recovery_required")) {
      throw new Error("Repository catalog recovery state is inconsistent.");
    }
    if (!Number.isInteger(row.workspace_count) || row.workspace_count < 0) {
      throw new Error("Repository catalog contains an invalid workspace count.");
    }
    let taskRegistry: RepositorySummary["taskRegistry"];
    if (row.task_registry_json) {
      try {
        const parsed = JSON.parse(row.task_registry_json) as RepositorySummary["taskRegistry"];
        if (parsed && typeof parsed.remote === "string" && typeof parsed.ref === "string") taskRegistry = parsed;
      } catch {
        throw new Error("Repository catalog contains invalid task registry metadata.");
      }
    }
    return {
      id: row.repository_id,
      checkoutId: row.checkout_id,
      name: row.name,
      path: row.canonical_path,
      configuration: row.configuration,
      workspaceCount: Number(row.workspace_count),
      openedAt: row.opened_at,
      ...(taskRegistry ? { taskRegistry } : {}),
      runtime: {
        state: row.lifecycle_state,
        recoveryRequired: Boolean(row.recovery_required),
        ...(row.last_error ? { lastError: row.last_error } : {}),
        updatedAt: row.updated_at,
      },
    };
  }
}

class RepositoryWorkerHandle {
  readonly child: UtilityProcess;
  readonly ready: Promise<void>;
  readonly generation = randomUUID();
  descriptor: RepositorySummary | null = null;
  expectedStop = false;
  private readonly pending = new Map<string, PendingRequest>();
  private settleReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;
  private readonly readyTimeout: NodeJS.Timeout;
  private stderrTail = "";

  constructor(
    workerEntry: string,
    repositoryPath: string,
    checkoutStorePath: string,
    private readonly eventSink: (event: WorkerEvent) => void,
    private readonly exitSink: (handle: RepositoryWorkerHandle, error: Error, expected: boolean) => void,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.settleReady = resolve;
      this.rejectReady = reject;
    });
    this.readyTimeout = setTimeout(() => this.failReady(new Error("Repository worker did not become ready.")), 12_000);
    this.child = utilityProcess.fork(workerEntry, [], {
      cwd: repositoryPath,
      env: workerEnvironment(repositoryPath, checkoutStorePath),
      stdio: "pipe",
      serviceName: `PhaseAtlas repository · ${path.basename(repositoryPath)}`,
    });
    this.child.on("message", (message: unknown) => this.onMessage(message));
    this.child.on("exit", (code) => this.onExit(code));
    this.child.stdout?.on("data", (chunk) => console.info(`[repository-worker] ${chunk}`));
    this.child.stderr?.on("data", (chunk) => {
      const diagnostic = String(chunk);
      this.stderrTail = `${this.stderrTail}${diagnostic}`.slice(-4_000);
      console.error(`[repository-worker] ${diagnostic}`);
    });
  }

  async call<T>(method: RepositoryWorkerMethod, params?: Record<string, unknown>): Promise<T> {
    await this.ready;
    const request: WorkerRequest = { requestId: randomUUID(), method, ...(params ? { params } : {}) };
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error(`Repository worker timed out while handling ${method}.`));
      }, 15_000);
      this.pending.set(request.requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.child.postMessage(request);
    });
  }

  stop(): void {
    if (this.expectedStop) return;
    this.expectedStop = true;
    this.child.kill();
  }

  private failReady(error: Error): void {
    if (this.readySettled) return;
    this.readySettled = true;
    clearTimeout(this.readyTimeout);
    this.rejectReady(error);
  }

  private onExit(code: number): void {
    const diagnostic = this.stderrTail.trim();
    const error = new Error(`Repository worker exited with code ${code}.${diagnostic ? ` ${diagnostic}` : ""}`);
    this.failReady(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.exitSink(this, error, this.expectedStop);
  }

  private onMessage(message: unknown): void {
    if (isWorkerEvent(message)) {
      if (message.type === "worker.ready" && !this.readySettled) {
        this.readySettled = true;
        clearTimeout(this.readyTimeout);
        this.settleReady();
      }
      if (message.type === "worker.warning") console.warn("Repository worker warning", message.payload);
      this.eventSink(message);
      return;
    }
    if (!isWorkerResponse(message)) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);
    const response = message as WorkerResponse;
    if ("error" in response) pending.reject(new Error(response.error.message));
    else pending.resolve(response.result);
  }
}

export class RepositoryProcessManager {
  private readonly catalog: RepositoryCatalog;
  private readonly workers = new Map<string, RepositoryWorkerHandle>();
  private readonly starts = new Map<string, Promise<RepositoryWorkerHandle>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly viewDemand = new Map<string, Set<number>>();
  private readonly runDemand = new Map<string, Set<string>>();
  private readonly chatDemand = new Map<string, Set<string>>();
  private readonly idleMs: number;
  private stopped = false;

  constructor(
    private readonly workerEntry: string,
    applicationSupportRoot: string,
    private readonly eventSink?: (event: PhaseAtlasDesktopEvent) => void,
    options: { idleMs?: number } = {},
  ) {
    this.catalog = new RepositoryCatalog(applicationSupportRoot);
    const configuredIdle = Number(process.env.PHASEATLAS_WORKER_IDLE_MS);
    this.idleMs = options.idleMs ?? (Number.isFinite(configuredIdle) && configuredIdle >= 0 ? configuredIdle : 30_000);
  }

  async open(repositoryPath: string, viewId?: number): Promise<RepositorySummary> {
    const canonicalPath = await realpath(repositoryPath);
    const checkoutId = checkoutIdForPath(canonicalPath);
    const existing = this.catalog.findByPath(canonicalPath);
    if (existing && existing.checkoutId !== checkoutId) throw new Error("Stored checkout identity does not match its canonical path.");
    if (viewId !== undefined) this.acquireView(checkoutId, viewId);
    const worker = await this.startWorker(canonicalPath, checkoutId, true, existing);
    this.catalog.setVisible(checkoutId, true);
    return this.catalog.get(checkoutId) as RepositorySummary;
  }

  // The IDE needs the canonical path and name of a registered checkout without
  // starting or touching its worker.
  describe(checkoutId: string): RepositorySummary {
    const entry = this.catalog.get(checkoutId);
    if (!entry) throw new Error("Repository is not in the local catalog.");
    return entry;
  }

  list(): RepositorySummary[] {
    return this.catalog.listVisible();
  }

  async refresh(checkoutId: string, viewId?: number): Promise<RepositorySummary> {
    if (viewId !== undefined) this.acquireView(checkoutId, viewId);
    const worker = await this.ensureWorker(checkoutId, true);
    const descriptor = await worker.call<RepositorySummary>("repository.refresh");
    this.validateDescriptor(descriptor, this.requireEntry(checkoutId));
    worker.descriptor = descriptor;
    return this.catalog.upsert(descriptor, "online", true);
  }

  async listWorkspaces(checkoutId: string): Promise<WorkspaceSummary[]> {
    return (await this.ensureWorker(checkoutId)).call<WorkspaceSummary[]>("workspace.list");
  }

  async taskSnapshot(checkoutId: string): Promise<TaskSnapshot> {
    return (await this.ensureWorker(checkoutId)).call<TaskSnapshot>("task.snapshot");
  }

  async coverageSnapshot(checkoutId: string, workspaceSlug: string): Promise<CoverageSnapshot> {
    return (await this.ensureWorker(checkoutId)).call<CoverageSnapshot>("coverage.snapshot", { workspaceSlug });
  }

  async appendCoverageEvent(checkoutId: string, input: CoverageEventAppendInput): Promise<CoverageEventAppendResult> {
    return (await this.ensureWorker(checkoutId)).call<CoverageEventAppendResult>("coverage.append", { input });
  }

  async taskRegistryWorkspace(checkoutId: string): Promise<TaskRegistryWorkspace> {
    return (await this.ensureWorker(checkoutId)).call<TaskRegistryWorkspace>("task-registry.workspace");
  }

  async taskRegistryStatus(checkoutId: string): Promise<TaskRegistrySource> {
    return (await this.ensureWorker(checkoutId)).call<TaskRegistrySource>("task-registry.status");
  }

  async validateTaskRegistry(checkoutId: string): Promise<TaskRegistryValidation> {
    return (await this.ensureWorker(checkoutId)).call<TaskRegistryValidation>("task-registry.validate");
  }

  async publishTaskRegistry(checkoutId: string, input: TaskRegistryPublishInput): Promise<TaskRegistryPublishResult> {
    return (await this.ensureWorker(checkoutId)).call<TaskRegistryPublishResult>("task-registry.publish", { input });
  }

  async discardTaskRegistry(checkoutId: string, expectedCommit: string): Promise<TaskRegistrySource> {
    return (await this.ensureWorker(checkoutId)).call<TaskRegistrySource>("task-registry.discard", { expectedCommit });
  }

  async startTaskContent(checkoutId: string, input: TaskContentStartInput): Promise<{ runId: string }> {
    return (await this.ensureWorker(checkoutId)).call<{ runId: string }>("task-content.start", { input });
  }

  async listTaskContentRuns(checkoutId: string): Promise<TaskContentRunSummary[]> {
    return (await this.ensureWorker(checkoutId)).call<TaskContentRunSummary[]>("task-content.list");
  }

  async cancelTaskContent(checkoutId: string, runId: string): Promise<void> {
    await (await this.ensureWorker(checkoutId)).call<void>("task-content.cancel", { runId });
  }

  async saveTaskContent(checkoutId: string, taskKey: string, body: string): Promise<TaskSnapshot> {
    return (await this.ensureWorker(checkoutId)).call<TaskSnapshot>("task-content.save", { taskKey, body });
  }

  async listFiles(checkoutId: string, directory = ""): Promise<RepositoryFileEntry[]> {
    return (await this.ensureWorker(checkoutId)).call<RepositoryFileEntry[]>("file.list", { directory });
  }

  async readFile(checkoutId: string, filePath: string): Promise<RepositoryFileDocument> {
    return (await this.ensureWorker(checkoutId)).call<RepositoryFileDocument>("file.read", { path: filePath });
  }

  async saveFile(checkoutId: string, filePath: string, content: string): Promise<void> {
    await (await this.ensureWorker(checkoutId)).call<void>("file.save", { path: filePath, content });
  }

  async leaseForRun(checkoutId: string, runId: string): Promise<WorktreeLeaseRecord | null> {
    return (await this.ensureWorker(checkoutId)).call<WorktreeLeaseRecord | null>("agent-run.lease", { runId });
  }

  async listRunners(checkoutId: string): Promise<RunnerDescriptor[]> {
    return (await this.ensureWorker(checkoutId)).call<RunnerDescriptor[]>("runner.list");
  }

  async startPlanning(checkoutId: string, input: PlanningStartInput): Promise<{ runId: string }> {
    return (await this.ensureWorker(checkoutId)).call<{ runId: string }>("planning.start", { input });
  }

  async cancelPlanning(checkoutId: string, runId: string): Promise<void> {
    await (await this.ensureWorker(checkoutId)).call<void>("planning.cancel", { runId });
  }

  async publishProposals(checkoutId: string, input: PlanningPublishInput): Promise<TaskSnapshot> {
    return (await this.ensureWorker(checkoutId)).call<TaskSnapshot>("proposal.publish", { input });
  }

  async listRuns(checkoutId: string): Promise<PersistedRunRecord[]> {
    return (await this.ensureWorker(checkoutId)).call<PersistedRunRecord[]>("run.list");
  }

  async listRunEvents(checkoutId: string, runId: string, afterSequence = 0): Promise<PersistedRunEvent[]> {
    return (await this.ensureWorker(checkoutId)).call<PersistedRunEvent[]>("run.events", { runId, afterSequence });
  }

  async listRunEventPage(checkoutId: string, runId: string, afterSequence = 0, limit = 200): Promise<PersistedRunEventPage> {
    return (await this.ensureWorker(checkoutId)).call<PersistedRunEventPage>("run.events-page", { runId, afterSequence, limit });
  }

  async agentRunCommandOutput(
    checkoutId: string,
    runId: string,
    commandId: string,
    offset = 0,
    limit = 20_000,
  ): Promise<AgentRunCommandOutputPage> {
    return (await this.ensureWorker(checkoutId)).call<AgentRunCommandOutputPage>("agent-run.command-output", {
      runId,
      commandId,
      offset,
      limit,
    });
  }

  async agentRunActions(checkoutId: string, input: AgentRunActionQuery): Promise<AgentRunActionAvailability[]> {
    return (await this.ensureWorker(checkoutId)).call<AgentRunActionAvailability[]>("agent-run.actions", { input });
  }

  async listAgentRuns(checkoutId: string, taskKey?: string): Promise<AgentRunSummary[]> {
    return (await this.ensureWorker(checkoutId)).call<AgentRunSummary[]>("agent-run.list", {
      ...(taskKey ? { taskKey } : {}),
    });
  }

  async startAgentRun(checkoutId: string, input: AgentRunStartInput): Promise<{ runId: string }> {
    const started = await (await this.ensureWorker(checkoutId)).call<{ runId: string }>("agent-run.start", { input });
    this.trackRun(checkoutId, started.runId, "running");
    return started;
  }

  async cancelAgentRun(checkoutId: string, runId: string): Promise<AgentRunCancellationResult> {
    const result = await (await this.ensureWorker(checkoutId)).call<AgentRunCancellationResult>("agent-run.cancel", { runId });
    this.trackRun(checkoutId, runId, result.status);
    return result;
  }

  async agentRunResult(checkoutId: string, runId: string): Promise<AgentResultReview> {
    return (await this.ensureWorker(checkoutId)).call<AgentResultReview>("agent-run.result", { runId });
  }

  async recoverAgentRun(checkoutId: string, input: AgentRunRecoveryInput): Promise<AgentRunRecoveryResult> {
    const result = await (await this.ensureWorker(checkoutId)).call<AgentRunRecoveryResult>("agent-run.recover", { input });
    if (result.retryRunId) this.trackRun(checkoutId, result.retryRunId, "running");
    return result;
  }

  async createChatSession(checkoutId: string, input: RepositoryChatCreateInput): Promise<RepositoryChatSession> {
    return (await this.ensureWorker(checkoutId)).call<RepositoryChatSession>("chat.session.create", { input });
  }

  async listChatSessions(checkoutId: string): Promise<RepositoryChatSession[]> {
    return (await this.ensureWorker(checkoutId)).call<RepositoryChatSession[]>("chat.session.list");
  }

  async getChatSession(checkoutId: string, sessionId: string): Promise<RepositoryChatSession> {
    return (await this.ensureWorker(checkoutId)).call<RepositoryChatSession>("chat.session.get", { sessionId });
  }

  async renameChatSession(checkoutId: string, input: RepositoryChatRenameInput): Promise<RepositoryChatSession> {
    return (await this.ensureWorker(checkoutId)).call<RepositoryChatSession>("chat.session.rename", { input });
  }

  async setChatSessionProvider(checkoutId: string, input: RepositoryChatProviderInput): Promise<RepositoryChatSession> {
    return (await this.ensureWorker(checkoutId)).call<RepositoryChatSession>("chat.session.provider", { input });
  }

  async closeChatSession(checkoutId: string, sessionId: string): Promise<RepositoryChatSession> {
    return (await this.ensureWorker(checkoutId)).call<RepositoryChatSession>("chat.session.close", { sessionId });
  }

  async listChatMessages(checkoutId: string, sessionId: string): Promise<RepositoryChatMessage[]> {
    return (await this.ensureWorker(checkoutId)).call<RepositoryChatMessage[]>("chat.message.list", { sessionId });
  }

  async listChatTurns(checkoutId: string, sessionId: string): Promise<RepositoryChatTurn[]> {
    return (await this.ensureWorker(checkoutId)).call<RepositoryChatTurn[]>("chat.turn.list", { sessionId });
  }

  async sendChatTurn(checkoutId: string, input: RepositoryChatSendInput): Promise<{ turnId: string }> {
    const result = await (await this.ensureWorker(checkoutId)).call<{ turnId: string }>("chat.turn.send", { input });
    this.trackChatTurn(checkoutId, result.turnId, "running");
    return result;
  }

  async listChatEvents(checkoutId: string, turnId: string, afterSequence = 0, limit = 200): Promise<RepositoryChatEventPage> {
    return (await this.ensureWorker(checkoutId)).call<RepositoryChatEventPage>("chat.turn.events", { turnId, afterSequence, limit });
  }

  async cancelChatTurn(checkoutId: string, turnId: string): Promise<RepositoryChatCancellationResult> {
    const result = await (await this.ensureWorker(checkoutId)).call<RepositoryChatCancellationResult>("chat.turn.cancel", { turnId });
    this.trackChatTurn(checkoutId, turnId, result.status);
    return result;
  }

  async retryChatTurn(checkoutId: string, input: RepositoryChatRetryInput): Promise<{ turnId: string }> {
    const result = await (await this.ensureWorker(checkoutId)).call<{ turnId: string }>("chat.turn.retry", { input });
    this.trackChatTurn(checkoutId, result.turnId, "running");
    return result;
  }

  async prepareChatEdit(checkoutId: string, input: ChatEditPrepareInput): Promise<ChatEditConfirmation> {
    return (await this.ensureWorker(checkoutId)).call<ChatEditConfirmation>("chat.edit.prepare", { input });
  }

  async listChatEdits(checkoutId: string, sessionId?: string): Promise<ChatEditResult[]> {
    return (await this.ensureWorker(checkoutId)).call<ChatEditResult[]>("chat.edit.list", { ...(sessionId ? { sessionId } : {}) });
  }

  async startChatEdit(checkoutId: string, input: ChatEditStartInput): Promise<{ editId: string }> {
    const result = await (await this.ensureWorker(checkoutId)).call<{ editId: string }>("chat.edit.start", { input });
    this.trackRun(checkoutId, result.editId, "running");
    return result;
  }

  async listChatEditEvents(checkoutId: string, editId: string, afterSequence = 0, limit = 200): Promise<PersistedRunEventPage> {
    return (await this.ensureWorker(checkoutId)).call<PersistedRunEventPage>("chat.edit.events", { editId, afterSequence, limit });
  }

  async chatEditResult(checkoutId: string, editId: string): Promise<ChatEditResult> {
    return (await this.ensureWorker(checkoutId)).call<ChatEditResult>("chat.edit.result", { editId });
  }

  async cancelChatEdit(checkoutId: string, editId: string): Promise<ChatEditCancellationResult> {
    const result = await (await this.ensureWorker(checkoutId)).call<ChatEditCancellationResult>("chat.edit.cancel", { editId });
    this.trackRun(checkoutId, editId, "cancelled");
    return result;
  }

  async acceptChatEdit(checkoutId: string, editId: string): Promise<ChatEditResult> {
    return (await this.ensureWorker(checkoutId)).call<ChatEditResult>("chat.edit.accept", { editId });
  }

  async discardChatEdit(checkoutId: string, editId: string): Promise<ChatEditResult> {
    return (await this.ensureWorker(checkoutId)).call<ChatEditResult>("chat.edit.discard", { editId });
  }

  async retainChatEdit(checkoutId: string, editId: string): Promise<ChatEditResult> {
    return (await this.ensureWorker(checkoutId)).call<ChatEditResult>("chat.edit.retain", { editId });
  }

  async recoverChatEdit(checkoutId: string, input: ChatEditRecoveryInput): Promise<ChatEditResult> {
    return (await this.ensureWorker(checkoutId)).call<ChatEditResult>("chat.edit.recover", { input });
  }

  close(checkoutId: string, viewId?: number): void {
    this.catalog.setVisible(checkoutId, false);
    if (viewId !== undefined) this.releaseView(checkoutId, viewId);
    else this.viewDemand.delete(checkoutId);
    this.scheduleIdle(checkoutId);
  }

  releaseViewsForWebContents(viewId: number): void {
    for (const checkoutId of this.viewDemand.keys()) this.releaseView(checkoutId, viewId);
  }

  stopAll(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const [checkoutId, worker] of this.workers) {
      this.catalog.setRuntime(checkoutId, "closed");
      worker.stop();
    }
    this.workers.clear();
    this.starts.clear();
    this.catalog.close();
  }

  private acquireView(checkoutId: string, viewId: number): void {
    for (const [otherCheckoutId, views] of this.viewDemand) {
      if (otherCheckoutId !== checkoutId && views.delete(viewId)) this.scheduleIdle(otherCheckoutId);
    }
    const views = this.viewDemand.get(checkoutId) ?? new Set<number>();
    views.add(viewId);
    this.viewDemand.set(checkoutId, views);
    this.cancelIdle(checkoutId);
  }

  private releaseView(checkoutId: string, viewId: number): void {
    const views = this.viewDemand.get(checkoutId);
    views?.delete(viewId);
    if (views && !views.size) this.viewDemand.delete(checkoutId);
    this.scheduleIdle(checkoutId);
  }

  private ensureWorker(checkoutId: string, allowRecovery = false): Promise<RepositoryWorkerHandle> {
    const existing = this.workers.get(checkoutId);
    if (existing) {
      this.cancelIdle(checkoutId);
      return Promise.resolve(existing);
    }
    const entry = this.requireEntry(checkoutId);
    if (entry.runtime?.recoveryRequired && !allowRecovery) {
      throw new Error("Repository worker recovery is required. Refresh or reopen the repository.");
    }
    return this.startWorker(entry.path, checkoutId, allowRecovery, entry);
  }

  private startWorker(
    canonicalPath: string,
    checkoutId: string,
    allowRecovery: boolean,
    expected?: RepositorySummary | null,
  ): Promise<RepositoryWorkerHandle> {
    const live = this.workers.get(checkoutId);
    if (live) return Promise.resolve(live);
    const pending = this.starts.get(checkoutId);
    if (pending) return pending;
    if (expected?.runtime?.recoveryRequired && !allowRecovery) {
      throw new Error("Repository worker recovery is required.");
    }
    this.catalog.setRuntime(checkoutId, "starting");
    const checkoutStorePath = path.join(this.catalog.applicationSupportRoot, "checkouts", checkoutId, "operations.sqlite");
    let worker: RepositoryWorkerHandle;
    const start = (async () => {
      worker = new RepositoryWorkerHandle(
        this.workerEntry,
        canonicalPath,
        checkoutStorePath,
        (event) => this.onWorkerEvent(checkoutId, worker, event),
        (handle, error, expectedExit) => this.onWorkerExit(checkoutId, handle, error, expectedExit),
      );
      try {
        const descriptor = await worker.call<RepositorySummary>("repository.describe");
        if (descriptor.checkoutId !== checkoutId) throw new Error("Worker checkout identity does not match its catalog entry.");
        if (expected) this.validateDescriptor(descriptor, expected);
        worker.descriptor = descriptor;
        this.workers.set(checkoutId, worker);
        this.catalog.upsert(descriptor, "online", expected ? (expected as CatalogEntry).visible ?? true : true);
        this.scheduleIdle(checkoutId);
        return worker;
      } catch (error) {
        worker.stop();
        this.catalog.setRuntime(checkoutId, "recovery_required", error instanceof Error ? error.message : "Worker startup failed.");
        throw error;
      } finally {
        this.starts.delete(checkoutId);
      }
    })();
    this.starts.set(checkoutId, start);
    return start;
  }

  private onWorkerEvent(checkoutId: string, worker: RepositoryWorkerHandle, event: WorkerEvent): void {
    if (worker.expectedStop) return;
    const currentWorker = this.workers.get(checkoutId);
    if (currentWorker && currentWorker !== worker) return;
    if (event.type === "planning.event" && event.payload.event) {
      const planningEvent = event.payload.event as PlanningEvent;
      this.trackRun(checkoutId, planningEvent.runId, planningEvent.type === "planning.status" ? planningEvent.status : undefined);
      this.eventSink?.({ type: "planning.event", checkoutId, event: planningEvent });
    } else if (event.type === "task-content.event" && event.payload.event) {
      const contentEvent = event.payload.event as TaskContentEvent;
      this.trackRun(checkoutId, contentEvent.runId, contentEvent.type === "task-content.status" ? contentEvent.status : undefined);
      this.eventSink?.({ type: "task-content.event", checkoutId, event: contentEvent });
    } else if (event.type === "agent-run.event" && typeof event.payload.runId === "string" && event.payload.event) {
      const persistedEvent = event.payload.event as PersistedRunEvent;
      const status = persistedEvent.type === "run.status" && typeof persistedEvent.payload.status === "string"
        ? persistedEvent.payload.status
        : persistedEvent.type === "agent.result" && typeof persistedEvent.payload.status === "string"
          ? persistedEvent.payload.status
          : persistedEvent.type === "run.failed"
            ? "failed"
            : persistedEvent.type === "run.cancelled"
              ? "cancelled"
              : persistedEvent.type === "run.interrupted"
                ? "interrupted"
                : undefined;
      this.trackRun(checkoutId, event.payload.runId, status);
      this.eventSink?.({ type: "agent-run.event", checkoutId, runId: event.payload.runId, event: persistedEvent });
    } else if (event.type === "chat.turn.event" && typeof event.payload.turnId === "string" && event.payload.event) {
      const chatEvent = event.payload.event as PersistedRepositoryChatEvent;
      const status = chatEvent.type === "chat.turn.completed" ? "completed"
        : chatEvent.type === "chat.turn.failed" ? "failed"
          : chatEvent.type === "chat.turn.cancelled" ? "cancelled"
            : chatEvent.type === "chat.turn.interrupted" ? "interrupted"
              : chatEvent.type === "chat.turn.status" && typeof chatEvent.payload.status === "string"
                ? chatEvent.payload.status
                : undefined;
      this.trackChatTurn(checkoutId, event.payload.turnId, status);
      this.eventSink?.({ type: "chat.turn.event", checkoutId, turnId: event.payload.turnId, event: chatEvent });
    } else if (event.type === "chat.edit.event" && typeof event.payload.editId === "string" && event.payload.event) {
      const editEvent = event.payload.event as PersistedRunEvent;
      const status = editEvent.type === "chat.edit.result" ? "completed"
        : editEvent.type === "chat.edit.failed" ? "failed"
          : editEvent.type === "chat.edit.running" ? "running" : undefined;
      this.trackRun(checkoutId, event.payload.editId, status);
      this.eventSink?.({ type: "chat.edit.event", checkoutId, editId: event.payload.editId, event: editEvent });
    } else if (event.type === "repository.changed") {
      const paths = Array.isArray(event.payload.paths)
        ? event.payload.paths.filter((item): item is string => typeof item === "string")
        : [];
      this.eventSink?.({ type: "repository.changed", checkoutId, paths });
    }
  }

  private trackRun(checkoutId: string, runId: string, status?: string): void {
    const runs = this.runDemand.get(checkoutId) ?? new Set<string>();
    if (status && ACTIVE_STATES.has(status)) runs.add(runId);
    if (status && TERMINAL_STATES.has(status)) runs.delete(runId);
    if (runs.size) {
      this.runDemand.set(checkoutId, runs);
      this.cancelIdle(checkoutId);
    } else {
      this.runDemand.delete(checkoutId);
      this.scheduleIdle(checkoutId);
    }
  }

  private trackChatTurn(checkoutId: string, turnId: string, status?: string): void {
    const turns = this.chatDemand.get(checkoutId) ?? new Set<string>();
    if (status && ACTIVE_STATES.has(status)) turns.add(turnId);
    if (status && TERMINAL_STATES.has(status)) turns.delete(turnId);
    if (turns.size) {
      this.chatDemand.set(checkoutId, turns);
      this.cancelIdle(checkoutId);
    } else {
      this.chatDemand.delete(checkoutId);
      this.scheduleIdle(checkoutId);
    }
  }

  private onWorkerExit(checkoutId: string, worker: RepositoryWorkerHandle, error: Error, expected: boolean): void {
    if (this.workers.get(checkoutId) !== worker) return;
    this.workers.delete(checkoutId);
    this.runDemand.delete(checkoutId);
    this.chatDemand.delete(checkoutId);
    if (this.stopped) return;
    if (expected) this.catalog.setRuntime(checkoutId, "closed");
    else this.catalog.setRuntime(checkoutId, "recovery_required", error.message);
  }

  private scheduleIdle(checkoutId: string): void {
    const worker = this.workers.get(checkoutId);
    if (!worker || this.viewDemand.get(checkoutId)?.size || this.runDemand.get(checkoutId)?.size || this.chatDemand.get(checkoutId)?.size) return;
    this.cancelIdle(checkoutId);
    this.catalog.setRuntime(checkoutId, "cooling");
    const timer = setTimeout(() => {
      this.idleTimers.delete(checkoutId);
      if (this.viewDemand.get(checkoutId)?.size || this.runDemand.get(checkoutId)?.size || this.chatDemand.get(checkoutId)?.size) return;
      if (this.workers.get(checkoutId) !== worker) return;
      this.workers.delete(checkoutId);
      this.catalog.setRuntime(checkoutId, "closed");
      worker.stop();
    }, this.idleMs);
    this.idleTimers.set(checkoutId, timer);
  }

  private cancelIdle(checkoutId: string): void {
    const timer = this.idleTimers.get(checkoutId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(checkoutId);
    if (this.workers.has(checkoutId)) this.catalog.setRuntime(checkoutId, "online");
  }

  private validateDescriptor(descriptor: RepositorySummary, expected: RepositorySummary): void {
    const sameCheckout = descriptor.checkoutId === expected.checkoutId && descriptor.path === expected.path;
    if (!sameCheckout || (descriptor.id !== expected.id && !isLegacyManifestUpgrade(descriptor, expected))) {
      throw new Error("Repository descriptor does not match the persisted catalog identity.");
    }
  }

  private requireEntry(checkoutId: string): CatalogEntry {
    const entry = this.catalog.get(checkoutId);
    if (!entry) throw new Error("Repository is not in the local catalog.");
    return entry;
  }
}
