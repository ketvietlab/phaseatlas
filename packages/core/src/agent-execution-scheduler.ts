import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentRunCreateInput,
  AgentRunResult,
  AgentRunSpec,
  AgentSandbox,
  PersistedRunEvent,
  ValidatedAgentRunResult,
  WorktreeLeaseRecord,
} from "@phaseatlas/contracts";
import { createAgentRunSpec, deriveSandboxPolicy, resolveAgentRunTask } from "./agent-run-spec.js";
import { validateAgentRunResult } from "./agent-result-validator.js";
import type { CheckoutOperationalStore } from "./checkout-operational-store.js";
import { captureGitState, inspectGitChanges, type GitCommand } from "./git-change-inspector.js";
import type { RepositoryInspector } from "./repository-inspector.js";
import { WorktreeLeaseManager } from "./worktree-lease-manager.js";

type AgentEventWithoutSequence = AgentEvent extends infer Event
  ? Event extends { sequence: number } ? Omit<Event, "sequence"> : never
  : never;

export interface AgentExecutionAdapter {
  readonly supportedSandboxes: ReadonlyArray<AgentSandbox>;
  execute(context: {
    spec: AgentRunSpec;
    workingDirectory: string;
    modelId?: string;
    reasoningEffort?: string;
    signal: AbortSignal;
    emit(event: AgentEventWithoutSequence): void;
  }): Promise<unknown>;
}

export interface PreparedAgentRun {
  spec: AgentRunSpec;
  lease?: WorktreeLeaseRecord;
}

export class AgentExecutionScheduler {
  constructor(
    private readonly inspector: RepositoryInspector,
    private readonly store: CheckoutOperationalStore,
    readonly leases: WorktreeLeaseManager,
    private readonly changeGit?: GitCommand,
  ) {}

  async prepare(
    request: AgentRunCreateInput,
    provider: { runnerId: string; model?: string; reasoningEffort?: string } = { runnerId: "unassigned" },
  ): Promise<PreparedAgentRun> {
    const [repository, snapshot] = await Promise.all([this.inspector.describe(), this.inspector.taskSnapshot()]);
    const task = resolveAgentRunTask(request, snapshot);
    const taskKey = `${task.key.workspaceSlug}/${task.key.taskId}`;
    const sandbox = deriveSandboxPolicy(request, task);
    if (request.expectedCheckoutId && request.expectedCheckoutId !== repository.checkoutId) {
      throw new Error("Agent run request targets a different checkout.");
    }
    const runId = randomUUID();
    this.store.recordRun({ runId, kind: "agent", status: "starting", taskKeys: [taskKey] });
    let lease: WorktreeLeaseRecord | undefined;
    try {
      if (sandbox === "workspace-write") lease = await this.leases.acquire(runId);
      const spec = createAgentRunSpec({
        runId,
        request,
        repository,
        snapshot,
        ...(lease ? { lease } : {}),
        // Same task, same revision only: a result from a superseded contract is
        // not context, it is a stale claim.
        priorResults: this.store.listAgentResultsForTask(taskKey, task.revision)
          .filter((stage) => stage.action !== request.action),
      });
      this.store.recordAgentSpec({
        runId,
        taskKey: spec.taskKey,
        taskRevision: spec.taskRevision,
        action: spec.action,
        sandbox: spec.sandbox,
        checkoutId: spec.checkout.checkoutId,
        runnerId: provider.runnerId,
        ...(provider.model ? { model: provider.model } : {}),
        ...(provider.reasoningEffort ? { reasoningEffort: provider.reasoningEffort } : {}),
        createdAt: spec.createdAt,
      });
      this.store.appendEvent({
        runId,
        type: "agent.prepared",
        payload: {
          taskKey: spec.taskKey,
          taskRevision: spec.taskRevision,
          ...(spec.taskRegistry ? { taskRegistry: spec.taskRegistry } : {}),
          action: spec.action,
          sandbox: spec.sandbox,
          checkoutId: spec.checkout.checkoutId,
          ...(lease ? { leaseId: lease.leaseId } : {}),
        },
      });
      return { spec, ...(lease ? { lease } : {}) };
    } catch (error) {
      try {
        this.store.appendEvent({
          runId,
          type: "run.failed",
          payload: { message: error instanceof Error ? error.message : "Agent run preparation failed." },
          status: "failed",
        });
      } finally {
        if (lease) await this.leases.release(runId, "preparation_failed");
      }
      throw error;
    }
  }

  async execute(
    request: AgentRunCreateInput,
    adapter: AgentExecutionAdapter,
    signal: AbortSignal,
    onEvent: (event: PersistedRunEvent) => void = () => undefined,
  ): Promise<ValidatedAgentRunResult> {
    const prepared = await this.prepare(request, { runnerId: "embedded-adapter" });
    return this.executePrepared(prepared, adapter, signal, onEvent);
  }

  async executePrepared(
    prepared: PreparedAgentRun,
    adapter: AgentExecutionAdapter,
    signal: AbortSignal,
    onEvent: (event: PersistedRunEvent) => void = () => undefined,
    modelId?: string,
    reasoningEffort?: string,
  ): Promise<ValidatedAgentRunResult> {
    const { spec } = prepared;
    if (!adapter.supportedSandboxes.includes(spec.sandbox)) {
      await this.failAndCleanup(spec.runId, `Execution adapter cannot honor ${spec.sandbox}.`, onEvent);
      throw new Error(`Execution adapter cannot honor ${spec.sandbox}.`);
    }
    if (signal.aborted) {
      const terminal = this.store.terminalizeRun({
        runId: spec.runId,
        type: "run.cancelled",
        payload: { message: "Run cancelled before handoff." },
        status: "cancelled",
      });
      if (terminal.event) onEvent(terminal.event);
      if (prepared.lease) await this.leases.release(spec.runId, "cancelled_before_handoff");
      throw signal.reason instanceof Error ? signal.reason : new Error("Agent run was cancelled.");
    }
    let adapterTerminalEvent = false;
    const emit = (event: AgentEventWithoutSequence) => {
      const cancelled = event.type === "run.status" && event.status === "cancelled";
      if (event.type === "run.failed" || cancelled) {
        adapterTerminalEvent = true;
      }
      const payload = { ...event } as Record<string, unknown>;
      delete payload.type;
      const terminal = event.type === "run.failed"
        ? this.store.terminalizeRun({ runId: spec.runId, type: event.type, payload, status: "failed" })
        : cancelled
          ? this.store.terminalizeRun({ runId: spec.runId, type: "run.cancelled", payload, status: "cancelled" })
          : null;
      const persisted = terminal
        ? terminal.event
        : this.store.appendEvent({
          runId: spec.runId,
          type: event.type,
          payload,
          ...(event.type === "run.status" && event.status === "running" ? { status: "running" as const } : {}),
        });
      if (persisted) onEvent(persisted);
    };
    try {
      emit({ type: "run.status", status: "running" });
      const readOnlyBaseline = spec.sandbox === "read-only"
        ? await captureGitState({ worktreePath: spec.executionDirectory, ...(this.changeGit ? { git: this.changeGit } : {}) })
        : null;
      const rawResult = await adapter.execute({
        spec,
        workingDirectory: spec.executionDirectory,
        ...(modelId ? { modelId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        signal,
        emit,
      });
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Agent run was cancelled.");
      if (adapterTerminalEvent) {
        throw new Error(`Agent adapter terminalized the run as ${this.store.getRun(spec.runId).status}.`);
      }
      const result = validateAgentRunResult(rawResult);
      const readOnlyChanged = readOnlyBaseline !== null && readOnlyBaseline !== await captureGitState({
        worktreePath: spec.executionDirectory,
        ...(this.changeGit ? { git: this.changeGit } : {}),
      });
      const inspectedChanges = spec.sandbox === "workspace-write" || readOnlyChanged
        ? await inspectGitChanges({
          worktreePath: spec.executionDirectory,
          scope: spec.sandbox === "workspace-write" ? spec.scope : { ...spec.scope, writable: false },
          ...(this.changeGit ? { git: this.changeGit } : {}),
        })
        : [];
      const policyViolations = inspectedChanges.flatMap((change) =>
        change.policyViolations.map((violation) => `${change.path}: ${violation}`),
      );
      if (readOnlyChanged) policyViolations.push("read_only_checkout_modified");
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Agent run was cancelled.");
      const validated: ValidatedAgentRunResult = { result, inspectedChanges, policyViolations };
      this.store.recordAgentResult({
        runId: spec.runId,
        taskKey: spec.taskKey,
        taskRevision: spec.taskRevision,
        recordedAt: new Date().toISOString(),
        validated,
      });
      const terminalStatus = policyViolations.length || result.outcome === "failed" ? "failed" : "completed";
      const terminal = this.store.terminalizeRun({
        runId: spec.runId,
        type: "agent.result",
        payload: {
          status: terminalStatus,
          outcome: result.outcome,
          summary: result.summary,
          inspectedChanges,
          policyViolations,
          proposedTaskState: result.proposedTaskState ?? null,
          advisory: true,
        },
        status: terminalStatus,
      });
      if (terminal.event) onEvent(terminal.event);
      return validated;
    } catch (error) {
      if (!adapterTerminalEvent) {
        const terminal = this.store.terminalizeRun({
          runId: spec.runId,
          type: signal.aborted ? "run.cancelled" : "run.failed",
          payload: { message: error instanceof Error ? error.message : "Agent execution failed." },
          status: signal.aborted ? "cancelled" : "failed",
        });
        if (terminal.event) onEvent(terminal.event);
      }
      throw error;
    } finally {
      // A cancelled run produced nothing to act on, so its worktree goes. A run
      // that reached a terminal state keeps it: pushing it or opening a pull
      // request is the whole point of an implementation run.
      if (prepared.lease) {
        if (signal.aborted) await this.leases.release(spec.runId, "cancelled");
        else await this.leases.retain(spec.runId, "run_finished");
      }
    }
  }

  private async failAndCleanup(
    runId: string,
    message: string,
    onEvent: (event: PersistedRunEvent) => void,
  ): Promise<void> {
    const terminal = this.store.terminalizeRun({ runId, type: "run.failed", payload: { message }, status: "failed" });
    if (terminal.event) onEvent(terminal.event);
    await this.leases.release(runId, "adapter_rejected");
  }
}
