import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import {
  isWorkerEvent,
  isWorkerResponse,
  type PlanningEvent,
  type PlanningPublishInput,
  type PlanningStartInput,
  type PhaseAtlasDesktopEvent,
  type RepositorySummary,
  type RepositoryWorkerMethod,
  type RunnerDescriptor,
  type RepositoryFileDocument,
  type RepositoryFileEntry,
  type TaskContentEvent,
  type TaskContentRunSummary,
  type TaskContentStartInput,
  type TaskSnapshot,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerEvent,
  type WorkspaceSummary,
} from "@phaseatlas/contracts";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

function workerEnvironment(repositoryPath: string): Record<string, string> {
  const allowedKeys = [
    "PATH",
    "HOME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "CODEX_HOME",
    "PHASEATLAS_CODEX_BIN",
    "PHASEATLAS_CLAUDE_BIN",
  ];
  const environment: Record<string, string> = {
    PHASEATLAS_REPO_ROOT: repositoryPath,
  };

  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

class RepositoryWorkerHandle {
  readonly child: UtilityProcess;
  readonly ready: Promise<void>;
  descriptor: RepositorySummary | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private markReady!: () => void;

  constructor(
    workerEntry: string,
    repositoryPath: string,
    private readonly eventSink?: (event: WorkerEvent) => void,
  ) {
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });

    this.child = utilityProcess.fork(workerEntry, [], {
      cwd: repositoryPath,
      env: workerEnvironment(repositoryPath),
      stdio: "pipe",
      serviceName: `PhaseAtlas repository · ${path.basename(repositoryPath)}`,
    });

    this.child.on("message", (message: unknown) => this.onMessage(message));
    this.child.on("exit", (code) => {
      const error = new Error(`Repository worker exited with code ${code}.`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
    });
    this.child.stdout?.on("data", (chunk) => console.info(`[repository-worker] ${chunk}`));
    this.child.stderr?.on("data", (chunk) => console.error(`[repository-worker] ${chunk}`));
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
    this.child.kill();
  }

  private onMessage(message: unknown): void {
    if (isWorkerEvent(message)) {
      if (message.type === "worker.ready") this.markReady();
      if (message.type === "worker.warning") {
        console.warn("Repository worker warning", message.payload);
      }
      this.eventSink?.(message);
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
  private readonly workers = new Map<string, RepositoryWorkerHandle>();
  private readonly checkoutByPath = new Map<string, string>();

  constructor(
    private readonly workerEntry: string,
    private readonly eventSink?: (event: PhaseAtlasDesktopEvent) => void,
  ) {}

  async open(repositoryPath: string): Promise<RepositorySummary> {
    const canonicalPath = await realpath(repositoryPath);
    const existingCheckoutId = this.checkoutByPath.get(canonicalPath);
    if (existingCheckoutId) {
      const existing = this.workers.get(existingCheckoutId);
      if (existing?.descriptor) return existing.descriptor;
    }

    let worker: RepositoryWorkerHandle;
    worker = new RepositoryWorkerHandle(this.workerEntry, canonicalPath, (event) => {
      if (!worker.descriptor) return;
      if (event.type === "repository.changed") {
        const paths = Array.isArray(event.payload.paths)
          ? event.payload.paths.filter((item): item is string => typeof item === "string")
          : [];
        this.eventSink?.({ type: "repository.changed", checkoutId: worker.descriptor.checkoutId, paths });
      }
      if (event.type === "planning.event" && event.payload.event) {
        this.eventSink?.({
          type: "planning.event",
          checkoutId: worker.descriptor.checkoutId,
          event: event.payload.event as PlanningEvent,
        });
      }
      if (event.type === "task-content.event" && event.payload.event) {
        this.eventSink?.({
          type: "task-content.event",
          checkoutId: worker.descriptor.checkoutId,
          event: event.payload.event as TaskContentEvent,
        });
      }
    });
    try {
      const descriptor = await worker.call<RepositorySummary>("repository.describe");
      worker.descriptor = descriptor;
      this.workers.set(descriptor.checkoutId, worker);
      this.checkoutByPath.set(canonicalPath, descriptor.checkoutId);
      return descriptor;
    } catch (error) {
      worker.stop();
      throw error;
    }
  }

  list(): RepositorySummary[] {
    return [...this.workers.values()]
      .map((worker) => worker.descriptor)
      .filter((repository): repository is RepositorySummary => Boolean(repository));
  }

  async listWorkspaces(checkoutId: string): Promise<WorkspaceSummary[]> {
    const worker = this.workers.get(checkoutId);
    if (!worker) throw new Error("Repository is not open.");
    return worker.call<WorkspaceSummary[]>("workspace.list");
  }

  async refresh(checkoutId: string): Promise<RepositorySummary> {
    const worker = this.workers.get(checkoutId);
    if (!worker) throw new Error("Repository is not open.");
    const descriptor = await worker.call<RepositorySummary>("repository.refresh");
    worker.descriptor = descriptor;
    return descriptor;
  }

  async taskSnapshot(checkoutId: string): Promise<TaskSnapshot> {
    const worker = this.workers.get(checkoutId);
    if (!worker) throw new Error("Repository is not open.");
    return worker.call<TaskSnapshot>("task.snapshot");
  }

  async startTaskContent(checkoutId: string, input: TaskContentStartInput): Promise<{ runId: string }> {
    const worker = this.workers.get(checkoutId);
    if (!worker) throw new Error("Repository is not open.");
    return worker.call<{ runId: string }>("task-content.start", { input });
  }

  async listTaskContentRuns(checkoutId: string): Promise<TaskContentRunSummary[]> {
    const worker = this.workers.get(checkoutId);
    if (!worker) throw new Error("Repository is not open.");
    return worker.call<TaskContentRunSummary[]>("task-content.list");
  }

  async cancelTaskContent(checkoutId: string, runId: string): Promise<void> {
    const worker = this.workers.get(checkoutId);
    if (!worker) throw new Error("Repository is not open.");
    await worker.call<void>("task-content.cancel", { runId });
  }

  async saveTaskContent(checkoutId: string, taskKey: string, body: string): Promise<TaskSnapshot> {
    const worker = this.workers.get(checkoutId);
    if (!worker) throw new Error("Repository is not open.");
    return worker.call<TaskSnapshot>("task-content.save", { taskKey, body });
  }

  async listFiles(checkoutId: string, directory = ""): Promise<RepositoryFileEntry[]> {
    const worker = this.workers.get(checkoutId);
    if (!worker) throw new Error("Repository is not open.");
    return worker.call<RepositoryFileEntry[]>("file.list", { directory });
  }

  async readFile(checkoutId: string, filePath: string): Promise<RepositoryFileDocument> {
    const worker = this.workers.get(checkoutId);
    if (!worker) throw new Error("Repository is not open.");
    return worker.call<RepositoryFileDocument>("file.read", { path: filePath });
  }

  async saveFile(checkoutId: string, filePath: string, content: string): Promise<void> {
    const worker = this.workers.get(checkoutId);
    if (!worker) throw new Error("Repository is not open.");
    await worker.call<void>("file.save", { path: filePath, content });
  }

  async listRunners(checkoutId: string): Promise<RunnerDescriptor[]> {
    const worker = this.workers.get(checkoutId);
    if (!worker) throw new Error("Repository is not open.");
    return worker.call<RunnerDescriptor[]>("runner.list");
  }

  async startPlanning(checkoutId: string, input: PlanningStartInput): Promise<{ runId: string }> {
    const worker = this.workers.get(checkoutId);
    if (!worker) throw new Error("Repository is not open.");
    return worker.call<{ runId: string }>("planning.start", { input });
  }

  async cancelPlanning(checkoutId: string, runId: string): Promise<void> {
    const worker = this.workers.get(checkoutId);
    if (!worker) throw new Error("Repository is not open.");
    await worker.call<void>("planning.cancel", { runId });
  }

  async publishProposals(
    checkoutId: string,
    input: PlanningPublishInput,
  ): Promise<TaskSnapshot> {
    const worker = this.workers.get(checkoutId);
    if (!worker) throw new Error("Repository is not open.");
    return worker.call<TaskSnapshot>("proposal.publish", { input });
  }

  close(checkoutId: string): void {
    const worker = this.workers.get(checkoutId);
    if (!worker) return;
    worker.stop();
    this.workers.delete(checkoutId);
    if (worker.descriptor) this.checkoutByPath.delete(worker.descriptor.path);
  }

  stopAll(): void {
    for (const worker of this.workers.values()) worker.stop();
    this.workers.clear();
    this.checkoutByPath.clear();
  }
}
