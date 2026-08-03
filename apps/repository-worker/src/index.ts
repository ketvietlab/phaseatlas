import process from "node:process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  PlanningEvent,
  PlanningPublishInput,
  PlanningStartInput,
  PlanningTarget,
  TaskContentEvent,
  TaskContentRunStatus,
  TaskContentRunSummary,
  TaskContentStartInput,
  TaskProposalOutline,
  WorkerEvent,
  WorkerRequest,
  WorkerResponse,
} from "@phaseatlas/contracts";
import {
  RepositoryInspector,
  listRepositoryFiles,
  readRepositoryFile,
  saveRepositoryFile,
  writeTaskContent,
} from "@phaseatlas/core";
import { watch, type FSWatcher } from "chokidar";
import { RunnerRegistry } from "./runner-registry.js";

interface ElectronParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: WorkerEvent | WorkerResponse): void;
}

const utilityParentPort = (process as typeof process & { parentPort?: ElectronParentPort }).parentPort;
const repositoryRoot = process.env.PHASEATLAS_REPO_ROOT;

if (!utilityParentPort) {
  throw new Error("Repository worker must be launched as an Electron utility process.");
}
if (!repositoryRoot) {
  throw new Error("PHASEATLAS_REPO_ROOT is required.");
}
const canonicalRepositoryRoot = repositoryRoot;

const inspector = await RepositoryInspector.open(canonicalRepositoryRoot);
const runners = new RunnerRegistry();
const parentPort: ElectronParentPort = utilityParentPort;
const activePlanningRuns = new Map<string, AbortController>();
const activeTaskContentRuns = new Map<string, {
  controller: AbortController;
  status: TaskContentRunStatus;
  taskKeys: string[];
}>();

async function mapConcurrent<Input, Output>(
  items: Input[],
  concurrency: number,
  mapper: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as Input, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function send(message: WorkerEvent | WorkerResponse): void {
  parentPort.postMessage(message);
}

function requestParams(request: WorkerRequest): Record<string, unknown> {
  return request.params ?? {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function planningInput(value: unknown): PlanningStartInput {
  if (!value || typeof value !== "object") throw new Error("Planning input is required.");
  const input = value as Record<string, unknown>;
  for (const field of ["runnerId", "request"] as const) {
    if (typeof input[field] !== "string" || !input[field].trim()) {
      throw new Error(`${field} must be a non-empty string.`);
    }
  }
  if (input.model !== undefined && typeof input.model !== "string") {
    throw new Error("model must be a string.");
  }
  if (!input.target || typeof input.target !== "object") throw new Error("target is required.");
  const targetValue = input.target as Record<string, unknown>;
  let target: PlanningTarget;
  if (targetValue.type === "repository") {
    target = { type: "repository" };
  } else if (
    targetValue.type === "workspace" &&
    typeof targetValue.workspaceSlug === "string" &&
    targetValue.workspaceSlug.trim()
  ) {
    target = { type: "workspace", workspaceSlug: targetValue.workspaceSlug.trim() };
  } else {
    throw new Error("target must identify a repository or an existing workspace.");
  }
  return {
    target,
    runnerId: (input.runnerId as string).trim(),
    request: (input.request as string).trim(),
    ...(typeof input.model === "string" && input.model.trim() ? { model: input.model.trim() } : {}),
  };
}

function emitPlanningEvent(event: PlanningEvent): void {
  send({ type: "planning.event", payload: { event } });
}

function emitTaskContentEvent(event: TaskContentEvent): void {
  send({ type: "task-content.event", payload: { event } });
}

function startPlanning(input: PlanningStartInput): { runId: string } {
  const runId = randomUUID();
  const controller = new AbortController();
  activePlanningRuns.set(runId, controller);
  let sequence = 0;
  let deltaBuffer = "";
  let deltaTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let runStartedAt = 0;
  let lastProviderActivityAt = 0;
  let heartbeatStage = "Preparing planning run";
  const timestamp = () => new Date().toISOString();
  const status = (value: "starting" | "running" | "completed" | "failed" | "cancelled") => {
    emitPlanningEvent({
      type: "planning.status",
      runId,
      sequence: ++sequence,
      status: value,
      runnerId: input.runnerId,
      timestamp: timestamp(),
    });
  };
  const flushDelta = () => {
    if (!deltaBuffer) return;
    emitPlanningEvent({
      type: "planning.delta",
      runId,
      sequence: ++sequence,
      text: deltaBuffer,
      timestamp: timestamp(),
    });
    deltaBuffer = "";
    if (deltaTimer) clearTimeout(deltaTimer);
    deltaTimer = null;
  };
  const queueDelta = (text: string) => {
    if (!text) return;
    deltaBuffer += text;
    if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 40);
  };
  const queueProviderDelta = (text: string) => {
    lastProviderActivityAt = Date.now();
    queueDelta(text);
  };

  setTimeout(() => {
    void (async () => {
      try {
        status("starting");
        runStartedAt = Date.now();
        lastProviderActivityAt = runStartedAt;
        queueDelta("PhaseAtlas · Preparing repository context\n");
        heartbeatTimer = setInterval(() => {
          const now = Date.now();
          const elapsedSeconds = Math.floor((now - runStartedAt) / 1_000);
          const quietSeconds = Math.floor((now - lastProviderActivityAt) / 1_000);
          queueDelta(`PhaseAtlas · ${heartbeatStage} · ${elapsedSeconds}s elapsed · provider quiet for ${quietSeconds}s\n`);
        }, 5_000);

        const [repository, workspaces, snapshot] = await Promise.all([
          inspector.describe(),
          inspector.listWorkspaces(),
          inspector.taskSnapshot(),
        ]);
        queueDelta(`PhaseAtlas · Repository context ready · ${workspaces.length} workspaces · ${snapshot.tasks.length} tasks\n`);
        if (input.target.type === "workspace") {
          const workspaceSlug = input.target.workspaceSlug;
          if (!workspaces.some((workspace) => workspace.slug === workspaceSlug)) {
            throw new Error(`Workspace ${workspaceSlug} does not exist.`);
          }
        }
        const runner = runners.get(input.runnerId);
        heartbeatStage = `Checking ${input.runnerId}`;
        queueDelta(`PhaseAtlas · Checking runner · ${input.runnerId}\n`);
        const descriptor = await runner.describe();
        if (!descriptor.available) throw new Error(descriptor.unavailableReason || `${descriptor.name} is unavailable.`);

        status("running");
        heartbeatStage = `${descriptor.name} active`;
        queueDelta(`PhaseAtlas · Agent process started · ${descriptor.name}${descriptor.version ? ` · ${descriptor.version}` : ""}\n`);
        const planningContext = {
          repositoryRoot: canonicalRepositoryRoot,
          repositoryName: repository.name,
          input,
          canonicalTasks: snapshot.tasks,
          workspaces,
        };
        const proposals = await runner.run(
          planningContext,
          controller.signal,
          queueProviderDelta,
        );
        heartbeatStage = "Validating task outlines";
        queueDelta("PhaseAtlas · Task outlines ready · content initialization remains optional after publish\n");
        flushDelta();
        emitPlanningEvent({
          type: "planning.completed",
          runId,
          sequence: ++sequence,
          proposals,
          timestamp: timestamp(),
        });
        status("completed");
      } catch (error) {
        flushDelta();
        if (controller.signal.aborted) {
          status("cancelled");
        } else {
          emitPlanningEvent({
            type: "planning.failed",
            runId,
            sequence: ++sequence,
            message: error instanceof Error ? error.message : "Unknown planning failure.",
            timestamp: timestamp(),
          });
          status("failed");
        }
      } finally {
        if (deltaTimer) clearTimeout(deltaTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        activePlanningRuns.delete(runId);
      }
    })();
  }, 0);

  return { runId };
}

function taskContentInput(value: unknown): TaskContentStartInput {
  if (!isRecord(value)) throw new Error("Task content input is required.");
  if (!Array.isArray(value.taskKeys) || !value.taskKeys.length || value.taskKeys.some(
    (taskKey) => typeof taskKey !== "string" || !taskKey.trim(),
  )) throw new Error("taskKeys must contain at least one canonical task key.");
  if (typeof value.runnerId !== "string" || !value.runnerId.trim()) {
    throw new Error("runnerId must be a non-empty string.");
  }
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("model must be a string.");
  return {
    taskKeys: [...new Set((value.taskKeys as string[]).map((taskKey) => taskKey.trim()))],
    runnerId: value.runnerId.trim(),
    ...(typeof value.model === "string" && value.model.trim() ? { model: value.model.trim() } : {}),
  };
}

function contentOutline(task: Awaited<ReturnType<typeof inspector.taskSnapshot>>["tasks"][number]): TaskProposalOutline {
  return {
    temporaryId: `${task.key.workspaceSlug}/${task.key.taskId}`,
    title: task.title,
    objective: task.objective,
    kind: task.kind,
    workspaceSlug: task.key.workspaceSlug,
    phaseId: task.phaseId,
    priority: task.priority,
    suggestedDependencies: task.dependencies.map((dependency) => dependency.taskKey),
    suggestedPaths: task.scope.allowedPaths,
    acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({
      statement: criterion.statement,
      verificationSuggestion: criterion.verification.type === "command"
        ? `Run command ${criterion.verification.commandId}.`
        : criterion.verification.type === "file"
          ? `Inspect ${criterion.verification.path}: ${criterion.verification.condition}`
          : `Request review from ${criterion.verification.reviewerRole}.`,
    })),
    risks: [],
    questions: [],
    confidence: "high",
  };
}

function startTaskContent(input: TaskContentStartInput): { runId: string } {
  const runId = randomUUID();
  const controller = new AbortController();
  activeTaskContentRuns.set(runId, {
    controller,
    status: "starting",
    taskKeys: [...input.taskKeys],
  });
  let sequence = 0;
  const timestamp = () => new Date().toISOString();
  const status = (value: "starting" | "running" | "completed" | "failed" | "cancelled") => {
    const activeRun = activeTaskContentRuns.get(runId);
    if (activeRun) activeRun.status = value;
    emitTaskContentEvent({
      type: "task-content.status",
      runId,
      sequence: ++sequence,
      status: value,
      taskKeys: input.taskKeys,
      timestamp: timestamp(),
    });
  };

  setTimeout(() => {
    void (async () => {
      try {
        status("starting");
        const [repository, workspaces, snapshot] = await Promise.all([
          inspector.describe(),
          inspector.listWorkspaces(),
          inspector.taskSnapshot(),
        ]);
        const byKey = new Map(snapshot.tasks.map((task) => [
          `${task.key.workspaceSlug}/${task.key.taskId}`,
          task,
        ]));
        const tasks = input.taskKeys.map((taskKey) => {
          const task = byKey.get(taskKey);
          if (!task) throw new Error(`Task ${taskKey} does not exist.`);
          return task;
        });
        const runner = runners.get(input.runnerId);
        const descriptor = await runner.describe();
        if (!descriptor.available) throw new Error(descriptor.unavailableReason || `${descriptor.name} is unavailable.`);
        status("running");
        await mapConcurrent(tasks, 4, async (task) => {
          const taskKey = `${task.key.workspaceSlug}/${task.key.taskId}`;
          try {
            emitTaskContentEvent({
              type: "task-content.delta",
              runId,
              sequence: ++sequence,
              taskKey,
              text: `PhaseAtlas · Content agent started · ${task.title}\n`,
              timestamp: timestamp(),
            });
            const content = await runner.initializeContent(
              {
                repositoryRoot: canonicalRepositoryRoot,
                repositoryName: repository.name,
                input: {
                  target: { type: "workspace", workspaceSlug: task.key.workspaceSlug },
                  runnerId: input.runnerId,
                  request: `Initialize the approved body for canonical task ${taskKey}.`,
                  ...(input.model ? { model: input.model } : {}),
                },
                canonicalTasks: snapshot.tasks,
                workspaces,
              },
              contentOutline(task),
              controller.signal,
              (text) => emitTaskContentEvent({
                type: "task-content.delta",
                runId,
                sequence: ++sequence,
                taskKey,
                text,
                timestamp: timestamp(),
              }),
            );
            const contentPath = await writeTaskContent({
              root: canonicalRepositoryRoot,
              task,
              body: content.body,
            });
            emitTaskContentEvent({
              type: "task-content.task-completed",
              runId,
              sequence: ++sequence,
              taskKey,
              contentPath,
              timestamp: timestamp(),
            });
          } catch (error) {
            if (controller.signal.aborted) throw error;
            emitTaskContentEvent({
              type: "task-content.task-failed",
              runId,
              sequence: ++sequence,
              taskKey,
              message: error instanceof Error ? error.message : "Unknown task content failure.",
              timestamp: timestamp(),
            });
          }
        });
        inspector.invalidate();
        status("completed");
      } catch (error) {
        if (controller.signal.aborted) status("cancelled");
        else {
          for (const taskKey of input.taskKeys) {
            emitTaskContentEvent({
              type: "task-content.task-failed",
              runId,
              sequence: ++sequence,
              taskKey,
              message: error instanceof Error ? error.message : "Unknown task content failure.",
              timestamp: timestamp(),
            });
          }
          status("failed");
        }
      } finally {
        activeTaskContentRuns.delete(runId);
      }
    })();
  }, 0);
  return { runId };
}

function listTaskContentRuns(): TaskContentRunSummary[] {
  return [...activeTaskContentRuns.entries()].map(([runId, run]) => ({
    runId,
    status: run.status,
    taskKeys: [...run.taskKeys],
  }));
}

async function dispatch(request: WorkerRequest): Promise<unknown> {
  switch (request.method) {
    case "repository.describe":
      return inspector.describe();
    case "repository.refresh":
      inspector.invalidate();
      return inspector.describe();
    case "workspace.list":
      return inspector.listWorkspaces();
    case "task.snapshot":
      return inspector.taskSnapshot();
    case "runner.list":
      return runners.list();
    case "planning.start":
      return startPlanning(planningInput(requestParams(request).input));
    case "planning.cancel": {
      const runId = requestParams(request).runId;
      if (typeof runId !== "string") throw new Error("runId is required.");
      activePlanningRuns.get(runId)?.abort();
      return undefined;
    }
    case "task-content.start":
      return startTaskContent(taskContentInput(requestParams(request).input));
    case "task-content.list":
      return listTaskContentRuns();
    case "task-content.cancel": {
      const runId = requestParams(request).runId;
      if (typeof runId !== "string") throw new Error("runId is required.");
      activeTaskContentRuns.get(runId)?.controller.abort();
      return undefined;
    }
    case "task-content.save": {
      const { taskKey, body } = requestParams(request);
      if (typeof taskKey !== "string" || typeof body !== "string") {
        throw new Error("taskKey and body are required.");
      }
      return inspector.saveTaskContent(taskKey, body);
    }
    case "file.list": {
      const directory = requestParams(request).directory;
      if (directory !== undefined && typeof directory !== "string") throw new Error("directory must be a string.");
      return listRepositoryFiles(canonicalRepositoryRoot, directory as string | undefined);
    }
    case "file.read": {
      const filePath = requestParams(request).path;
      if (typeof filePath !== "string") throw new Error("path is required.");
      return readRepositoryFile(canonicalRepositoryRoot, filePath);
    }
    case "file.save": {
      const { path: filePath, content } = requestParams(request);
      if (typeof filePath !== "string" || typeof content !== "string") {
        throw new Error("path and content are required.");
      }
      await saveRepositoryFile(canonicalRepositoryRoot, filePath, content);
      if (filePath.startsWith(".phaseatlas/")) inspector.invalidate();
      return undefined;
    }
    case "proposal.publish": {
      const params = requestParams(request);
      let input = params.input as PlanningPublishInput | undefined;
      // During development, an already-loaded preload can forward the new publish input through
      // the former workspaceSlug argument until Electron restarts.
      if (!input && isRecord(params.workspaceSlug) && "target" in params.workspaceSlug) {
        input = params.workspaceSlug as unknown as PlanningPublishInput;
      }
      if (!input && typeof params.workspaceSlug === "string" && isRecord(params.proposals)) {
        input = {
          target: { type: "workspace", workspaceSlug: params.workspaceSlug },
          proposals: {
            workspaces: Array.isArray(params.proposals.workspaces) ? params.proposals.workspaces : [],
            tasks: Array.isArray(params.proposals.tasks) ? params.proposals.tasks : [],
          },
        } as PlanningPublishInput;
      }
      if (!input?.target || !input.proposals) throw new Error("Planning publish input is required.");
      return inspector.publishPlanningProposals(input.target, input.proposals);
    }
  }
}

let watcher: FSWatcher | null = null;
let changeTimer: NodeJS.Timeout | null = null;
const changedPaths = new Set<string>();

try {
  const phaseAtlasRoot = path.join(repositoryRoot, ".phaseatlas");
  watcher = watch(phaseAtlasRoot, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
  });
  watcher.on("all", (_eventType, changedPath) => {
    const nestedPath = path.relative(repositoryRoot, changedPath).replaceAll(path.sep, "/");
    changedPaths.add(nestedPath || ".phaseatlas");
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      inspector.invalidate();
      send({
        type: "repository.changed",
        payload: { paths: [...changedPaths].sort() },
      });
      changedPaths.clear();
      changeTimer = null;
    }, 150);
  });
  watcher.on("error", (error) => {
    send({
      type: "worker.warning",
      payload: { message: `File watcher failed: ${error instanceof Error ? error.message : "unknown error"}` },
    });
  });
} catch (error) {
  send({
    type: "worker.warning",
    payload: { message: `File watching is unavailable: ${error instanceof Error ? error.message : "unknown error"}` },
  });
}

process.once("exit", () => {
  for (const controller of activePlanningRuns.values()) controller.abort();
  for (const run of activeTaskContentRuns.values()) run.controller.abort();
  if (changeTimer) clearTimeout(changeTimer);
  void watcher?.close();
});

parentPort.on("message", ({ data }) => {
  const request = data as WorkerRequest;
  if (!request || typeof request.requestId !== "string" || typeof request.method !== "string") {
    send({
      type: "worker.warning",
      payload: { message: "Ignored an invalid worker request." },
    });
    return;
  }

  dispatch(request)
    .then((result) => send({ requestId: request.requestId, result }))
    .catch((error: unknown) =>
      send({
        requestId: request.requestId,
        error: {
          code: "WORKER_REQUEST_FAILED",
          message: error instanceof Error ? error.message : "Unknown repository worker failure.",
        },
      }),
    );
});

send({
  type: "worker.ready",
  payload: {
    repositoryRoot,
    processId: process.pid,
  },
});
