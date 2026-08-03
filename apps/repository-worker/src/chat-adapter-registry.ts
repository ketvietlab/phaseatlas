import type {
  RepositoryChatAdapterEvent,
  RepositoryChatMessage,
} from "@phaseatlas/contracts";
import {
  resolveCodexExecutable,
  runChildProcess,
  type ProviderProcessRunner,
} from "./runner-registry.js";

export interface RepositoryChatAdapterContext {
  repositoryRoot: string;
  model: string;
  messages: RepositoryChatMessage[];
  signal: AbortSignal;
  emit(event: RepositoryChatAdapterEvent): void;
}

export interface RepositoryChatAdapter {
  readonly runnerId: string;
  execute(context: RepositoryChatAdapterContext): Promise<string>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sanitizeText(value: string, privateValues: string[] = [], trim = true): string {
  let sanitized = value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").replaceAll("\0", "");
  for (const privateValue of privateValues.filter(Boolean).sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.replaceAll(privateValue, "<redacted>");
  }
  sanitized = sanitized
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization|cookie)\b\s*[:=]\s*[^\s]+/gi, "<credential:redacted>")
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'`]+/g, "<path>");
  const bounded = sanitized.slice(0, 16_000);
  return trim ? bounded.trim() : bounded;
}

function chatPrompt(messages: RepositoryChatMessage[]): string {
  const transcript = messages.slice(-50).map((message) => ({
    role: message.role,
    content: message.content.slice(0, 32_000),
    attachments: message.attachments.map((attachment) => attachment.path),
  }));
  return `You are a read-only repository assistant inside PhaseAtlas.

Answer the user's repository question using read-only inspection only. Never modify files, create
commits, change canonical PhaseAtlas tasks, promote evidence, or claim task completion. Do not expose
credentials, environment variables, absolute paths, process details, or provider-specific payloads.
Attachment paths are repository-relative references, not authorization to access other files.

Conversation transcript:
${JSON.stringify(transcript, null, 2)}`;
}

function safeTokenCount(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

class CodexChatAdapter implements RepositoryChatAdapter {
  readonly runnerId = "codex-cli";

  constructor(
    private readonly processRunner: ProviderProcessRunner,
    private readonly executableResolver: () => Promise<{ executable: string; version: string }>,
  ) {}

  async execute(context: RepositoryChatAdapterContext): Promise<string> {
    const { executable } = await this.executableResolver();
    const privateValues = [executable, context.repositoryRoot];
    const args = [
      "exec",
      "--sandbox", "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--color", "never",
      "--json",
      "--cd", context.repositoryRoot,
      "--model", context.model,
      "-",
    ];
    let buffer = "";
    let answer = "";
    let failure = "";
    let policyViolation = "";
    let toolCounter = 0;
    const toolIds = new Map<string, string>();
    const normalizedToolId = (providerId: string) => {
      const existing = toolIds.get(providerId);
      if (existing) return existing;
      const id = `tool-${++toolCounter}`;
      toolIds.set(providerId, id);
      return id;
    };
    const consume = (line: string) => {
      if (!line.trim() || context.signal.aborted) return;
      let event: Record<string, unknown>;
      try {
        const parsed = record(JSON.parse(line) as unknown);
        if (!parsed) return;
        event = parsed;
      } catch {
        return;
      }
      if (event.type === "turn.failed" || event.type === "error") {
        const error = record(event.error);
        failure = sanitizeText(
          typeof event.message === "string" ? event.message : typeof error?.message === "string" ? error.message : "Codex reported a failure.",
          privateValues,
        );
        return;
      }
      if (event.type === "turn.completed") {
        const usage = record(event.usage);
        const inputTokens = safeTokenCount(usage?.input_tokens);
        const outputTokens = safeTokenCount(usage?.output_tokens);
        if (inputTokens !== undefined || outputTokens !== undefined) {
          context.emit({
            type: "chat.usage",
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          });
        }
        return;
      }
      if (!["item.started", "item.updated", "item.completed"].includes(String(event.type))) return;
      const item = record(event.item);
      if (!item || typeof item.type !== "string") return;
      const completed = event.type === "item.completed";
      if (item.type === "agent_message" && completed && typeof item.text === "string") {
        const text = sanitizeText(item.text, privateValues);
        if (text) {
          answer = answer ? `${answer}\n${text}` : text;
          context.emit({ type: "chat.assistant.delta", text });
        }
        return;
      }
      if (item.type === "reasoning" && completed && typeof item.text === "string") {
        const summary = sanitizeText(item.text, privateValues);
        if (summary) context.emit({ type: "chat.reasoning", summary });
        return;
      }
      if (item.type === "command_execution") {
        const id = normalizedToolId(typeof item.id === "string" ? item.id : `command-${toolCounter + 1}`);
        const command = sanitizeText(typeof item.command === "string" ? item.command : "read-only repository command", privateValues);
        if (event.type === "item.started") {
          context.emit({ type: "chat.tool.started", toolCallId: id, tool: "command", summary: command });
        } else if (completed) {
          const output = sanitizeText(typeof item.aggregated_output === "string" ? item.aggregated_output : "", privateValues);
          if (output) context.emit({ type: "chat.tool.output", toolCallId: id, text: output });
          context.emit({
            type: "chat.tool.completed",
            toolCallId: id,
            status: Number.isInteger(item.exit_code) && Number(item.exit_code) !== 0 ? "failed" : "completed",
          });
        }
        return;
      }
      if (item.type === "mcp_tool_call") {
        const id = normalizedToolId(typeof item.id === "string" ? item.id : `mcp-${toolCounter + 1}`);
        const tool = sanitizeText(typeof item.tool === "string" ? item.tool : "tool", privateValues);
        policyViolation = `Provider requested unsupported ${tool || id} MCP tool in read-only chat mode.`;
        return;
      }
      if (item.type === "file_change") policyViolation = "Provider attempted a repository write in read-only chat mode.";
    };
    await this.processRunner({
      executable,
      args,
      cwd: context.repositoryRoot,
      stdin: chatPrompt(context.messages),
      signal: context.signal,
      onStdout: (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(consume);
      },
    });
    consume(buffer);
    if (policyViolation) throw new Error(policyViolation);
    if (failure) throw new Error(failure);
    if (!answer.trim()) throw new Error("Codex completed without a renderer-safe assistant message.");
    return answer.trim();
  }
}

class ClaudeChatAdapter implements RepositoryChatAdapter {
  readonly runnerId = "claude-code";

  constructor(private readonly processRunner: ProviderProcessRunner) {}

  async execute(context: RepositoryChatAdapterContext): Promise<string> {
    const executable = process.env.PHASEATLAS_CLAUDE_BIN || "claude";
    const privateValues = [executable, context.repositoryRoot];
    const args = [
      "--print",
      "--safe-mode",
      "--strict-mcp-config",
      "--mcp-config", "{}",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--permission-mode", "plan",
      "--tools", "Read,Glob,Grep",
      "--no-session-persistence",
      "--model", context.model,
    ];
    let buffer = "";
    let answer = "";
    let failure = "";
    let policyViolation = "";
    let toolCounter = 0;
    const toolIds = new Map<string, string>();
    const normalizedToolId = (providerId: string) => {
      const existing = toolIds.get(providerId);
      if (existing) return existing;
      const id = `tool-${++toolCounter}`;
      toolIds.set(providerId, id);
      return id;
    };
    const consume = (line: string) => {
      if (!line.trim() || context.signal.aborted) return;
      let event: Record<string, unknown>;
      try {
        const parsed = record(JSON.parse(line) as unknown);
        if (!parsed) return;
        event = parsed;
      } catch {
        return;
      }
      if (event.type === "stream_event") {
        const streamEvent = record(event.event);
        const delta = record(streamEvent?.delta);
        if (streamEvent?.type === "content_block_delta" && typeof delta?.text === "string") {
          const text = sanitizeText(delta.text, privateValues, false);
          if (text) {
            answer += text;
            context.emit({ type: "chat.assistant.delta", text });
          }
        }
        return;
      }
      if (event.type === "assistant") {
        const message = record(event.message);
        const content = Array.isArray(message?.content) ? message.content : [];
        for (const value of content) {
          const block = record(value);
          if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
          const tool = typeof block.name === "string" ? block.name : "tool";
          if (!["Read", "Glob", "Grep"].includes(tool)) {
            policyViolation = `Provider requested unsupported ${sanitizeText(tool, privateValues)} tool in read-only chat mode.`;
            continue;
          }
          context.emit({
            type: "chat.tool.started",
            toolCallId: normalizedToolId(block.id),
            tool: tool.toLowerCase(),
            summary: `${tool} repository context`,
          });
        }
        return;
      }
      if (event.type === "user") {
        const message = record(event.message);
        const content = Array.isArray(message?.content) ? message.content : [];
        for (const value of content) {
          const block = record(value);
          if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const id = normalizedToolId(block.tool_use_id);
          const output = sanitizeText(typeof block.content === "string" ? block.content : "", privateValues);
          if (output) context.emit({ type: "chat.tool.output", toolCallId: id, text: output });
          context.emit({ type: "chat.tool.completed", toolCallId: id, status: block.is_error === true ? "failed" : "completed" });
        }
        return;
      }
      if (event.type === "result") {
        if (!answer && typeof event.result === "string") {
          answer = sanitizeText(event.result, privateValues);
          if (answer) context.emit({ type: "chat.assistant.delta", text: answer });
        }
        if (event.is_error === true) failure = sanitizeText(typeof event.result === "string" ? event.result : "Claude reported a failure.", privateValues);
        const inputTokens = safeTokenCount(event.input_tokens);
        const outputTokens = safeTokenCount(event.output_tokens);
        if (inputTokens !== undefined || outputTokens !== undefined) {
          context.emit({
            type: "chat.usage",
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          });
        }
      }
    };
    await this.processRunner({
      executable,
      args,
      cwd: context.repositoryRoot,
      stdin: chatPrompt(context.messages),
      signal: context.signal,
      onStdout: (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(consume);
      },
    });
    consume(buffer);
    if (policyViolation) throw new Error(policyViolation);
    if (failure) throw new Error(failure);
    if (!answer.trim()) throw new Error("Claude completed without a renderer-safe assistant message.");
    return answer.trim();
  }
}

export class RepositoryChatAdapterRegistry {
  private readonly adapters: RepositoryChatAdapter[];

  constructor(options: {
    processRunner?: ProviderProcessRunner;
    codexExecutableResolver?: () => Promise<{ executable: string; version: string }>;
  } = {}) {
    const processRunner = options.processRunner ?? runChildProcess;
    this.adapters = [
      new CodexChatAdapter(processRunner, options.codexExecutableResolver ?? resolveCodexExecutable),
      new ClaudeChatAdapter(processRunner),
    ];
  }

  get(runnerId: string): RepositoryChatAdapter {
    const adapter = this.adapters.find((candidate) => candidate.runnerId === runnerId);
    if (!adapter) throw new Error(`Runner ${runnerId} does not support repository chat.`);
    return adapter;
  }
}
