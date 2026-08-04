import { randomUUID } from "node:crypto";
import type {
  PersistedRepositoryChatEvent,
  RepositoryChatCancellationResult,
  RepositoryChatCreateInput,
  RepositoryChatEventPage,
  RepositoryChatMessage,
  RepositoryChatRenameInput,
  RepositoryChatRetryInput,
  RepositoryChatSendInput,
  RepositoryChatSession,
  RepositoryChatTurn,
} from "@phaseatlas/contracts";
import {
  captureGitState,
  CheckoutOperationalStore,
} from "@phaseatlas/core";
import { assertRunnerSelection, type RunnerRegistry } from "./runner-registry.js";
import { RepositoryChatAdapterRegistry } from "./chat-adapter-registry.js";
import { safeChatAttachments } from "./chat-attachment-policy.js";

const TERMINAL_CHAT_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

function publicText(value: string, maxLength: number): string {
  const sanitized = value
    .replaceAll("\0", "")
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization|cookie)\b\s*[:=]\s*[^\s]+/gi, "<credential:redacted>")
    .trim();
  if (!sanitized) throw new Error("Chat text must not be empty.");
  if (sanitized.length > maxLength) throw new Error(`Chat text must not exceed ${maxLength} characters.`);
  return sanitized;
}

function failureText(value: unknown): string {
  const sanitized = String(value ?? "Repository chat failed.")
    .replaceAll("\0", "")
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization|cookie)\b\s*[:=]\s*[^\s]+/gi, "<credential:redacted>")
    .trim();
  return (sanitized || "Repository chat failed.").slice(0, 2_000);
}

function boundedId(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(normalized)) throw new Error(`${field} is invalid.`);
  return normalized;
}

interface ActiveTurn {
  controller: AbortController;
  completion: Promise<void>;
  cancellation?: Promise<RepositoryChatCancellationResult>;
}

export class RepositoryChatRuntime {
  private readonly activeTurns = new Map<string, ActiveTurn>();

  constructor(
    private readonly store: CheckoutOperationalStore,
    private readonly runners: RunnerRegistry,
    private readonly adapters: RepositoryChatAdapterRegistry,
    private readonly repositoryRoot: string,
    private readonly checkoutId: string,
    private readonly publish: (event: PersistedRepositoryChatEvent) => void = () => undefined,
  ) {}

  async createSession(input: RepositoryChatCreateInput): Promise<RepositoryChatSession> {
    const runnerId = boundedId(input.runnerId, "runnerId");
    const model = boundedId(input.model, "model");
    const reasoningEffort = input.reasoningEffort
      ? boundedId(input.reasoningEffort, "reasoningEffort")
      : undefined;
    await this.validateProvider(runnerId, model, reasoningEffort);
    this.adapters.get(runnerId);
    const timestamp = new Date().toISOString();
    return this.store.createChatSession({
      sessionId: randomUUID(),
      checkoutId: this.checkoutId,
      runnerId,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      title: input.title ? publicText(input.title, 120) : "New repository chat",
      state: "open",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  listSessions(): RepositoryChatSession[] {
    return this.store.listChatSessions();
  }

  getSession(sessionId: string): RepositoryChatSession {
    return this.store.getChatSession(boundedId(sessionId, "sessionId"));
  }

  renameSession(input: RepositoryChatRenameInput): RepositoryChatSession {
    return this.store.renameChatSession(
      boundedId(input.sessionId, "sessionId"),
      publicText(input.title, 120),
    );
  }

  closeSession(sessionId: string): RepositoryChatSession {
    return this.store.closeChatSession(boundedId(sessionId, "sessionId"));
  }

  listMessages(sessionId: string): RepositoryChatMessage[] {
    return this.store.listChatMessages(boundedId(sessionId, "sessionId"));
  }

  listTurns(sessionId: string): RepositoryChatTurn[] {
    return this.store.listChatTurns(boundedId(sessionId, "sessionId"));
  }

  eventPage(turnId: string, afterSequence = 0, limit = 200): RepositoryChatEventPage {
    return this.store.listChatEventPage(boundedId(turnId, "turnId"), afterSequence, limit);
  }

  async send(input: RepositoryChatSendInput): Promise<{ turnId: string }> {
    const session = this.store.getChatSession(boundedId(input.sessionId, "sessionId"));
    if (session.state !== "open") throw new Error("Chat session is closed.");
    await this.validateProvider(session.runnerId, session.model, session.reasoningEffort);
    const adapter = this.adapters.get(session.runnerId);
    const attachments = safeChatAttachments(input.attachments);
    const text = input.text.trim()
      ? publicText(input.text, 32_000)
      : attachments.length ? "Please inspect the attached context." : publicText(input.text, 32_000);
    const timestamp = new Date().toISOString();
    const turnId = randomUUID();
    const messageId = randomUUID();
    const userMessage: RepositoryChatMessage = {
      messageId,
      sessionId: session.sessionId,
      turnId,
      role: "user",
      content: text,
      attachments,
      sequence: this.store.nextChatMessageSequence(session.sessionId),
      createdAt: timestamp,
    };
    const turn: RepositoryChatTurn = {
      turnId,
      sessionId: session.sessionId,
      status: "starting",
      runnerId: session.runnerId,
      model: session.model,
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      userMessageId: messageId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.store.createChatTurn({ turn, userMessage });
    this.start(turnId, adapter);
    return { turnId };
  }

  async retry(input: RepositoryChatRetryInput): Promise<{ turnId: string }> {
    const previous = this.store.getChatTurn(boundedId(input.turnId, "turnId"));
    if (previous.status !== "interrupted") throw new Error("Only an interrupted chat turn can be retried.");
    const session = this.store.getChatSession(previous.sessionId);
    if (session.state !== "open") throw new Error("Chat session is closed.");
    await this.validateProvider(session.runnerId, session.model, session.reasoningEffort);
    const adapter = this.adapters.get(session.runnerId);
    const timestamp = new Date().toISOString();
    const turnId = randomUUID();
    this.store.createChatTurn({
      turn: {
        turnId,
        sessionId: session.sessionId,
        status: "starting",
        runnerId: session.runnerId,
        model: session.model,
        ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
        userMessageId: previous.userMessageId,
        parentTurnId: previous.turnId,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    this.start(turnId, adapter);
    return { turnId };
  }

  async cancel(turnIdValue: string): Promise<RepositoryChatCancellationResult> {
    const turnId = boundedId(turnIdValue, "turnId");
    const turn = this.store.getChatTurn(turnId);
    if (TERMINAL_CHAT_STATUSES.has(turn.status)) {
      return {
        turnId,
        status: turn.status as RepositoryChatCancellationResult["status"],
        disposition: "already_terminal",
      };
    }
    const active = this.activeTurns.get(turnId);
    if (!active) throw new Error("The chat provider process is not owned by this worker and requires retry recovery.");
    if (!active.cancellation) {
      active.controller.abort(new Error("Repository chat cancellation requested."));
      active.cancellation = active.completion.catch(() => undefined).then(() => {
        const terminal = this.store.getChatTurn(turnId);
        if (!TERMINAL_CHAT_STATUSES.has(terminal.status)) {
          throw new Error("Chat cancellation did not reach a durable terminal state.");
        }
        return {
          turnId,
          status: terminal.status as RepositoryChatCancellationResult["status"],
          disposition: terminal.status === "cancelled" ? "cancelled" as const : "already_terminal" as const,
        };
      });
    }
    return active.cancellation;
  }

  shutdown(): void {
    for (const active of this.activeTurns.values()) {
      active.controller.abort(new Error("Repository chat worker is stopping."));
    }
  }

  private start(turnId: string, adapter: ReturnType<RepositoryChatAdapterRegistry["get"]>): void {
    const controller = new AbortController();
    const entry: ActiveTurn = { controller, completion: Promise.resolve() };
    entry.completion = this.execute(turnId, adapter, controller.signal).finally(() => {
      if (this.activeTurns.get(turnId) === entry) this.activeTurns.delete(turnId);
    });
    this.activeTurns.set(turnId, entry);
    void entry.completion.catch(() => undefined);
  }

  private async execute(
    turnId: string,
    adapter: ReturnType<RepositoryChatAdapterRegistry["get"]>,
    signal: AbortSignal,
  ): Promise<void> {
    const turn = this.store.getChatTurn(turnId);
    const running = this.store.appendChatEvent({
      turnId,
      type: "chat.turn.status",
      payload: { status: "running" },
      status: "running",
    });
    this.publish(running);
    try {
      const baseline = await captureGitState({ worktreePath: this.repositoryRoot });
      const answer = await adapter.execute({
        repositoryRoot: this.repositoryRoot,
        model: turn.model,
        ...(turn.reasoningEffort ? { reasoningEffort: turn.reasoningEffort } : {}),
        messages: this.store.listChatMessages(turn.sessionId),
        signal,
        emit: (event) => {
          if (signal.aborted) return;
          const persisted = this.store.appendChatEvent({
            turnId,
            type: event.type,
            payload: Object.fromEntries(Object.entries(event).filter(([field]) => field !== "type")),
          });
          this.publish(persisted);
        },
      });
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Chat turn was cancelled.");
      if (baseline !== await captureGitState({ worktreePath: this.repositoryRoot })) {
        throw new Error("Repository changed during a read-only chat turn; the result was rejected.");
      }
      const timestamp = new Date().toISOString();
      const terminal = this.store.completeChatTurn({
        turnId,
        assistantMessage: {
          messageId: randomUUID(),
          sessionId: turn.sessionId,
          turnId,
          role: "assistant",
          content: publicText(answer, 64_000),
          attachments: [],
          sequence: this.store.nextChatMessageSequence(turn.sessionId),
          createdAt: timestamp,
        },
        timestamp,
      });
      if (terminal.event) this.publish(terminal.event);
    } catch (error) {
      const cancelled = signal.aborted;
      const message = cancelled
        ? "Repository chat was cancelled after provider exit."
        : failureText(error instanceof Error ? error.message : error);
      const terminal = this.store.terminalizeChatTurn({
        turnId,
        status: cancelled ? "cancelled" : "failed",
        type: cancelled ? "chat.turn.cancelled" : "chat.turn.failed",
        payload: { message },
      });
      if (terminal.event) this.publish(terminal.event);
      throw error;
    }
  }

  private async validateProvider(runnerId: string, model: string, reasoningEffort?: string): Promise<void> {
    const descriptor = await this.runners.get(runnerId).describe();
    if (!descriptor.available) throw new Error(descriptor.unavailableReason || `${descriptor.name} is unavailable.`);
    assertRunnerSelection(descriptor, model, reasoningEffort);
  }
}
