import taskProposalSchema from "../schemas/task-proposal.schema.json" with { type: "json" };
import taskContentSchema from "../schemas/task-content.schema.json" with { type: "json" };

export const TASK_PROPOSAL_SCHEMA = taskProposalSchema;
export const TASK_CONTENT_SCHEMA = taskContentSchema;

export const TASK_STATES = [
  "draft",
  "planned",
  "ready",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "deferred",
  "cancelled",
] as const;

export type TaskState = (typeof TASK_STATES)[number];
export type TaskKind = "code" | "docs" | "research" | "review" | "operations";
export type TaskPriority = "critical" | "high" | "normal" | "low";

export interface RepositorySummary {
  id: string;
  checkoutId: string;
  name: string;
  path: string;
  configuration: "configured" | "legacy";
  workspaceCount: number;
  openedAt: string;
}

export interface WorkspaceSummary {
  slug: string;
  name: string;
  description: string;
  taskCount: number;
  sourcePath: string;
}

export interface RepositoryFileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface RepositoryFileDocument {
  path: string;
  content: string;
}

export interface TaskDependency {
  taskKey: string;
  relation: "blocks_start" | "blocks_completion" | "requires_contract" | "requires_evidence" | "related";
  requiredState?: TaskState;
}

export interface TaskScope {
  allowedPaths: string[];
  forbiddenPaths: string[];
  writable: boolean;
  allowDependencyChanges: boolean;
  allowDatabaseMigrations: boolean;
  allowExternalNetwork: boolean;
}

export interface AcceptanceCriterion {
  id: string;
  statement: string;
  verification:
    | { type: "command"; commandId: string }
    | { type: "file"; path: string; condition: string }
    | { type: "human"; reviewerRole: string };
}

export interface VerificationStep {
  id: string;
  command: string;
  cwd?: string;
  timeoutSeconds: number;
  required: boolean;
}

export interface EvidenceRequirement {
  type: "test" | "human_review" | "ci" | "artifact";
  description?: string;
}

export interface TaskContent {
  path: string;
  body: string;
}

export interface TaskContentDraft {
  body: string;
}

export interface CanonicalTask {
  schemaVersion: "phaseatlas.task/v1";
  key: {
    repositoryId: string;
    workspaceSlug: string;
    taskId: string;
  };
  revision: string;
  title: string;
  objective: string;
  content?: TaskContent;
  phaseId: string;
  kind: TaskKind;
  state: TaskState;
  priority: TaskPriority;
  owners: string[];
  dependencies: TaskDependency[];
  scope: TaskScope;
  acceptanceCriteria: AcceptanceCriterion[];
  verification: VerificationStep[];
  evidenceRequirements: EvidenceRequirement[];
  source: {
    documents: Array<{ path: string; revision?: string }>;
    extractedAt: string;
    warnings: string[];
  };
}

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  sourcePath: string;
  field?: string;
}

export interface TaskGraphEdge {
  fromTaskKey: string;
  toTaskKey: string;
  relation: TaskDependency["relation"];
}

export interface TaskSnapshot {
  repositoryId: string;
  generatedAt: string;
  tasks: CanonicalTask[];
  issues: ValidationIssue[];
  graph: {
    edges: TaskGraphEdge[];
    hasCycles: boolean;
  };
}

export type RunnerCapability =
  | "planning"
  | "streaming"
  | "structured_output"
  | "repository_read";

export interface RunnerDescriptor {
  id: string;
  provider: string;
  name: string;
  version?: string;
  available: boolean;
  unavailableReason?: string;
  capabilities: RunnerCapability[];
}

export interface TaskProposalCriterion {
  statement: string;
  verificationSuggestion: string;
}

export interface WorkspaceProposal {
  temporaryId: string;
  slug: string;
  name: string;
  description: string;
  rationale: string;
  confidence: "high" | "medium" | "low";
}

export interface TaskProposal {
  temporaryId: string;
  title: string;
  objective: string;
  kind: TaskKind;
  workspaceSlug: string;
  phaseId: string;
  priority: TaskPriority;
  suggestedDependencies: string[];
  suggestedPaths: string[];
  acceptanceCriteria: TaskProposalCriterion[];
  risks: string[];
  questions: string[];
  confidence: "high" | "medium" | "low";
}

export interface PlanningProposalSet {
  workspaces: WorkspaceProposal[];
  tasks: TaskProposal[];
}

export type TaskProposalOutline = TaskProposal;
export type PlanningOutlineSet = PlanningProposalSet;

export type PlanningTarget =
  | { type: "repository" }
  | { type: "workspace"; workspaceSlug: string };

export interface PlanningStartInput {
  target: PlanningTarget;
  runnerId: string;
  model?: string;
  request: string;
}

export interface PlanningPublishInput {
  target: PlanningTarget;
  proposals: PlanningProposalSet;
}

export interface TaskContentStartInput {
  taskKeys: string[];
  runnerId: string;
  model?: string;
}

export type TaskContentRunStatus = "starting" | "running" | "completed" | "failed" | "cancelled";

export interface TaskContentRunSummary {
  runId: string;
  status: TaskContentRunStatus;
  taskKeys: string[];
}

export type TaskContentEvent =
  | {
      type: "task-content.status";
      runId: string;
      sequence: number;
      status: TaskContentRunStatus;
      taskKeys: string[];
      timestamp: string;
    }
  | {
      type: "task-content.delta";
      runId: string;
      sequence: number;
      taskKey: string;
      text: string;
      timestamp: string;
    }
  | {
      type: "task-content.task-completed";
      runId: string;
      sequence: number;
      taskKey: string;
      contentPath: string;
      timestamp: string;
    }
  | {
      type: "task-content.task-failed";
      runId: string;
      sequence: number;
      taskKey: string;
      message: string;
      timestamp: string;
    };

export type PlanningStatus = "starting" | "running" | "completed" | "failed" | "cancelled";

export type PlanningEvent =
  | {
      type: "planning.status";
      runId: string;
      sequence: number;
      status: PlanningStatus;
      runnerId: string;
      timestamp: string;
    }
  | {
      type: "planning.delta";
      runId: string;
      sequence: number;
      text: string;
      timestamp: string;
    }
  | {
      type: "planning.completed";
      runId: string;
      sequence: number;
      proposals: PlanningProposalSet;
      timestamp: string;
    }
  | {
      type: "planning.failed";
      runId: string;
      sequence: number;
      message: string;
      timestamp: string;
    };

export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AgentRunSpec {
  schemaVersion: "phaseatlas.run/v1";
  runId: string;
  taskKey: string;
  taskRevision: string;
  action: "analyze" | "plan" | "implement" | "review";
  repositoryPath: string;
  worktreePath?: string;
  branch?: string;
  objective: string;
  content?: TaskContent;
  contextDocuments: Array<{ path: string; revision?: string }>;
  scope: TaskScope;
  acceptanceCriteria: AcceptanceCriterion[];
  verification: VerificationStep[];
  sandbox: "read-only" | "workspace-write";
  createdAt: string;
}

export type AgentEvent =
  | { sequence: number; type: "run.status"; status: AgentRunStatus }
  | { sequence: number; type: "agent.delta"; text: string }
  | { sequence: number; type: "command.started"; commandId: string; command: string }
  | { sequence: number; type: "command.output"; commandId: string; text: string }
  | { sequence: number; type: "command.completed"; commandId: string; exitCode: number }
  | { sequence: number; type: "file.changed"; path: string; patch?: string }
  | { sequence: number; type: "turn.completed"; summary: string }
  | { sequence: number; type: "run.failed"; message: string };

export type RepositoryWorkerMethod =
  | "repository.describe"
  | "repository.refresh"
  | "workspace.list"
  | "task.snapshot"
  | "runner.list"
  | "planning.start"
  | "planning.cancel"
  | "task-content.start"
  | "task-content.list"
  | "task-content.cancel"
  | "task-content.save"
  | "file.list"
  | "file.read"
  | "file.save"
  | "proposal.publish";

export interface WorkerRequest {
  requestId: string;
  method: RepositoryWorkerMethod;
  params?: Record<string, unknown>;
}

export type WorkerResponse =
  | { requestId: string; result: unknown }
  | { requestId: string; error: { code: string; message: string } };

export interface WorkerEvent {
  type: "worker.ready" | "repository.changed" | "worker.warning" | "planning.event" | "task-content.event";
  payload: Record<string, unknown>;
}

export interface RepositoryChangedEvent {
  type: "repository.changed";
  checkoutId: string;
  paths: string[];
}

export interface PlanningDesktopEvent {
  type: "planning.event";
  checkoutId: string;
  event: PlanningEvent;
}

export interface TaskContentDesktopEvent {
  type: "task-content.event";
  checkoutId: string;
  event: TaskContentEvent;
}

export type PhaseAtlasDesktopEvent = RepositoryChangedEvent | PlanningDesktopEvent | TaskContentDesktopEvent;

export interface PhaseAtlasDesktopApi {
  repositories: {
    open(): Promise<RepositorySummary | null>;
    close(checkoutId: string): Promise<void>;
    list(): Promise<RepositorySummary[]>;
    refresh(checkoutId: string): Promise<RepositorySummary>;
  };
  workspaces: {
    list(checkoutId: string): Promise<WorkspaceSummary[]>;
  };
  tasks: {
    snapshot(checkoutId: string): Promise<TaskSnapshot>;
    listContentRuns(checkoutId: string): Promise<TaskContentRunSummary[]>;
    initializeContent(checkoutId: string, input: TaskContentStartInput): Promise<{ runId: string }>;
    cancelContent(checkoutId: string, runId: string): Promise<void>;
    saveContent(checkoutId: string, taskKey: string, body: string): Promise<TaskSnapshot>;
  };
  files: {
    list(checkoutId: string, directory?: string): Promise<RepositoryFileEntry[]>;
    read(checkoutId: string, path: string): Promise<RepositoryFileDocument>;
    save(checkoutId: string, path: string, content: string): Promise<void>;
  };
  runners: {
    list(checkoutId: string): Promise<RunnerDescriptor[]>;
  };
  planning: {
    start(checkoutId: string, input: PlanningStartInput): Promise<{ runId: string }>;
    cancel(checkoutId: string, runId: string): Promise<void>;
    publish(checkoutId: string, input: PlanningPublishInput): Promise<TaskSnapshot>;
  };
  events: {
    subscribe(listener: (event: PhaseAtlasDesktopEvent) => void): () => void;
  };
  runtime: {
    platform(): Promise<string>;
  };
}

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  return Boolean(value && typeof value === "object" && "requestId" in value);
}

export function isWorkerEvent(value: unknown): value is WorkerEvent {
  return Boolean(value && typeof value === "object" && "type" in value && !(
    "requestId" in value
  ));
}
