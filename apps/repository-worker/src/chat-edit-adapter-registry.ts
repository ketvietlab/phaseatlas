import type { ChatEditSpec } from "@phaseatlas/contracts";
import {
  codexReasoningEffortArguments,
  resolveCodexExecutable,
  runChildProcess,
  type ProviderProcessRunner,
} from "./runner-registry.js";

export interface ChatEditAdapterContext {
  spec: ChatEditSpec;
  workingDirectory: string;
  signal: AbortSignal;
  emit(type: string, payload: Record<string, unknown>): void;
}

export interface ChatEditAdapter {
  readonly runnerId: string;
  execute(context: ChatEditAdapterContext): Promise<string>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function publicText(value: string, privateValues: string[]): string {
  let sanitized = value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").replaceAll("\0", "");
  for (const privateValue of privateValues.filter(Boolean).sort((a, b) => b.length - a.length)) {
    sanitized = sanitized.replaceAll(privateValue, "<worktree>");
  }
  return sanitized
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization|cookie)\b\s*[:=]\s*[^\s]+/gi, "<credential:redacted>")
    .slice(0, 16_000)
    .trim();
}

function editPrompt(spec: ChatEditSpec): string {
  return `You are editing a repository in a PhaseAtlas-owned isolated worktree.

Implement only the user's request. Stay within the repository-relative allowed paths and never touch
forbidden paths. Do not access the network, change dependencies or database schemas, edit .git, alter
canonical PhaseAtlas task state, create commits, or claim the changes were accepted. Inspect and edit
files directly, then summarize what changed and what verification remains. PhaseAtlas will independently
inspect Git and require explicit user review before integrating anything.

Confirmed policy:
${JSON.stringify({
    allowedPaths: spec.scope.allowedPaths,
    forbiddenPaths: spec.scope.forbiddenPaths,
    allowDependencyChanges: false,
    allowDatabaseMigrations: false,
    allowExternalNetwork: false,
  }, null, 2)}

User request:
${spec.prompt}`;
}

class CodexChatEditAdapter implements ChatEditAdapter {
  readonly runnerId = "codex-cli";

  constructor(
    private readonly processRunner: ProviderProcessRunner,
    private readonly executableResolver: () => Promise<{ executable: string; version: string }>,
  ) {}

  async execute(context: ChatEditAdapterContext): Promise<string> {
    const { executable } = await this.executableResolver();
    const privateValues = [executable, context.workingDirectory];
    let buffer = "";
    let summary = "";
    let failure = "";
    const consume = (line: string) => {
      if (!line.trim() || context.signal.aborted) return;
      const event = (() => {
        try { return record(JSON.parse(line) as unknown); } catch { return null; }
      })();
      if (!event) return;
      if (["turn.failed", "error"].includes(String(event.type))) {
        const error = record(event.error);
        failure = publicText(typeof event.message === "string" ? event.message : typeof error?.message === "string" ? error.message : "Codex edit failed.", privateValues);
        return;
      }
      if (!["item.started", "item.updated", "item.completed"].includes(String(event.type))) return;
      const item = record(event.item);
      if (!item) return;
      if (item.type === "agent_message" && event.type === "item.completed" && typeof item.text === "string") {
        summary = publicText(item.text, privateValues);
        if (summary) context.emit("chat.edit.delta", { text: summary });
      } else if (item.type === "reasoning" && event.type === "item.completed" && typeof item.text === "string") {
        const text = publicText(item.text, privateValues);
        if (text) context.emit("chat.edit.reasoning", { summary: text });
      } else if (item.type === "command_execution") {
        const commandId = typeof item.id === "string" ? item.id.slice(0, 128) : "command";
        if (event.type === "item.started") context.emit("chat.edit.tool.started", { commandId, summary: "Repository operation" });
        if (event.type === "item.completed") context.emit("chat.edit.tool.completed", {
          commandId,
          exitCode: Number.isInteger(item.exit_code) ? Number(item.exit_code) : 0,
        });
      } else if (item.type === "file_change" && event.type === "item.completed") {
        context.emit("chat.edit.files.changed", { advisory: true });
      }
    };
    await this.processRunner({
      executable,
      args: [
        "exec", "--sandbox", "workspace-write", "--ephemeral", "--ignore-user-config", "--ignore-rules",
        "--color", "never", "--json", "--cd", context.workingDirectory, "--model", context.spec.model,
        ...codexReasoningEffortArguments(context.spec.reasoningEffort), "-",
      ],
      cwd: context.workingDirectory,
      stdin: editPrompt(context.spec),
      signal: context.signal,
      onStdout: (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(consume);
      },
    });
    consume(buffer);
    if (failure) throw new Error(failure);
    return summary || "The provider completed the isolated edit attempt.";
  }
}

class ClaudeChatEditAdapter implements ChatEditAdapter {
  readonly runnerId = "claude-code";

  constructor(private readonly processRunner: ProviderProcessRunner) {}

  async execute(context: ChatEditAdapterContext): Promise<string> {
    const executable = process.env.PHASEATLAS_CLAUDE_BIN || "claude";
    const privateValues = [executable, context.workingDirectory];
    let buffer = "";
    let summary = "";
    let failure = "";
    const consume = (line: string) => {
      if (!line.trim() || context.signal.aborted) return;
      const event = (() => { try { return record(JSON.parse(line) as unknown); } catch { return null; } })();
      if (!event) return;
      if (event.type === "stream_event") {
        const streamEvent = record(event.event);
        const delta = record(streamEvent?.delta);
        if (streamEvent?.type === "content_block_delta" && typeof delta?.text === "string") {
          const text = publicText(delta.text, privateValues);
          if (text) {
            summary += text;
            context.emit("chat.edit.delta", { text });
          }
        }
      } else if (event.type === "result") {
        if (!summary && typeof event.result === "string") summary = publicText(event.result, privateValues);
        if (event.is_error === true) failure = summary || "Claude edit failed.";
      }
    };
    await this.processRunner({
      executable,
      args: [
        "--print", "--strict-mcp-config", "--mcp-config", "{}", "--output-format", "stream-json",
        "--include-partial-messages", "--permission-mode", "acceptEdits", "--tools", "Read,Glob,Grep,Edit,Write",
        "--no-session-persistence", "--model", context.spec.model,
      ],
      cwd: context.workingDirectory,
      stdin: editPrompt(context.spec),
      signal: context.signal,
      onStdout: (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(consume);
      },
    });
    consume(buffer);
    if (failure) throw new Error(failure);
    return summary.trim() || "The provider completed the isolated edit attempt.";
  }
}

export class ChatEditAdapterRegistry {
  private readonly adapters: ChatEditAdapter[];

  constructor(options: {
    processRunner?: ProviderProcessRunner;
    codexExecutableResolver?: () => Promise<{ executable: string; version: string }>;
  } = {}) {
    const processRunner = options.processRunner ?? runChildProcess;
    this.adapters = [
      new CodexChatEditAdapter(processRunner, options.codexExecutableResolver ?? resolveCodexExecutable),
      new ClaudeChatEditAdapter(processRunner),
    ];
  }

  get(runnerId: string): ChatEditAdapter {
    const adapter = this.adapters.find((candidate) => candidate.runnerId === runnerId);
    if (!adapter) throw new Error(`Runner ${runnerId} does not support isolated chat editing.`);
    return adapter;
  }
}
