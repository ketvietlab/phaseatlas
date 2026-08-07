import taskProposalSchema from "../schemas/task-proposal.schema.json" with { type: "json" };
import taskContentSchema from "../schemas/task-content.schema.json" with { type: "json" };
import agentRunResultSchema from "../schemas/agent-run-result.schema.json" with { type: "json" };

export const TASK_PROPOSAL_SCHEMA = taskProposalSchema;
export const TASK_CONTENT_SCHEMA = taskContentSchema;
export const AGENT_RUN_RESULT_SCHEMA = agentRunResultSchema;

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
  runtime?: RepositoryRuntimeSummary;
}

export type RepositoryLifecycleState = "closed" | "starting" | "online" | "cooling" | "recovery_required";

export interface RepositoryRuntimeSummary {
  state: RepositoryLifecycleState;
  recoveryRequired: boolean;
  lastError?: string;
  updatedAt: string;
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
  line?: number;
  column?: number;
}

export type LegacySourceFormat = "markdown-checklist/v1";
export type LegacyCompletionHint = "open" | "completed";

export interface LegacySourceLocation {
  path: string;
  nativeId: string;
  line: number;
  column: 1;
}

export interface LegacyTaskCandidate {
  candidateId: string;
  sourceFormat: LegacySourceFormat;
  nativeId: string;
  title: string;
  objective: string;
  phaseId: string;
  completionHint: LegacyCompletionHint;
  provenance: {
    primary: LegacySourceLocation;
    identicalDuplicates: LegacySourceLocation[];
  };
  warnings: ValidationIssue[];
}

export interface LegacyIngestionSnapshot {
  candidates: LegacyTaskCandidate[];
  issues: ValidationIssue[];
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
  | "execution"
  | "streaming"
  | "structured_output"
  | "repository_read"
  | "repository_write"
  | "cancellation";

export interface RunnerModelDescriptor {
  id: string;
  displayName: string;
  isDefault: boolean;
  reasoningEfforts: string[];
  defaultReasoningEffort?: string;
}

export type RunnerModelDiscoveryStatus = "available" | "unavailable";

export interface RunnerDescriptor {
  id: string;
  provider: string;
  name: string;
  version?: string;
  available: boolean;
  unavailableReason?: string;
  capabilities: RunnerCapability[];
  models: RunnerModelDescriptor[];
  modelDiscovery: {
    status: RunnerModelDiscoveryStatus;
    unavailableReason?: string;
  };
  execution?: {
    actions: AgentRunAction[];
    sandboxes: AgentSandbox[];
  };
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
  reasoningEffort?: string;
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
  reasoningEffort?: string;
}

export type TaskContentRunStatus = "starting" | "running" | "completed" | "failed" | "cancelled";

export interface TaskContentRunSummary {
  runId: string;
  status: TaskContentRunStatus;
  taskKeys: string[];
}

export type PersistedRunKind = "planning" | "task_content" | "agent";
export type PersistedRunStatus = "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface PersistedRunRecord {
  runId: string;
  kind: PersistedRunKind;
  status: PersistedRunStatus;
  taskKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PersistedRunEvent {
  runId: string;
  sequence: number;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
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

export type AgentRunAction = "analyze" | "plan" | "implement" | "review";
export type AgentSandbox = "read-only" | "workspace-write";

export interface AgentRunCreateInput {
  taskKey: string;
  expectedTaskRevision?: string;
  expectedCheckoutId?: string;
  action: AgentRunAction;
  requestedSandbox?: AgentSandbox;
}

export interface AgentRunStartInput extends AgentRunCreateInput {
  runnerId: string;
  model?: string;
  reasoningEffort?: string;
}

export interface AgentRunActionQuery {
  taskKey: string;
  runnerId: string;
  model?: string;
  reasoningEffort?: string;
}

export interface AgentRunActionAvailability {
  action: AgentRunAction;
  sandbox: AgentSandbox;
  available: boolean;
  blockingReasons: string[];
}

export type AgentRunRecoveryDecision = "leave_interrupted" | "retry";

export interface AgentRunRecoveryInput {
  runId: string;
  decision: AgentRunRecoveryDecision;
  runnerId?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface AgentRunCancellationResult {
  runId: string;
  status: Extract<PersistedRunStatus, "completed" | "failed" | "cancelled" | "interrupted">;
  disposition: "cancelled" | "already_terminal";
}

export interface AgentRunRecoveryResult {
  originalRunId: string;
  decision: AgentRunRecoveryDecision;
  retryRunId?: string;
}

export interface AgentCheckoutIdentity {
  repositoryId: string;
  checkoutId: string;
  canonicalPath: string;
}

export type WorktreeLeaseStatus = "allocating" | "active" | "releasing" | "released" | "abandoned";

export interface WorktreeLeaseRecord {
  leaseId: string;
  runId: string;
  checkoutId: string;
  worktreePath: string;
  branch: string;
  status: WorktreeLeaseStatus;
  createdAt: string;
  updatedAt: string;
  recoveryReason?: string;
  disposition?: string;
}

export interface AgentRunStageResult {
  readonly runId: string;
  readonly action: AgentRunAction;
  readonly recordedAt: string;
  readonly result: ValidatedAgentRunResult;
}

export interface AgentRunSpec {
  readonly schemaVersion: "phaseatlas.run/v1";
  readonly runId: string;
  readonly taskKey: string;
  readonly taskRevision: string;
  readonly action: AgentRunAction;
  readonly checkout: AgentCheckoutIdentity;
  readonly lease?: WorktreeLeaseRecord;
  readonly executionDirectory: string;
  readonly objective: string;
  readonly content?: TaskContent;
  readonly contextDocuments: ReadonlyArray<{ path: string; revision?: string }>;
  readonly scope: TaskScope;
  readonly acceptanceCriteria: ReadonlyArray<AcceptanceCriterion>;
  readonly verification: ReadonlyArray<VerificationStep>;
  readonly sandbox: AgentSandbox;
  readonly priorResults: ReadonlyArray<AgentRunStageResult>;
  readonly createdAt: string;
}

export type AgentRunOutcome = "completed" | "partial" | "blocked" | "failed";
export type AgentFileChangeType = "added" | "modified" | "deleted";

export interface AgentRunResult {
  outcome: AgentRunOutcome;
  summary: string;
  changedFiles: Array<{ path: string; changeType: AgentFileChangeType }>;
  verification: Array<{ stepId: string; status: "passed" | "failed" | "not_run"; details: string }>;
  producedEvidence: Array<{
    type: "diff" | "test" | "commit" | "pull_request" | "document";
    reference: string;
  }>;
  blockers: string[];
  nextAction: string;
  requiresHumanReview: boolean;
  proposedTaskState: TaskState;
}

export interface InspectedAgentChange {
  path: string;
  changeType: AgentFileChangeType;
  policyViolations: string[];
}

export interface ValidatedAgentRunResult {
  result: AgentRunResult;
  inspectedChanges: InspectedAgentChange[];
  policyViolations: string[];
}

export type AgentResultFreshness = "current" | "stale" | "unverifiable";

export interface PersistedAgentRunResult {
  runId: string;
  taskKey: string;
  taskRevision: string;
  recordedAt: string;
  validated: ValidatedAgentRunResult;
}

export interface AgentResultRevalidationRecord {
  runId: string;
  taskRevision: string;
  outcome: "passed" | "failed";
  reviewer: string;
  recordedAt: string;
}

export interface AgentResultReview {
  persisted: PersistedAgentRunResult;
  freshness: AgentResultFreshness;
  currentTaskRevision?: string;
  revalidation?: AgentResultRevalidationRecord;
  promotable: boolean;
  reason?: string;
}

export interface AgentRunSummary {
  runId: string;
  taskKey: string;
  taskRevision: string;
  action: AgentRunAction;
  sandbox: AgentSandbox;
  runnerId: string;
  model?: string;
  reasoningEffort?: string;
  status: PersistedRunStatus;
  parentRunId?: string;
  freshness?: AgentResultFreshness;
  promotable?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedRunEventPage {
  runId: string;
  events: PersistedRunEvent[];
  afterSequence: number;
  nextSequence: number;
  hasMore: boolean;
}

export interface AgentRunCommandOutputPage {
  runId: string;
  commandId: string;
  offset: number;
  nextOffset: number;
  totalCharacters: number;
  hasMore: boolean;
  text: string;
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

export type TerminalSessionStatus = "running" | "exited";

export interface TerminalSessionSnapshot {
  sessionId: string;
  title: string;
  shell: string;
  cwd: string;
  status: TerminalSessionStatus;
  cols: number;
  rows: number;
  output: string;
  createdAt: string;
  exitCode?: number;
  exitSignal?: number;
}

export interface TerminalCreateInput {
  cols: number;
  rows: number;
}

export type TerminalEvent =
  | { type: "terminal.output"; sessionId: string; data: string; timestamp: string }
  | { type: "terminal.exited"; sessionId: string; exitCode: number; exitSignal?: number; timestamp: string }
  | { type: "terminal.closed"; sessionId: string; timestamp: string };

export type RepositoryChatSessionState = "open" | "closed";
export type RepositoryChatTurnStatus = "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type RepositoryChatMessageRole = "user" | "assistant";

export interface RepositoryChatPathAttachment {
  type?: "repository";
  path: string;
}

export type RepositoryChatImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface RepositoryChatImageAttachment {
  type: "image";
  name: string;
  mediaType: RepositoryChatImageMediaType;
  data: string;
}

export type RepositoryChatAttachment = RepositoryChatPathAttachment | RepositoryChatImageAttachment;

export interface RepositoryChatSession {
  sessionId: string;
  checkoutId: string;
  runnerId: string;
  model: string;
  reasoningEffort?: string;
  title: string;
  state: RepositoryChatSessionState;
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryChatMessage {
  messageId: string;
  sessionId: string;
  turnId?: string;
  role: RepositoryChatMessageRole;
  content: string;
  attachments: RepositoryChatAttachment[];
  sequence: number;
  createdAt: string;
}

export interface RepositoryChatTurn {
  turnId: string;
  sessionId: string;
  status: RepositoryChatTurnStatus;
  runnerId: string;
  model: string;
  reasoningEffort?: string;
  userMessageId: string;
  assistantMessageId?: string;
  parentTurnId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryChatCreateInput {
  runnerId: string;
  model: string;
  reasoningEffort?: string;
  title?: string;
}

export interface RepositoryChatRenameInput {
  sessionId: string;
  title: string;
}

export interface RepositoryChatProviderInput {
  sessionId: string;
  runnerId: string;
  model: string;
  reasoningEffort?: string;
}

export interface RepositoryChatSendInput {
  sessionId: string;
  text: string;
  attachments?: RepositoryChatAttachment[];
}

export interface RepositoryChatRetryInput {
  turnId: string;
}

export interface RepositoryChatCancellationResult {
  turnId: string;
  status: Extract<RepositoryChatTurnStatus, "completed" | "failed" | "cancelled" | "interrupted">;
  disposition: "cancelled" | "already_terminal";
}

export const CHAT_EDIT_ACCESS_MODES = ["ask_for_approval", "full_access"] as const;
export type ChatEditAccessMode = (typeof CHAT_EDIT_ACCESS_MODES)[number];

export interface ChatEditPrepareInput {
  sessionId: string;
  prompt: string;
  accessMode: ChatEditAccessMode;
  attachments?: RepositoryChatAttachment[];
}

export type ChatEditContextAttachment =
  | { type: "repository"; path: string }
  | { type: "image"; name: string; mediaType: RepositoryChatImageMediaType };

export interface ChatEditContextMessage {
  readonly role: RepositoryChatMessageRole;
  readonly content: string;
  readonly attachments: ChatEditContextAttachment[];
}

export interface ChatEditSpec {
  readonly schemaVersion: "phaseatlas.chat-edit/v1";
  readonly editId: string;
  readonly sessionId: string;
  readonly checkout: AgentCheckoutIdentity;
  readonly baseRevision: string;
  readonly runnerId: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly prompt: string;
  readonly conversationContext?: ChatEditContextMessage[];
  readonly accessMode: ChatEditAccessMode;
  readonly attachments: RepositoryChatAttachment[];
  readonly scope: TaskScope;
  readonly sandbox: "workspace-write";
  readonly createdAt: string;
  readonly confirmationDigest: string;
}

export interface ChatEditConfirmation {
  editId: string;
  repositoryId: string;
  checkoutId: string;
  repositoryName: string;
  baseRevision: string;
  runnerId: string;
  model: string;
  reasoningEffort?: string;
  accessMode: ChatEditAccessMode;
  scope: TaskScope;
  isolatedWorktree: true;
  reviewRequired: true;
  confirmationDigest: string;
}

export interface ChatEditStartInput {
  editId: string;
  confirmationDigest: string;
}

export type ChatEditDisposition = "pending_review" | "accepted" | "discarded" | "retained";

export interface ChatEditResult {
  editId: string;
  status: "awaiting_confirmation" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  disposition: ChatEditDisposition;
  summary: string;
  changedFiles: InspectedAgentChange[];
  patch: string;
  patchTruncated: boolean;
  verification: Array<{ label: string; status: "passed" | "failed" | "not_run"; details: string }>;
  blockers: string[];
  nextAction: string;
  runnerId: string;
  model: string;
  reasoningEffort?: string;
  baseRevision: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatEditCancellationResult {
  editId: string;
  disposition: "cancelled" | "already_terminal";
}

export interface ChatEditRecoveryInput {
  editId: string;
  decision: "resume_review" | "discard";
}

export type RepositoryChatAdapterEvent =
  | { type: "chat.turn.status"; status: "running" }
  | { type: "chat.assistant.delta"; text: string }
  | { type: "chat.reasoning"; itemId?: string; summary: string; status?: "running" | "completed" }
  | { type: "chat.tool.started"; toolCallId: string; tool: string; summary: string }
  | {
      type: "chat.tool.completed";
      toolCallId: string;
      status: "completed" | "failed";
      outputBytes?: number;
      outputHidden?: true;
    }
  | { type: "chat.file.reference"; path: string }
  | { type: "chat.usage"; inputTokens?: number; outputTokens?: number };

export type RepositoryChatEventType = RepositoryChatAdapterEvent["type"]
  | "chat.tool.output"
  | "chat.turn.completed"
  | "chat.turn.failed"
  | "chat.turn.cancelled"
  | "chat.turn.interrupted";

export interface PersistedRepositoryChatEvent {
  turnId: string;
  sequence: number;
  type: RepositoryChatEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface RepositoryChatEventPage {
  turnId: string;
  events: PersistedRepositoryChatEvent[];
  afterSequence: number;
  nextSequence: number;
  hasMore: boolean;
}

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
  | "run.list"
  | "run.events"
  | "run.events-page"
  | "agent-run.prepare"
  | "agent-run.actions"
  | "agent-run.list"
  | "agent-run.command-output"
  | "agent-run.start"
  | "agent-run.cancel"
  | "agent-run.result"
  | "agent-run.recover"
  | "agent-run.leases"
  | "agent-run.release"
  | "terminal.list"
  | "terminal.create"
  | "terminal.write"
  | "terminal.resize"
  | "terminal.close"
  | "chat.session.create"
  | "chat.session.list"
  | "chat.session.get"
  | "chat.session.rename"
  | "chat.session.provider"
  | "chat.session.close"
  | "chat.message.list"
  | "chat.turn.list"
  | "chat.turn.send"
  | "chat.turn.events"
  | "chat.turn.cancel"
  | "chat.turn.retry"
  | "chat.edit.prepare"
  | "chat.edit.list"
  | "chat.edit.start"
  | "chat.edit.events"
  | "chat.edit.result"
  | "chat.edit.cancel"
  | "chat.edit.accept"
  | "chat.edit.discard"
  | "chat.edit.retain"
  | "chat.edit.recover"
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
  type: "worker.ready" | "repository.changed" | "worker.warning" | "planning.event" | "task-content.event" | "agent-run.event" | "terminal.event" | "chat.turn.event" | "chat.edit.event" | "lease.recovery";
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

export interface AgentRunDesktopEvent {
  type: "agent-run.event";
  checkoutId: string;
  runId: string;
  event: PersistedRunEvent;
}

export interface TerminalDesktopEvent {
  type: "terminal.event";
  checkoutId: string;
  event: TerminalEvent;
}

export interface RepositoryChatDesktopEvent {
  type: "chat.turn.event";
  checkoutId: string;
  turnId: string;
  event: PersistedRepositoryChatEvent;
}

export interface ChatEditDesktopEvent {
  type: "chat.edit.event";
  checkoutId: string;
  editId: string;
  event: PersistedRunEvent;
}

export type PhaseAtlasDesktopEvent =
  | RepositoryChangedEvent
  | PlanningDesktopEvent
  | TaskContentDesktopEvent
  | AgentRunDesktopEvent
  | TerminalDesktopEvent
  | RepositoryChatDesktopEvent
  | ChatEditDesktopEvent;

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
  agentRuns: {
    actions(checkoutId: string, input: AgentRunActionQuery): Promise<AgentRunActionAvailability[]>;
    list(checkoutId: string, taskKey?: string): Promise<AgentRunSummary[]>;
    start(checkoutId: string, input: AgentRunStartInput): Promise<{ runId: string }>;
    cancel(checkoutId: string, runId: string): Promise<AgentRunCancellationResult>;
    events(checkoutId: string, runId: string, afterSequence?: number, limit?: number): Promise<PersistedRunEventPage>;
    commandOutput(checkoutId: string, runId: string, commandId: string, offset?: number, limit?: number): Promise<AgentRunCommandOutputPage>;
    result(checkoutId: string, runId: string): Promise<AgentResultReview>;
    recover(checkoutId: string, input: AgentRunRecoveryInput): Promise<AgentRunRecoveryResult>;
  };
  terminals: {
    list(checkoutId: string): Promise<TerminalSessionSnapshot[]>;
    create(checkoutId: string, input: TerminalCreateInput): Promise<TerminalSessionSnapshot>;
    write(checkoutId: string, sessionId: string, data: string): Promise<void>;
    resize(checkoutId: string, sessionId: string, cols: number, rows: number): Promise<void>;
    close(checkoutId: string, sessionId: string): Promise<void>;
  };
  chat: {
    createSession(checkoutId: string, input: RepositoryChatCreateInput): Promise<RepositoryChatSession>;
    listSessions(checkoutId: string): Promise<RepositoryChatSession[]>;
    getSession(checkoutId: string, sessionId: string): Promise<RepositoryChatSession>;
    renameSession(checkoutId: string, input: RepositoryChatRenameInput): Promise<RepositoryChatSession>;
    setSessionProvider(checkoutId: string, input: RepositoryChatProviderInput): Promise<RepositoryChatSession>;
    closeSession(checkoutId: string, sessionId: string): Promise<RepositoryChatSession>;
    listMessages(checkoutId: string, sessionId: string): Promise<RepositoryChatMessage[]>;
    listTurns(checkoutId: string, sessionId: string): Promise<RepositoryChatTurn[]>;
    send(checkoutId: string, input: RepositoryChatSendInput): Promise<{ turnId: string }>;
    events(checkoutId: string, turnId: string, afterSequence?: number, limit?: number): Promise<RepositoryChatEventPage>;
    cancel(checkoutId: string, turnId: string): Promise<RepositoryChatCancellationResult>;
    retry(checkoutId: string, input: RepositoryChatRetryInput): Promise<{ turnId: string }>;
    prepareEdit(checkoutId: string, input: ChatEditPrepareInput): Promise<ChatEditConfirmation>;
    listEdits(checkoutId: string, sessionId?: string): Promise<ChatEditResult[]>;
    startEdit(checkoutId: string, input: ChatEditStartInput): Promise<{ editId: string }>;
    editEvents(checkoutId: string, editId: string, afterSequence?: number, limit?: number): Promise<PersistedRunEventPage>;
    editResult(checkoutId: string, editId: string): Promise<ChatEditResult>;
    cancelEdit(checkoutId: string, editId: string): Promise<ChatEditCancellationResult>;
    acceptEdit(checkoutId: string, editId: string): Promise<ChatEditResult>;
    discardEdit(checkoutId: string, editId: string): Promise<ChatEditResult>;
    retainEdit(checkoutId: string, editId: string): Promise<ChatEditResult>;
    recoverEdit(checkoutId: string, input: ChatEditRecoveryInput): Promise<ChatEditResult>;
  };
  events: {
    subscribe(listener: (event: PhaseAtlasDesktopEvent) => void): () => void;
  };
  runtime: {
    platform(): Promise<string>;
    onCloseSurface(listener: () => void): () => void;
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
