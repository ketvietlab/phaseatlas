import process from "node:process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  PlanningEvent,
  PlanningPublishInput,
  PlanningStartInput,
  PlanningTarget,
  PersistedRunStatus,
  AgentRunCreateInput,
  AgentRunAction,
  AgentRunActionAvailability,
  AgentRunActionQuery,
  AgentRunCancellationResult,
  AgentRunRecoveryInput,
  AgentRunRecoveryResult,
  AgentRunStartInput,
  AgentRunSummary,
  AgentSandbox,
  ChatEditPrepareInput,
  ChatEditStartInput,
  PersistedRunEventPage,
  RepositoryChatCreateInput,
  RepositoryChatAttachment,
  RepositoryChatImageMediaType,
  RepositoryChatProviderInput,
  RepositoryChatRenameInput,
  RepositoryChatRetryInput,
  RepositoryChatSendInput,
  TaskContentEvent,
  TaskContentRunStatus,
  TaskContentRunSummary,
  TaskContentStartInput,
  TaskProposalOutline,
  TerminalCreateInput,
  WorkerEvent,
  WorkerRequest,
  WorkerResponse,
} from "@phaseatlas/contracts";
import {
  AgentExecutionScheduler,
  CheckoutOperationalStore,
  RepositoryInspector,
  listRepositoryFiles,
  readRepositoryFile,
  saveRepositoryFile,
  reviewAgentResult,
  writeTaskContent,
  WorktreeLeaseManager,
} from "@phaseatlas/core";
import { watch, type FSWatcher } from "chokidar";
import { assertRunnerSelection, RunnerRegistry } from "./runner-registry.js";
import { TerminalSessionManager } from "./terminal-session-manager.js";
import { RepositoryChatAdapterRegistry } from "./chat-adapter-registry.js";
import { RepositoryChatRuntime } from "./repository-chat-runtime.js";
import { ChatEditAdapterRegistry } from "./chat-edit-adapter-registry.js";
import { ChatEditRuntime } from "./chat-edit-runtime.js";
import {
  AgentTaskRunGuard,
  canonicalAgentTaskKey,
  resolveAgentTaskReference,
} from "./agent-task-run-guard.js";

interface ElectronParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: WorkerEvent | WorkerResponse): void;
}

const utilityParentPort = (process as typeof process & { parentPort?: ElectronParentPort }).parentPort;
const repositoryRoot = process.env.PHASEATLAS_REPO_ROOT;
const checkoutStorePath = process.env.PHASEATLAS_CHECKOUT_STORE_PATH;

if (!utilityParentPort) {
  throw new Error("Repository worker must be launched as an Electron utility process.");
}
if (!repositoryRoot) {
  throw new Error("PHASEATLAS_REPO_ROOT is required.");
}
if (!checkoutStorePath) {
  throw new Error("PHASEATLAS_CHECKOUT_STORE_PATH is required.");
}
const canonicalRepositoryRoot = repositoryRoot;

const inspector = await RepositoryInspector.open(canonicalRepositoryRoot);
const initialRepository = await inspector.describe();
const resolvedCheckoutStorePath = path.resolve(checkoutStorePath);
if (
  path.basename(resolvedCheckoutStorePath) !== "operations.sqlite" ||
  path.basename(path.dirname(resolvedCheckoutStorePath)) !== initialRepository.checkoutId
) {
  throw new Error("Checkout operational store path does not match the worker checkout identity.");
}
const operationalStore = new CheckoutOperationalStore(resolvedCheckoutStorePath, initialRepository.checkoutId);
operationalStore.reconcileInterruptedRuns();
operationalStore.reconcileInterruptedChatTurns();
const leaseManager = new WorktreeLeaseManager(canonicalRepositoryRoot, initialRepository.checkoutId, operationalStore);
const executionScheduler = new AgentExecutionScheduler(inspector, operationalStore, leaseManager);
const abandonedLeases = await leaseManager.reconcileAbandoned();
const runners = new RunnerRegistry();
// The canonical contract plus what the pipeline already concluded, so a question
// asked in the task conversation is answered against the same facts a run sees.
async function taskConversationContext(taskKey: string): Promise<string | undefined> {
  try {
    const snapshot = await inspector.taskSnapshot();
    const task = snapshot.tasks.find((candidate) => canonicalAgentTaskKey(candidate) === taskKey);
    if (!task) return undefined;
    const stages = operationalStore.listAgentResultsForTask(taskKey, task.revision).map((stage) => ({
      action: stage.action,
      outcome: stage.result.result.outcome,
      summary: stage.result.result.summary,
      blockers: stage.result.result.blockers,
      nextAction: stage.result.result.nextAction,
    }));
    return JSON.stringify({
      taskKey,
      taskRevision: task.revision,
      title: task.title,
      objective: task.objective,
      state: task.state,
      scope: task.scope,
      acceptanceCriteria: task.acceptanceCriteria,
      completedStages: stages,
    }, null, 2);
  } catch {
    return undefined;
  }
}

const chatRuntime = new RepositoryChatRuntime(
  operationalStore,
  runners,
  new RepositoryChatAdapterRegistry(),
  canonicalRepositoryRoot,
  initialRepository.checkoutId,
  (event) => send({ type: "chat.turn.event", payload: { turnId: event.turnId, event } }),
  taskConversationContext,
);
const chatEditRuntime = new ChatEditRuntime(
  operationalStore,
  inspector,
  leaseManager,
  runners,
  new ChatEditAdapterRegistry(),
  canonicalRepositoryRoot,
  initialRepository.checkoutId,
  (editId, event) => send({ type: "chat.edit.event", payload: { editId, event } }),
);
const parentPort: ElectronParentPort = utilityParentPort;
const activePlanningRuns = new Map<string, AbortController>();
const activeTaskContentRuns = new Map<string, {
  controller: AbortController;
  status: TaskContentRunStatus;
  taskKeys: string[];
}>();
const activeAgentRuns = new Map<string, {
  controller: AbortController;
  completion: Promise<void>;
  cancellation?: Promise<AgentRunCancellationResult>;
}>();
const agentTaskRunGuard = new AgentTaskRunGuard();
const terminalSessions = new TerminalSessionManager(canonicalRepositoryRoot, (event) => {
  send({ type: "terminal.event", payload: { event } });
});

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

function terminalCreateInput(value: unknown): Partial<TerminalCreateInput> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Terminal create input must be an object.");
  const allowedFields = new Set(["cols", "rows"]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new Error("Terminal create input contains unsupported fields.");
  }
  return {
    ...(value.cols !== undefined ? { cols: value.cols as number } : {}),
    ...(value.rows !== undefined ? { rows: value.rows as number } : {}),
  };
}

function chatCreateInput(value: unknown): RepositoryChatCreateInput {
  if (!isRecord(value)) throw new Error("Chat session input is required.");
  const allowed = new Set(["runnerId", "model", "reasoningEffort", "taskKey", "title"]);
  if (Object.keys(value).some((field) => !allowed.has(field))) throw new Error("Chat session input contains unsupported fields.");
  if (typeof value.runnerId !== "string" || typeof value.model !== "string") {
    throw new Error("runnerId and model are required.");
  }
  if (value.title !== undefined && typeof value.title !== "string") throw new Error("title must be a string.");
  if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== "string" || !value.reasoningEffort.trim())) {
    throw new Error("reasoningEffort must be a non-empty string.");
  }
  return {
    runnerId: value.runnerId,
    model: value.model,
    ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort.trim() } : {}),
    ...(typeof value.taskKey === "string" && value.taskKey.trim() ? { taskKey: value.taskKey.trim() } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
  };
}

function chatRenameInput(value: unknown): RepositoryChatRenameInput {
  if (!isRecord(value) || Object.keys(value).some((field) => !["sessionId", "title"].includes(field))) {
    throw new Error("Chat rename input is invalid.");
  }
  if (typeof value.sessionId !== "string" || typeof value.title !== "string") {
    throw new Error("sessionId and title are required.");
  }
  return { sessionId: value.sessionId, title: value.title };
}

function chatProviderInput(value: unknown): RepositoryChatProviderInput {
  const fields = ["sessionId", "runnerId", "model", "reasoningEffort"];
  if (!isRecord(value) || Object.keys(value).some((field) => !fields.includes(field))) {
    throw new Error("Chat provider input is invalid.");
  }
  if (typeof value.sessionId !== "string" || typeof value.runnerId !== "string" || typeof value.model !== "string") {
    throw new Error("sessionId, runnerId, and model are required.");
  }
  return {
    sessionId: value.sessionId,
    runnerId: value.runnerId,
    model: value.model,
    ...(typeof value.reasoningEffort === "string" && value.reasoningEffort.trim()
      ? { reasoningEffort: value.reasoningEffort.trim() }
      : {}),
  };
}

function chatSendInput(value: unknown): RepositoryChatSendInput {
  if (!isRecord(value) || Object.keys(value).some((field) => !["sessionId", "text", "attachments"].includes(field))) {
    throw new Error("Chat turn input is invalid.");
  }
  if (typeof value.sessionId !== "string" || typeof value.text !== "string") {
    throw new Error("sessionId and text are required.");
  }
  const attachments = chatAttachments(value.attachments);
  return { sessionId: value.sessionId, text: value.text, ...(attachments.length ? { attachments } : {}) };
}

function chatAttachments(value: unknown): RepositoryChatAttachment[] {
  if (value !== undefined && !Array.isArray(value)) throw new Error("attachments must be an array.");
  return (value ?? []).map((attachment) => {
    if (!isRecord(attachment)) {
      throw new Error("Chat attachment is invalid.");
    }
    if (attachment.type === "image") {
      if (Object.keys(attachment).some((field) => !["type", "name", "mediaType", "data"].includes(field)) ||
          typeof attachment.name !== "string" || typeof attachment.mediaType !== "string" || typeof attachment.data !== "string") {
        throw new Error("Chat image attachment is invalid.");
      }
      return { type: "image" as const, name: attachment.name, mediaType: attachment.mediaType as RepositoryChatImageMediaType, data: attachment.data };
    }
    if (Object.keys(attachment).some((field) => !["type", "path"].includes(field)) || typeof attachment.path !== "string" ||
        (attachment.type !== undefined && attachment.type !== "repository")) {
      throw new Error("Chat repository attachment is invalid.");
    }
    return { path: attachment.path };
  });
}

function chatEditPrepareInput(value: unknown): ChatEditPrepareInput {
  if (!isRecord(value) || Object.keys(value).some((field) => !["sessionId", "prompt", "accessMode", "attachments"].includes(field))) {
    throw new Error("Chat edit preparation input is invalid.");
  }
  if (
    typeof value.sessionId !== "string" ||
    typeof value.prompt !== "string" ||
    !["ask_for_approval", "full_access"].includes(String(value.accessMode))
  ) {
    throw new Error("sessionId, prompt, and a supported accessMode are required.");
  }
  const attachments = chatAttachments(value.attachments);
  return {
    sessionId: value.sessionId,
    prompt: value.prompt,
    accessMode: value.accessMode as ChatEditPrepareInput["accessMode"],
    ...(attachments.length ? { attachments } : {}),
  };
}

function chatEditStartInput(value: unknown): ChatEditStartInput {
  if (!isRecord(value) || Object.keys(value).some((field) => !["editId", "confirmationDigest"].includes(field))) {
    throw new Error("Chat edit start input is invalid.");
  }
  if (typeof value.editId !== "string" || typeof value.confirmationDigest !== "string") {
    throw new Error("editId and confirmationDigest are required.");
  }
  return { editId: value.editId, confirmationDigest: value.confirmationDigest };
}

function chatRetryInput(value: unknown): RepositoryChatRetryInput {
  if (!isRecord(value) || Object.keys(value).some((field) => field !== "turnId") || typeof value.turnId !== "string") {
    throw new Error("Chat retry input is invalid.");
  }
  return { turnId: value.turnId };
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
  if (input.reasoningEffort !== undefined && (typeof input.reasoningEffort !== "string" || !input.reasoningEffort.trim())) {
    throw new Error("reasoningEffort must be a non-empty string.");
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
    ...(typeof input.reasoningEffort === "string" ? { reasoningEffort: input.reasoningEffort.trim() } : {}),
  };
}

function agentRunInput(value: unknown): AgentRunCreateInput {
  if (!isRecord(value)) throw new Error("Agent run input is required.");
  const allowedFields = new Set(["taskKey", "expectedTaskRevision", "expectedCheckoutId", "action", "requestedSandbox"]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new Error("Agent run input contains unsupported fields.");
  }
  if (typeof value.taskKey !== "string" || !value.taskKey.trim()) throw new Error("taskKey is required.");
  const actions = new Set<AgentRunAction>(["analyze", "plan", "implement", "review"]);
  if (!actions.has(value.action as AgentRunAction)) throw new Error("action is invalid.");
  if (value.expectedTaskRevision !== undefined && typeof value.expectedTaskRevision !== "string") {
    throw new Error("expectedTaskRevision must be a string.");
  }
  if (value.expectedCheckoutId !== undefined && typeof value.expectedCheckoutId !== "string") {
    throw new Error("expectedCheckoutId must be a string.");
  }
  const sandboxes = new Set<AgentSandbox>(["read-only", "workspace-write"]);
  if (value.requestedSandbox !== undefined && !sandboxes.has(value.requestedSandbox as AgentSandbox)) {
    throw new Error("requestedSandbox is invalid.");
  }
  return {
    taskKey: value.taskKey.trim(),
    action: value.action as AgentRunAction,
    ...(typeof value.expectedTaskRevision === "string" ? { expectedTaskRevision: value.expectedTaskRevision } : {}),
    ...(typeof value.expectedCheckoutId === "string" ? { expectedCheckoutId: value.expectedCheckoutId } : {}),
    ...(value.requestedSandbox ? { requestedSandbox: value.requestedSandbox as AgentSandbox } : {}),
  };
}

function agentRunStartInput(value: unknown): AgentRunStartInput {
  if (!isRecord(value)) throw new Error("Agent run start input is required.");
  const allowedFields = new Set([
    "taskKey", "expectedTaskRevision", "expectedCheckoutId", "action", "requestedSandbox", "runnerId", "model", "reasoningEffort",
  ]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new Error("Agent run start input contains unsupported fields.");
  }
  if (typeof value.runnerId !== "string" || !value.runnerId.trim()) throw new Error("runnerId is required.");
  if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) {
    throw new Error("model must be a non-empty string.");
  }
  if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== "string" || !value.reasoningEffort.trim())) {
    throw new Error("reasoningEffort must be a non-empty string.");
  }
  const request = agentRunInput(Object.fromEntries(
    Object.entries(value).filter(([field]) => !["runnerId", "model", "reasoningEffort"].includes(field)),
  ));
  return {
    ...request,
    runnerId: value.runnerId.trim(),
    ...(typeof value.model === "string" ? { model: value.model.trim() } : {}),
    ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort.trim() } : {}),
  };
}

function agentRunActionQuery(value: unknown): AgentRunActionQuery {
  if (!isRecord(value)) throw new Error("Agent run action query is required.");
  const allowedFields = new Set(["taskKey", "runnerId", "model", "reasoningEffort"]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new Error("Agent run action query contains unsupported fields.");
  }
  if (typeof value.taskKey !== "string" || !value.taskKey.trim()) throw new Error("taskKey is required.");
  if (typeof value.runnerId !== "string" || !value.runnerId.trim()) throw new Error("runnerId is required.");
  if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) {
    throw new Error("model must be a non-empty string.");
  }
  if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== "string" || !value.reasoningEffort.trim())) {
    throw new Error("reasoningEffort must be a non-empty string.");
  }
  return {
    taskKey: value.taskKey.trim(),
    runnerId: value.runnerId.trim(),
    ...(typeof value.model === "string" ? { model: value.model.trim() } : {}),
    ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort.trim() } : {}),
  };
}

function agentRunRecoveryInput(value: unknown): AgentRunRecoveryInput {
  if (!isRecord(value)) throw new Error("Agent run recovery input is required.");
  const allowedFields = new Set(["runId", "decision", "runnerId", "model", "reasoningEffort"]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new Error("Agent run recovery input contains unsupported fields.");
  }
  if (typeof value.runId !== "string" || !/^[a-f0-9-]{8,64}$/i.test(value.runId)) throw new Error("runId is invalid.");
  if (value.decision !== "leave_interrupted" && value.decision !== "retry") throw new Error("Recovery decision is invalid.");
  if (value.decision === "retry" && (typeof value.runnerId !== "string" || !value.runnerId.trim())) {
    throw new Error("runnerId is required for retry.");
  }
  if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) {
    throw new Error("model must be a non-empty string.");
  }
  if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== "string" || !value.reasoningEffort.trim())) {
    throw new Error("reasoningEffort must be a non-empty string.");
  }
  return {
    runId: value.runId,
    decision: value.decision,
    ...(typeof value.runnerId === "string" ? { runnerId: value.runnerId.trim() } : {}),
    ...(typeof value.model === "string" ? { model: value.model.trim() } : {}),
    ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort.trim() } : {}),
  };
}

function durableStatus(value: unknown): PersistedRunStatus | undefined {
  return ["starting", "running", "completed", "failed", "cancelled", "interrupted"].includes(String(value))
    ? value as PersistedRunStatus
    : undefined;
}

function persistEvent<Event extends PlanningEvent | TaskContentEvent>(event: Event): Event {
  const status = "status" in event ? durableStatus(event.status) : undefined;
  const { sequence: _sourceSequence, ...payload } = event;
  const persisted = operationalStore.appendEvent({
    runId: event.runId,
    type: event.type,
    timestamp: event.timestamp,
    payload: payload as unknown as Record<string, unknown>,
    ...(status ? { status } : {}),
  });
  return { ...event, sequence: persisted.sequence };
}

function emitPlanningEvent(event: PlanningEvent): void {
  send({ type: "planning.event", payload: { event: persistEvent(event) } });
}

function emitTaskContentEvent(event: TaskContentEvent): void {
  send({ type: "task-content.event", payload: { event: persistEvent(event) } });
}

function startPlanning(input: PlanningStartInput): { runId: string } {
  const runId = randomUUID();
  const controller = new AbortController();
  operationalStore.recordRun({ runId, kind: "planning", status: "starting" });
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
        assertRunnerSelection(descriptor, input.model, input.reasoningEffort);

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
  if (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== "string" || !value.reasoningEffort.trim())) {
    throw new Error("reasoningEffort must be a non-empty string.");
  }
  return {
    taskKeys: [...new Set((value.taskKeys as string[]).map((taskKey) => taskKey.trim()))],
    runnerId: value.runnerId.trim(),
    ...(typeof value.model === "string" && value.model.trim() ? { model: value.model.trim() } : {}),
    ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort.trim() } : {}),
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
  operationalStore.recordRun({ runId, kind: "task_content", status: "starting", taskKeys: input.taskKeys });
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
        assertRunnerSelection(descriptor, input.model, input.reasoningEffort);
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
                  ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
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

async function agentRunActions(
  input: AgentRunActionQuery,
  options: { ignoreStartingTaskKey?: string; snapshot?: Awaited<ReturnType<typeof inspector.taskSnapshot>> } = {},
): Promise<AgentRunActionAvailability[]> {
  const [snapshot, descriptor] = await Promise.all([
    options.snapshot ?? inspector.taskSnapshot(),
    runners.get(input.runnerId).describe(),
  ]);
  const task = resolveAgentTaskReference(snapshot, input.taskKey);
  const taskKey = canonicalAgentTaskKey(task);
  const commonReasons: string[] = [];
  if (snapshot.issues.some((issue) => issue.severity === "error")) {
    commonReasons.push("Resolve canonical task validation errors before execution.");
  }
  if (!descriptor.available) commonReasons.push(descriptor.unavailableReason || `${descriptor.name} is unavailable.`);
  try {
    assertRunnerSelection(descriptor, input.model, input.reasoningEffort);
  } catch (error) {
    commonReasons.push(error instanceof Error ? error.message : "The selected model is unavailable.");
  }
  const hasActiveTaskRun = operationalStore.listRuns().some((run) =>
    run.kind === "agent" && ["starting", "running"].includes(run.status) && operationalStore.getAgentSpec(run.runId)?.taskKey === taskKey
  );
  if (hasActiveTaskRun || (agentTaskRunGuard.has(taskKey) && options.ignoreStartingTaskKey !== taskKey)) {
    commonReasons.push("Another agent run is already active for this task.");
  }

  const incompleteDependencies = task.dependencies.flatMap((dependency) => {
    if (dependency.relation !== "blocks_start") return [];
    const dependencyTask = snapshot.tasks.find((candidate) =>
      `${candidate.key.workspaceSlug}/${candidate.key.taskId}` === dependency.taskKey ||
      candidate.key.taskId === dependency.taskKey
    );
    const requiredState = dependency.requiredState ?? "done";
    return dependencyTask?.state === requiredState
      ? []
      : [`Dependency ${dependency.taskKey} must be ${requiredState.replaceAll("_", " ")}.`];
  });
  const hasAbandonedAttempt = leaseManager.list().some((lease) => {
    if (lease.status !== "abandoned") return false;
    return operationalStore.getAgentSpec(lease.runId)?.taskKey === taskKey;
  });
  const actions: AgentRunAction[] = ["analyze", "plan", "implement", "review"];
  return actions.map((action) => {
    const sandbox: AgentSandbox = action === "implement" ? "workspace-write" : "read-only";
    const blockingReasons = [...commonReasons];
    if (!descriptor.execution?.actions.includes(action)) {
      blockingReasons.push(`${descriptor.name} does not support ${action} runs.`);
    }
    if (!descriptor.execution?.sandboxes.includes(sandbox)) {
      blockingReasons.push(`${descriptor.name} cannot enforce the required ${sandbox} sandbox.`);
    }
    if (action === "implement") {
      if (!task.scope.writable) blockingReasons.push("This task contract does not permit repository writes.");
      if (!["ready", "in_progress", "in_review"].includes(task.state)) {
        blockingReasons.push(`Task state ${task.state.replaceAll("_", " ")} is not execution-ready.`);
      }
      blockingReasons.push(...incompleteDependencies);
      if (hasAbandonedAttempt) blockingReasons.push("Resolve the abandoned worktree attempt before starting another implementation.");
    }
    return { action, sandbox, available: blockingReasons.length === 0, blockingReasons };
  });
}

async function listAgentRuns(taskKey?: string): Promise<AgentRunSummary[]> {
  if (taskKey !== undefined && (!taskKey.trim() || taskKey.length > 160)) throw new Error("taskKey is invalid.");
  const summaries: AgentRunSummary[] = [];
  for (const run of operationalStore.listRuns().filter((candidate) => candidate.kind === "agent")) {
    const spec = operationalStore.getAgentSpec(run.runId);
    if (!spec || (taskKey && spec.taskKey !== taskKey)) continue;
    let review: Awaited<ReturnType<typeof reviewAgentResult>> | undefined;
    if (operationalStore.getAgentResult(run.runId)) {
      try {
        review = await reviewAgentResult(operationalStore, inspector, run.runId);
      } catch {
        review = undefined;
      }
    }
    const parentRunId = operationalStore.parentRunId(run.runId);
    summaries.push({
      runId: run.runId,
      taskKey: spec.taskKey,
      taskRevision: spec.taskRevision,
      action: spec.action,
      sandbox: spec.sandbox,
      runnerId: spec.runnerId,
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
      status: run.status,
      ...(parentRunId ? { parentRunId } : {}),
      ...(review ? { freshness: review.freshness, promotable: review.promotable } : {}),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
  }
  return summaries;
}

async function startAgentRun(input: AgentRunStartInput, parentRunId?: string): Promise<{ runId: string }> {
  const snapshot = await inspector.taskSnapshot();
  const taskKey = canonicalAgentTaskKey(resolveAgentTaskReference(snapshot, input.taskKey));
  const releaseTaskStart = agentTaskRunGuard.acquire(taskKey);
  try {
    const availability = (await agentRunActions({
      taskKey,
      runnerId: input.runnerId,
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    }, { ignoreStartingTaskKey: taskKey, snapshot })).find((candidate) => candidate.action === input.action);
    if (!availability?.available) {
      throw new Error(availability?.blockingReasons.join(" ") || `Action ${input.action} is unavailable.`);
    }
    const runner = runners.get(input.runnerId);
    const descriptor = await runner.describe();
    if (!descriptor.available) throw new Error(descriptor.unavailableReason || `${descriptor.name} is unavailable.`);
    assertRunnerSelection(descriptor, input.model, input.reasoningEffort);
    const expectedSandbox: AgentSandbox = input.action === "implement" ? "workspace-write" : "read-only";
    const adapter = runners.getExecution(input.runnerId, input.action, expectedSandbox);
    const request: AgentRunCreateInput = {
      taskKey,
      action: input.action,
      ...(input.expectedTaskRevision ? { expectedTaskRevision: input.expectedTaskRevision } : {}),
      ...(input.expectedCheckoutId ? { expectedCheckoutId: input.expectedCheckoutId } : {}),
      ...(input.requestedSandbox ? { requestedSandbox: input.requestedSandbox } : {}),
    };
    const prepared = await executionScheduler.prepare(request, {
      runnerId: input.runnerId,
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    });
    if (parentRunId) operationalStore.linkRunAttempt(prepared.spec.runId, parentRunId);
    const controller = new AbortController();
    const entry: {
      controller: AbortController;
      completion: Promise<void>;
      cancellation?: Promise<AgentRunCancellationResult>;
    } = { controller, completion: Promise.resolve() };
    entry.completion = executionScheduler.executePrepared(
      prepared,
      adapter,
      controller.signal,
      (event) => send({ type: "agent-run.event", payload: { runId: prepared.spec.runId, event } }),
      input.model,
      input.reasoningEffort,
    ).then(() => undefined).finally(() => {
      if (activeAgentRuns.get(prepared.spec.runId) === entry) activeAgentRuns.delete(prepared.spec.runId);
    });
    activeAgentRuns.set(prepared.spec.runId, entry);
    void entry.completion.catch(() => undefined);
    return { runId: prepared.spec.runId };
  } finally {
    releaseTaskStart();
  }
}

async function cancelAgentRun(runId: string): Promise<AgentRunCancellationResult> {
  const run = operationalStore.getRun(runId);
  if (run.kind !== "agent") throw new Error("Run is not an agent execution.");
  if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
    return {
      runId,
      status: run.status as AgentRunCancellationResult["status"],
      disposition: "already_terminal",
    };
  }
  const active = activeAgentRuns.get(runId);
  if (!active) throw new Error("The agent process is not owned by this worker and requires recovery.");
  if (!active.cancellation) {
    active.controller.abort(new Error("Agent run cancellation requested."));
    active.cancellation = active.completion.catch(() => undefined).then(() => {
      const terminal = operationalStore.getRun(runId);
      if (!["completed", "failed", "cancelled", "interrupted"].includes(terminal.status)) {
        throw new Error("Agent cancellation did not reach a durable terminal state.");
      }
      return {
        runId,
        status: terminal.status as AgentRunCancellationResult["status"],
        disposition: terminal.status === "cancelled" ? "cancelled" as const : "already_terminal" as const,
      };
    });
  }
  return active.cancellation;
}

async function recoverAgentRun(input: AgentRunRecoveryInput): Promise<AgentRunRecoveryResult> {
  const run = operationalStore.getRun(input.runId);
  if (run.kind !== "agent" || run.status !== "interrupted") {
    throw new Error("Only an interrupted agent run can be recovered.");
  }
  if (input.decision === "leave_interrupted") {
    return { originalRunId: input.runId, decision: input.decision };
  }
  const previous = operationalStore.getAgentSpec(input.runId);
  if (!previous || !input.runnerId) throw new Error("Interrupted run specification is unavailable.");
  const retry = await startAgentRun({
    taskKey: previous.taskKey,
    action: previous.action,
    expectedCheckoutId: initialRepository.checkoutId,
    runnerId: input.runnerId,
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
  }, input.runId);
  return { originalRunId: input.runId, decision: input.decision, retryRunId: retry.runId };
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
    case "run.list":
      return operationalStore.listRuns();
    case "run.events": {
      const { runId, afterSequence } = requestParams(request);
      if (typeof runId !== "string") throw new Error("runId is required.");
      if (afterSequence !== undefined && (!Number.isInteger(afterSequence) || Number(afterSequence) < 0)) {
        throw new Error("afterSequence must be a non-negative integer.");
      }
      return operationalStore.listEvents(runId, Number(afterSequence ?? 0));
    }
    case "run.events-page": {
      const { runId, afterSequence, limit } = requestParams(request);
      if (typeof runId !== "string") throw new Error("runId is required.");
      return operationalStore.listEventsPage(runId, Number(afterSequence ?? 0), Number(limit ?? 200));
    }
    case "agent-run.prepare":
      return executionScheduler.prepare(agentRunInput(requestParams(request).input));
    case "agent-run.actions":
      return agentRunActions(agentRunActionQuery(requestParams(request).input));
    case "agent-run.list": {
      const taskKey = requestParams(request).taskKey;
      if (taskKey !== undefined && typeof taskKey !== "string") throw new Error("taskKey must be a string.");
      return listAgentRuns(taskKey);
    }
    case "agent-run.command-output": {
      const { runId, commandId, offset, limit } = requestParams(request);
      if (typeof runId !== "string" || !/^[a-f0-9-]{8,64}$/i.test(runId)) throw new Error("runId is invalid.");
      if (typeof commandId !== "string" || !/^command-[1-9][0-9]*$/.test(commandId)) throw new Error("commandId is invalid.");
      return operationalStore.readAgentCommandOutput(
        runId,
        commandId,
        Number(offset ?? 0),
        Number(limit ?? 20_000),
      );
    }
    case "agent-run.start":
      return startAgentRun(agentRunStartInput(requestParams(request).input));
    case "agent-run.cancel": {
      const runId = requestParams(request).runId;
      if (typeof runId !== "string" || !/^[a-f0-9-]{8,64}$/i.test(runId)) throw new Error("runId is invalid.");
      return cancelAgentRun(runId);
    }
    case "agent-run.result": {
      const runId = requestParams(request).runId;
      if (typeof runId !== "string" || !/^[a-f0-9-]{8,64}$/i.test(runId)) throw new Error("runId is invalid.");
      return reviewAgentResult(operationalStore, inspector, runId);
    }
    case "agent-run.recover":
      return recoverAgentRun(agentRunRecoveryInput(requestParams(request).input));
    case "agent-run.leases":
      return leaseManager.list();
    case "agent-run.release": {
      const runId = requestParams(request).runId;
      if (typeof runId !== "string") throw new Error("runId is required.");
      const released = await leaseManager.release(runId, "explicit_release");
      operationalStore.appendEvent({
        runId,
        type: "run.cancelled",
        payload: { reason: "explicit_release" },
        status: "cancelled",
      });
      return released;
    }
    case "terminal.list":
      return terminalSessions.list();
    case "terminal.create":
      return terminalSessions.create(terminalCreateInput(requestParams(request).input));
    case "terminal.write": {
      const { sessionId, data } = requestParams(request);
      if (typeof sessionId !== "string" || typeof data !== "string") {
        throw new Error("sessionId and data are required.");
      }
      terminalSessions.write(sessionId, data);
      return undefined;
    }
    case "terminal.resize": {
      const { sessionId, cols, rows } = requestParams(request);
      if (typeof sessionId !== "string") throw new Error("sessionId is required.");
      terminalSessions.resize(sessionId, cols, rows);
      return undefined;
    }
    case "terminal.close": {
      const { sessionId } = requestParams(request);
      if (typeof sessionId !== "string") throw new Error("sessionId is required.");
      terminalSessions.close(sessionId);
      return undefined;
    }
    case "chat.session.create":
      return chatRuntime.createSession(chatCreateInput(requestParams(request).input));
    case "chat.session.list":
      return chatRuntime.listSessions();
    case "chat.session.get": {
      const sessionId = requestParams(request).sessionId;
      if (typeof sessionId !== "string") throw new Error("sessionId is required.");
      return chatRuntime.getSession(sessionId);
    }
    case "chat.session.rename":
      return chatRuntime.renameSession(chatRenameInput(requestParams(request).input));
    case "agent-run.lease": {
      const runId = requestParams(request).runId;
      if (typeof runId !== "string" || !runId.trim()) throw new Error("runId is required.");
      return leaseManager.list().find((lease) => lease.runId === runId) ?? null;
    }
    case "chat.session.provider":
      return chatRuntime.setSessionProvider(chatProviderInput(requestParams(request).input));
    case "chat.session.close": {
      const sessionId = requestParams(request).sessionId;
      if (typeof sessionId !== "string") throw new Error("sessionId is required.");
      return chatRuntime.closeSession(sessionId);
    }
    case "chat.message.list": {
      const sessionId = requestParams(request).sessionId;
      if (typeof sessionId !== "string") throw new Error("sessionId is required.");
      return chatRuntime.listMessages(sessionId);
    }
    case "chat.turn.list": {
      const sessionId = requestParams(request).sessionId;
      if (typeof sessionId !== "string") throw new Error("sessionId is required.");
      return chatRuntime.listTurns(sessionId);
    }
    case "chat.turn.send":
      return chatRuntime.send(chatSendInput(requestParams(request).input));
    case "chat.turn.events": {
      const { turnId, afterSequence, limit } = requestParams(request);
      if (typeof turnId !== "string") throw new Error("turnId is required.");
      return chatRuntime.eventPage(turnId, Number(afterSequence ?? 0), Number(limit ?? 200));
    }
    case "chat.turn.cancel": {
      const turnId = requestParams(request).turnId;
      if (typeof turnId !== "string") throw new Error("turnId is required.");
      return chatRuntime.cancel(turnId);
    }
    case "chat.turn.retry":
      return chatRuntime.retry(chatRetryInput(requestParams(request).input));
    case "chat.edit.prepare":
      return chatEditRuntime.prepare(chatEditPrepareInput(requestParams(request).input));
    case "chat.edit.list": {
      const sessionId = requestParams(request).sessionId;
      if (sessionId !== undefined && typeof sessionId !== "string") throw new Error("sessionId must be a string.");
      return chatEditRuntime.list(sessionId as string | undefined);
    }
    case "chat.edit.start":
      return chatEditRuntime.start(chatEditStartInput(requestParams(request).input));
    case "chat.edit.events": {
      const { editId, afterSequence, limit } = requestParams(request);
      if (typeof editId !== "string") throw new Error("editId is required.");
      return chatEditRuntime.events(editId, Number(afterSequence ?? 0), Number(limit ?? 200));
    }
    case "chat.edit.result": {
      const editId = requestParams(request).editId;
      if (typeof editId !== "string") throw new Error("editId is required.");
      return chatEditRuntime.result(editId);
    }
    case "chat.edit.cancel": {
      const editId = requestParams(request).editId;
      if (typeof editId !== "string") throw new Error("editId is required.");
      return chatEditRuntime.cancel(editId);
    }
    case "chat.edit.accept": {
      const editId = requestParams(request).editId;
      if (typeof editId !== "string") throw new Error("editId is required.");
      return chatEditRuntime.accept(editId);
    }
    case "chat.edit.discard": {
      const editId = requestParams(request).editId;
      if (typeof editId !== "string") throw new Error("editId is required.");
      return chatEditRuntime.discard(editId);
    }
    case "chat.edit.retain": {
      const editId = requestParams(request).editId;
      if (typeof editId !== "string") throw new Error("editId is required.");
      return chatEditRuntime.retain(editId);
    }
    case "chat.edit.recover": {
      const input = requestParams(request).input;
      if (!isRecord(input) || Object.keys(input).some((field) => !["editId", "decision"].includes(field))) {
        throw new Error("Chat edit recovery input is invalid.");
      }
      const { editId, decision } = input;
      if (typeof editId !== "string" || !["resume_review", "discard"].includes(String(decision))) {
        throw new Error("Chat edit recovery input is invalid.");
      }
      return chatEditRuntime.recover(editId, decision as "resume_review" | "discard");
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
  for (const run of activeAgentRuns.values()) run.controller.abort();
  terminalSessions.dispose();
  chatRuntime.shutdown();
  operationalStore.close();
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
for (const lease of abandonedLeases) send({ type: "lease.recovery", payload: { lease } });
