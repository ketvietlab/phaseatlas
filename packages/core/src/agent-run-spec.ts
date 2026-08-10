import path from "node:path";
import type {
  AgentRunCreateInput,
  AgentRunStageResult,
  AgentRunSpec,
  AgentSandbox,
  CanonicalTask,
  RepositorySummary,
  TaskSnapshot,
  WorktreeLeaseRecord,
} from "@phaseatlas/contracts";

const ACTIONS = new Set(["analyze", "plan", "implement", "review"]);
const SANDBOXES = new Set<AgentSandbox>(["read-only", "workspace-write"]);

function deepFreeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function canonicalTaskKey(task: CanonicalTask): string {
  return `${task.key.workspaceSlug}/${task.key.taskId}`;
}

export function deriveSandboxPolicy(input: AgentRunCreateInput, task: CanonicalTask): AgentSandbox {
  if (!ACTIONS.has(input.action)) throw new Error("Agent action is not supported.");
  if (input.requestedSandbox !== undefined && !SANDBOXES.has(input.requestedSandbox)) {
    throw new Error("Requested sandbox is not supported.");
  }
  const required: AgentSandbox = input.action === "implement" ? "workspace-write" : "read-only";
  if (input.requestedSandbox && input.requestedSandbox !== required) {
    throw new Error(`Action ${input.action} requires the ${required} sandbox.`);
  }
  if (required === "workspace-write" && !task.scope.writable) {
    throw new Error("The canonical task scope does not permit implementation writes.");
  }
  return required;
}

export function resolveAgentRunTask(input: AgentRunCreateInput, snapshot: TaskSnapshot): CanonicalTask {
  if (typeof input.taskKey !== "string" || !input.taskKey.trim()) throw new Error("taskKey is required.");
  if (snapshot.issues.some((issue) => issue.severity === "error")) {
    throw new Error("Canonical task validation must succeed before an agent run can be created.");
  }
  const matches = snapshot.tasks.filter((task) => canonicalTaskKey(task) === input.taskKey.trim());
  if (matches.length !== 1) throw new Error(`Task ${input.taskKey} does not resolve unambiguously.`);
  const task = matches[0] as CanonicalTask;
  if (input.expectedTaskRevision && input.expectedTaskRevision !== task.revision) {
    throw new Error(`Task ${input.taskKey} has a stale revision.`);
  }
  return task;
}

export function createAgentRunSpec(input: {
  runId: string;
  request: AgentRunCreateInput;
  repository: RepositorySummary;
  snapshot: TaskSnapshot;
  lease?: WorktreeLeaseRecord;
  priorResults?: ReadonlyArray<AgentRunStageResult>;
  createdAt?: string;
}): AgentRunSpec {
  if (!input.runId.trim()) throw new Error("runId is required.");
  if (!path.isAbsolute(input.repository.path)) throw new Error("Repository path must be canonical and absolute.");
  if (input.request.expectedCheckoutId && input.request.expectedCheckoutId !== input.repository.checkoutId) {
    throw new Error("Agent run request targets a different checkout.");
  }
  if (input.snapshot.repositoryId !== input.repository.id) {
    throw new Error("Task snapshot repository identity does not match the worker checkout.");
  }
  const task = resolveAgentRunTask(input.request, input.snapshot);
  if (task.key.repositoryId !== input.repository.id) {
    throw new Error("Canonical task belongs to a different repository.");
  }
  const sandbox = deriveSandboxPolicy(input.request, task);
  if (sandbox === "workspace-write") {
    if (
      !input.lease || input.lease.status !== "active" || input.lease.runId !== input.runId ||
      input.lease.checkoutId !== input.repository.checkoutId || !path.isAbsolute(input.lease.worktreePath)
    ) {
      throw new Error("A valid active worktree lease is required for implementation.");
    }
  } else if (input.lease) {
    throw new Error("Read-only actions cannot receive a writable worktree lease.");
  }

  const spec: AgentRunSpec = {
    schemaVersion: "phaseatlas.run/v1",
    runId: input.runId,
    taskKey: canonicalTaskKey(task),
    taskRevision: task.revision,
    ...(input.snapshot.registry ? {
      taskRegistry: {
        remote: input.snapshot.registry.remote,
        ref: input.snapshot.registry.ref,
        commit: input.snapshot.registry.commit,
      },
    } : {}),
    action: input.request.action,
    checkout: {
      repositoryId: input.repository.id,
      checkoutId: input.repository.checkoutId,
      canonicalPath: input.repository.path,
    },
    ...(input.lease ? { lease: structuredClone(input.lease) } : {}),
    executionDirectory: input.lease?.worktreePath ?? input.repository.path,
    objective: task.objective,
    ...(task.content ? { content: structuredClone(task.content) } : {}),
    contextDocuments: structuredClone(task.source.documents),
    scope: structuredClone(task.scope),
    acceptanceCriteria: structuredClone(task.acceptanceCriteria),
    verification: structuredClone(task.verification),
    sandbox,
    priorResults: structuredClone(input.priorResults ?? []),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return deepFreeze(spec);
}
