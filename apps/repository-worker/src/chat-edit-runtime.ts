import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type {
  ChatEditCancellationResult,
  ChatEditAccessMode,
  ChatEditContextMessage,
  ChatEditConfirmation,
  ChatEditPrepareInput,
  ChatEditResult,
  ChatEditSpec,
  ChatEditStartInput,
  PersistedRunEvent,
  PersistedRunEventPage,
  TaskScope,
  RepositorySummary,
  RepositoryChatAttachment,
  RepositoryChatMessage,
  RunnerDescriptor,
} from "@phaseatlas/contracts";
import {
  CheckoutOperationalStore,
  inspectGitChanges,
  type WorktreeLeaseManager,
} from "@phaseatlas/core";
import { assertRunnerSelection } from "./runner-registry.js";
import type { ChatEditAdapter } from "./chat-edit-adapter-registry.js";
import { safeChatAttachments } from "./chat-attachment-policy.js";

const execFileAsync = promisify(execFile);
const MAX_PATCH = 500_000;
const MAX_CONTEXT_MESSAGES = 50;
const MAX_CONTEXT_CHARACTERS = 64_000;
const ACCESS_MODES = new Set<ChatEditAccessMode>(["ask_for_approval", "full_access"]);

type Git = (args: string[], cwd: string) => Promise<string>;
const defaultGit: Git = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 12 * 1024 * 1024 });
  return stdout;
};

interface ActiveEdit {
  controller: AbortController;
  completion: Promise<void>;
}

interface ChatEditInspector { describe(): Promise<RepositorySummary> }
interface ChatEditRunners { list(): Promise<RunnerDescriptor[]> }
interface ChatEditAdapters { get(runnerId: string): ChatEditAdapter }

function safeId(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(normalized)) throw new Error(`${field} is invalid.`);
  return normalized;
}

function parseSpec(event: PersistedRunEvent): ChatEditSpec {
  const spec = event.payload.spec as ChatEditSpec | undefined;
  if (!spec || spec.schemaVersion !== "phaseatlas.chat-edit/v1" || spec.editId !== event.runId) {
    throw new Error("Chat edit specification is unavailable or invalid.");
  }
  return spec;
}

function eventPayload(events: PersistedRunEvent[], type: string): Record<string, unknown> | null {
  return [...events].reverse().find((event) => event.type === type)?.payload ?? null;
}

function failureText(error: unknown): string {
  return String(error instanceof Error ? error.message : error || "Chat edit failed.")
    .replaceAll("\0", "")
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization|cookie)\b\s*[:=]\s*[^\s]+/gi, "<credential:redacted>")
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s\"'`]+/g, "<path>")
    .slice(0, 2_000);
}

function conversationContext(messages: RepositoryChatMessage[]): ChatEditContextMessage[] {
  const selected: ChatEditContextMessage[] = [];
  let remaining = MAX_CONTEXT_CHARACTERS;
  for (let index = messages.length - 1; index >= 0 && selected.length < MAX_CONTEXT_MESSAGES && remaining > 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const content = message.content.slice(0, remaining);
    if (!content) continue;
    selected.unshift({
      role: message.role,
      content,
      attachments: message.attachments.map((attachment) => attachment.type === "image"
        ? { type: "image", name: attachment.name, mediaType: attachment.mediaType }
        : { type: "repository", path: attachment.path }),
    });
    remaining -= content.length;
  }
  return selected;
}

function contextualAttachments(messages: RepositoryChatMessage[], explicit: RepositoryChatAttachment[]): RepositoryChatAttachment[] {
  let selected = explicit;
  for (let messageIndex = messages.length - 1; messageIndex >= 0 && selected.length < 12; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message) continue;
    for (let attachmentIndex = message.attachments.length - 1; attachmentIndex >= 0 && selected.length < 12; attachmentIndex -= 1) {
      const attachment = message.attachments[attachmentIndex];
      if (!attachment) continue;
      try {
        selected = safeChatAttachments([...selected, attachment]);
      } catch {
        // Explicit attachments take priority when historical images exceed current limits.
      }
    }
  }
  return selected;
}

export class ChatEditRuntime {
  private readonly active = new Map<string, ActiveEdit>();

  constructor(
    private readonly store: CheckoutOperationalStore,
    private readonly inspector: ChatEditInspector,
    private readonly leases: WorktreeLeaseManager,
    private readonly runners: ChatEditRunners,
    private readonly adapters: ChatEditAdapters,
    private readonly repositoryRoot: string,
    private readonly checkoutId: string,
    private readonly publish: (editId: string, event: PersistedRunEvent) => void = () => undefined,
    private readonly git: Git = defaultGit,
  ) {}

  async prepare(input: ChatEditPrepareInput): Promise<ChatEditConfirmation> {
    const sessionId = safeId(input.sessionId, "sessionId");
    const session = this.store.getChatSession(sessionId);
    if (session.state !== "open") throw new Error("Chat edit requires an open session.");
    const prompt = String(input.prompt ?? "").replaceAll("\0", "").trim();
    if (!prompt || prompt.length > 32_000) throw new Error("Chat edit prompt must contain 1 to 32000 characters.");
    if (!ACCESS_MODES.has(input.accessMode)) throw new Error("Chat edit access mode is invalid.");
    const messages = this.store.listChatMessages(sessionId);
    const context = conversationContext(messages);
    const attachments = contextualAttachments(messages, safeChatAttachments(input.attachments));
    const descriptor = (await this.runners.list()).find((candidate) => candidate.id === session.runnerId);
    if (!descriptor?.available) throw new Error("The selected provider is unavailable.");
    assertRunnerSelection(descriptor, session.model, session.reasoningEffort);
    this.adapters.get(session.runnerId);
    const repository = await this.inspector.describe();
    if (repository.checkoutId !== this.checkoutId) throw new Error("Repository checkout identity changed.");
    const baseRevision = (await this.git(["rev-parse", "HEAD"], this.repositoryRoot)).trim();
    const editId = randomUUID();
    const createdAt = new Date().toISOString();
    const scope: TaskScope = {
      allowedPaths: ["**"],
      forbiddenPaths: [".git", ".phaseatlas"],
      writable: true,
      allowDependencyChanges: true,
      allowDatabaseMigrations: true,
      allowExternalNetwork: false,
    };
    const confirmationMaterial = JSON.stringify({
      editId,
      sessionId,
      checkoutId: this.checkoutId,
      baseRevision,
      runnerId: session.runnerId,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      accessMode: input.accessMode,
      conversationContext: context,
      attachments,
      scope,
    });
    const confirmationDigest = createHash("sha256").update(confirmationMaterial).digest("hex");
    const spec: ChatEditSpec = {
      schemaVersion: "phaseatlas.chat-edit/v1",
      editId,
      sessionId,
      checkout: { repositoryId: repository.id, checkoutId: repository.checkoutId, canonicalPath: repository.path },
      baseRevision,
      runnerId: session.runnerId,
      model: session.model,
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      prompt,
      conversationContext: context,
      accessMode: input.accessMode,
      attachments,
      scope,
      sandbox: "workspace-write",
      createdAt,
      confirmationDigest,
    };
    this.store.recordRun({ runId: editId, kind: "agent", status: "starting", taskKeys: [] });
    const prepared = this.store.appendEvent({ runId: editId, type: "chat.edit.prepared", payload: { spec } });
    this.emit(editId, prepared);
    return {
      editId,
      repositoryId: repository.id,
      checkoutId: repository.checkoutId,
      repositoryName: repository.name,
      baseRevision,
      runnerId: session.runnerId,
      model: session.model,
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      accessMode: input.accessMode,
      scope,
      isolatedWorktree: true,
      reviewRequired: true,
      confirmationDigest,
    };
  }

  list(sessionId?: string): ChatEditResult[] {
    return this.store.listRuns()
      .filter((run) => run.kind === "agent" && run.taskKeys.length === 0)
      .map((run) => this.result(run.runId))
      .filter((result) => !sessionId || this.spec(result.editId).sessionId === sessionId);
  }

  async start(input: ChatEditStartInput): Promise<{ editId: string }> {
    const editId = safeId(input.editId, "editId");
    if (this.active.has(editId)) throw new Error("Chat edit is already running.");
    const spec = this.spec(editId);
    if (input.confirmationDigest !== spec.confirmationDigest) throw new Error("Chat edit confirmation is stale or incomplete.");
    if (this.store.getRun(editId).status !== "starting") throw new Error("Chat edit cannot be started from its current state.");
    const currentBase = (await this.git(["rev-parse", "HEAD"], this.repositoryRoot)).trim();
    if (currentBase !== spec.baseRevision) throw new Error("Repository base changed; prepare and review the edit scope again.");
    const descriptor = (await this.runners.list()).find((candidate) => candidate.id === spec.runnerId);
    if (!descriptor?.available) throw new Error("The confirmed provider is unavailable.");
    assertRunnerSelection(descriptor, spec.model, spec.reasoningEffort);
    const adapter = this.adapters.get(spec.runnerId);
    const controller = new AbortController();
    const completion = this.execute(spec, adapter, controller);
    this.active.set(editId, { controller, completion });
    void completion.catch(() => undefined).finally(() => this.active.delete(editId));
    return { editId };
  }

  events(editId: string, afterSequence = 0, limit = 200): PersistedRunEventPage {
    const page = this.store.listEventsPage(safeId(editId, "editId"), afterSequence, limit);
    return { ...page, events: page.events.map((event) => this.publicEvent(event)) };
  }

  result(editId: string): ChatEditResult {
    const spec = this.spec(safeId(editId, "editId"));
    const run = this.store.getRun(editId);
    const events = this.store.listEvents(editId);
    const completed = eventPayload(events, "chat.edit.result");
    const failed = eventPayload(events, "chat.edit.failed");
    const dispositionEvent = [...events].reverse().find((event) => event.type.startsWith("chat.edit.audit."));
    const disposition = dispositionEvent?.type.endsWith("accepted") ? "accepted"
      : dispositionEvent?.type.endsWith("discarded") ? "discarded"
        : dispositionEvent?.type.endsWith("retained") ? "retained" : "pending_review";
    const status = run.status === "starting" ? "awaiting_confirmation" : run.status;
    return {
      editId,
      status,
      disposition,
      summary: typeof completed?.summary === "string" ? completed.summary : typeof failed?.message === "string" ? failed.message : "Waiting for explicit edit confirmation.",
      changedFiles: Array.isArray(completed?.changedFiles) ? completed.changedFiles as ChatEditResult["changedFiles"] : [],
      patch: typeof completed?.patch === "string" ? completed.patch : "",
      patchTruncated: completed?.patchTruncated === true,
      verification: Array.isArray(completed?.verification) ? completed.verification as ChatEditResult["verification"] : [],
      blockers: Array.isArray(completed?.blockers) ? completed.blockers as string[] : [],
      nextAction: typeof completed?.nextAction === "string" ? completed.nextAction : "Confirm the bounded edit attempt.",
      runnerId: spec.runnerId,
      model: spec.model,
      ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
      baseRevision: spec.baseRevision,
      createdAt: spec.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  async cancel(editId: string): Promise<ChatEditCancellationResult> {
    const normalized = safeId(editId, "editId");
    const active = this.active.get(normalized);
    if (!active) {
      if (this.store.getRun(normalized).status !== "starting") {
        return { editId: normalized, disposition: "already_terminal" };
      }
      const terminal = this.store.terminalizeRun({
        runId: normalized,
        type: "chat.edit.cancelled",
        payload: { reason: "approval_cancelled" },
        status: "cancelled",
      });
      if (terminal.event) this.emit(normalized, terminal.event);
      return { editId: normalized, disposition: "cancelled" };
    }
    active.controller.abort(new Error("Chat edit cancelled by user."));
    await active.completion.catch(() => undefined);
    return { editId: normalized, disposition: "cancelled" };
  }

  async accept(editId: string): Promise<ChatEditResult> {
    const normalized = safeId(editId, "editId");
    const result = this.assertReviewable(normalized);
    if (result.blockers.length) throw new Error("Blocked chat edits cannot be accepted.");
    const spec = this.spec(normalized);
    const lease = this.activeLease(normalized);
    const [base, status] = await Promise.all([
      this.git(["rev-parse", "HEAD"], this.repositoryRoot),
      this.git(["status", "--porcelain"], this.repositoryRoot),
    ]);
    if (base.trim() !== spec.baseRevision || status.trim()) throw new Error("Canonical checkout changed; retain the edit and review it against the new base.");
    await this.git(["add", "-A"], lease.worktreePath);
    const staged = await this.git(["diff", "--cached", "--name-only"], lease.worktreePath);
    if (!staged.trim()) throw new Error("The edit has no changes to accept.");
    await this.git(["-c", "user.name=PhaseAtlas", "-c", "user.email=phaseatlas@local", "commit", "-m", `Apply reviewed chat edit ${normalized.slice(0, 8)}`], lease.worktreePath);
    const commit = (await this.git(["rev-parse", "HEAD"], lease.worktreePath)).trim();
    try {
      await this.git(["cherry-pick", commit], this.repositoryRoot);
    } catch (error) {
      await this.git(["cherry-pick", "--abort"], this.repositoryRoot).catch(() => "");
      throw new Error(`Chat edit could not be integrated cleanly: ${failureText(error)}`);
    }
    const event = this.store.appendEvent({ runId: normalized, type: "chat.edit.audit.accepted", payload: { commit } });
    this.emit(normalized, event);
    await this.leases.release(normalized, "accepted");
    return this.result(normalized);
  }

  async discard(editId: string): Promise<ChatEditResult> {
    const normalized = safeId(editId, "editId");
    this.assertReviewable(normalized);
    const event = this.store.appendEvent({ runId: normalized, type: "chat.edit.audit.discarded", payload: {} });
    this.emit(normalized, event);
    await this.leases.release(normalized, "discarded");
    return this.result(normalized);
  }

  retain(editId: string): ChatEditResult {
    const normalized = safeId(editId, "editId");
    this.assertReviewable(normalized);
    const event = this.store.appendEvent({ runId: normalized, type: "chat.edit.audit.retained", payload: { recoveryRequired: true } });
    this.emit(normalized, event);
    return this.result(normalized);
  }

  async recover(editId: string, decision: "resume_review" | "discard"): Promise<ChatEditResult> {
    const normalized = safeId(editId, "editId");
    const result = this.result(normalized);
    if (result.status !== "completed") throw new Error("Only completed retained edits can be recovered for review.");
    const lease = this.leases.list().find((candidate) => candidate.runId === normalized);
    if (!lease || !["active", "abandoned"].includes(lease.status) || result.disposition !== "retained") {
      throw new Error("Chat edit does not require worktree recovery.");
    }
    if (lease.status === "abandoned") {
      await this.leases.recoverAbandoned(normalized, decision === "resume_review" ? "resume" : "discard");
    } else if (decision === "discard") {
      await this.leases.release(normalized, "recovery_discarded");
    }
    const event = this.store.appendEvent({
      runId: normalized,
      type: decision === "resume_review" ? "chat.edit.audit.recovered" : "chat.edit.audit.discarded",
      payload: { recovery: true },
    });
    this.emit(normalized, event);
    return this.result(normalized);
  }

  private async execute(spec: ChatEditSpec, adapter: ChatEditAdapter, controller: AbortController): Promise<void> {
    let lease;
    try {
      lease = await this.leases.acquire(spec.editId);
      const running = this.store.appendEvent({ runId: spec.editId, type: "chat.edit.running", payload: { leaseId: lease.leaseId }, status: "running" });
      this.emit(spec.editId, running);
      const summary = await adapter.execute({
        spec,
        workingDirectory: lease.worktreePath,
        signal: controller.signal,
        emit: (type, payload) => {
          const event = this.store.appendEvent({ runId: spec.editId, type, payload });
          this.emit(spec.editId, event);
        },
      });
      const changedFiles = await inspectGitChanges({ worktreePath: lease.worktreePath, scope: spec.scope });
      const policyViolations = changedFiles.flatMap((change) => change.policyViolations.map((violation) => `${change.path}: ${violation}`));
      if (!changedFiles.length) policyViolations.push("no_repository_changes");
      const untracked = changedFiles.filter((change) => change.changeType === "added").map((change) => change.path);
      if (untracked.length) await this.git(["add", "-N", "--", ...untracked], lease.worktreePath);
      const rawPatch = await this.git(["diff", "--binary", "HEAD"], lease.worktreePath);
      const patch = rawPatch.slice(0, MAX_PATCH);
      const payload = {
        summary,
        changedFiles,
        patch,
        patchTruncated: rawPatch.length > MAX_PATCH,
        verification: [
          {
            label: "Git change inspection",
            status: changedFiles.length ? "passed" : "failed",
            details: changedFiles.length ? `${changedFiles.length} repository changes derived from Git.` : "No repository changes were detected.",
          },
          {
            label: "Confirmed scope policy",
            status: policyViolations.length ? "failed" : "passed",
            details: policyViolations.length ? `${policyViolations.length} blocking policy violations.` : "All changed paths satisfy the confirmed scope.",
          },
        ],
        blockers: policyViolations,
        nextAction: policyViolations.length ? "Discard or retain this blocked attempt for inspection." : "Review the diff, then accept, discard, or retain it.",
      };
      const terminal = this.store.terminalizeRun({ runId: spec.editId, type: "chat.edit.result", payload, status: "completed" });
      if (terminal.event) this.emit(spec.editId, terminal.event);
    } catch (error) {
      const status = controller.signal.aborted ? "cancelled" : "failed";
      const terminal = this.store.terminalizeRun({ runId: spec.editId, type: "chat.edit.failed", payload: { message: failureText(error) }, status });
      if (terminal.event) this.emit(spec.editId, terminal.event);
      if (lease) await this.leases.release(spec.editId, status).catch(() => undefined);
      throw error;
    }
  }

  private spec(editId: string): ChatEditSpec {
    const prepared = this.store.listEvents(editId).find((event) => event.type === "chat.edit.prepared");
    if (!prepared) throw new Error("Chat edit does not exist.");
    return parseSpec(prepared);
  }

  private emit(editId: string, event: PersistedRunEvent): void {
    this.publish(editId, this.publicEvent(event));
  }

  private publicEvent(event: PersistedRunEvent): PersistedRunEvent {
    if (event.type === "chat.edit.prepared") {
      const spec = parseSpec(event);
      return {
        ...event,
        payload: {
          status: "awaiting_confirmation",
          sessionId: spec.sessionId,
          repositoryId: spec.checkout.repositoryId,
          checkoutId: spec.checkout.checkoutId,
          baseRevision: spec.baseRevision,
          runnerId: spec.runnerId,
          model: spec.model,
          ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
          accessMode: spec.accessMode,
          scope: spec.scope,
        },
      };
    }
    if (event.type.startsWith("lease.")) {
      return {
        ...event,
        payload: {
          leaseId: event.payload.leaseId,
          status: event.type.slice("lease.".length),
          ...(typeof event.payload.disposition === "string" ? { disposition: event.payload.disposition } : {}),
        },
      };
    }
    return event;
  }

  private assertReviewable(editId: string): ChatEditResult {
    if (this.active.has(editId)) throw new Error("Wait for the edit attempt to finish.");
    const result = this.result(editId);
    if (result.status !== "completed" || result.disposition !== "pending_review") throw new Error("Chat edit is not awaiting review.");
    return result;
  }

  private activeLease(editId: string) {
    const lease = this.leases.list().find((candidate) => candidate.runId === editId && candidate.status === "active");
    if (!lease) throw new Error("Chat edit worktree requires recovery.");
    return lease;
  }
}
