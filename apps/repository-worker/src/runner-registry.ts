import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  TASK_CONTENT_SCHEMA,
  TASK_PROPOSAL_SCHEMA,
  type CanonicalTask,
  type PlanningOutlineSet,
  type PlanningStartInput,
  type RunnerDescriptor,
  type TaskContentDraft,
  type TaskProposalOutline,
  type WorkspaceSummary,
} from "@phaseatlas/contracts";
import {
  ProposalValidationError,
  validatePlanningOutlineSet,
  validateTaskContent,
} from "@phaseatlas/core";

const execFileAsync = promisify(execFile);

export interface PlanningContext {
  repositoryRoot: string;
  repositoryName: string;
  input: PlanningStartInput;
  canonicalTasks: CanonicalTask[];
  workspaces: WorkspaceSummary[];
}

export interface PlanningRunnerAdapter {
  readonly id: string;
  describe(): Promise<RunnerDescriptor>;
  run(
    context: PlanningContext,
    signal: AbortSignal,
    onDelta: (text: string) => void,
  ): Promise<PlanningOutlineSet>;
  initializeContent(
    context: PlanningContext,
    task: TaskProposalOutline,
    signal: AbortSignal,
    onDelta: (text: string) => void,
  ): Promise<TaskContentDraft>;
}

async function detectRunner(options: {
  id: string;
  provider: string;
  name: string;
  executable: string;
}): Promise<RunnerDescriptor> {
  try {
    const { stdout, stderr } = await execFileAsync(options.executable, ["--version"], {
      timeout: 3_000,
      env: process.env,
    });
    return {
      id: options.id,
      provider: options.provider,
      name: options.name,
      version: `${stdout || stderr}`.trim().split("\n")[0],
      available: true,
      capabilities: ["planning", "streaming", "structured_output", "repository_read"],
    };
  } catch (error) {
    return {
      id: options.id,
      provider: options.provider,
      name: options.name,
      available: false,
      unavailableReason: error instanceof Error ? error.message : `${options.executable} is unavailable.`,
      capabilities: ["planning", "streaming", "structured_output", "repository_read"],
    };
  }
}

function codexVersion(value: string): number[] {
  return value.match(/\d+(?:\.\d+){1,3}/)?.[0]?.split(".").map(Number) ?? [];
}

function compareVersions(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

async function resolveCodexExecutable(): Promise<{ executable: string; version: string }> {
  const candidates = [
    process.env.PHASEATLAS_CODEX_BIN,
    process.platform === "darwin" ? "/Applications/ChatGPT.app/Contents/Resources/codex" : undefined,
    "codex",
  ].filter((candidate, index, values): candidate is string => Boolean(candidate) && values.indexOf(candidate) === index);

  const available = (await Promise.all(candidates.map(async (executable) => {
    try {
      const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
        timeout: 3_000,
        env: process.env,
      });
      const version = `${stdout || stderr}`.trim().split("\n")[0] ?? "";
      return { executable, version, comparable: codexVersion(version) };
    } catch {
      return null;
    }
  }))).filter((candidate): candidate is { executable: string; version: string; comparable: number[] } => Boolean(candidate));

  const selected = available.sort((left, right) => compareVersions(right.comparable, left.comparable))[0];
  if (!selected) throw new Error("Codex CLI is unavailable.");
  return { executable: selected.executable, version: selected.version };
}

function planningPrompt(context: PlanningContext): string {
  const workspaceTarget = context.input.target.type === "workspace"
    ? context.input.target.workspaceSlug
    : null;
  const existingTasks = context.canonicalTasks
    .filter((task) => !workspaceTarget || task.key.workspaceSlug === workspaceTarget)
    .map((task) => `- ${task.key.workspaceSlug}/${task.key.taskId}: ${task.title} [${task.state}]`)
    .join("\n") || "- None";
  const existingWorkspaces = context.workspaces
    .map((workspace) => `- ${workspace.slug}: ${workspace.name}`)
    .join("\n") || "- None";
  const targetRules = workspaceTarget
    ? `- Return workspaces as an empty array.\n- Every task must target workspaceSlug exactly "${workspaceTarget}".`
    : `- Return exactly one workspace proposal and one or more starter task proposals.
- The workspace slug must not collide with an existing workspace.
- Every task workspaceSlug must equal the proposed workspace slug.`;
  return `You are a read-only software planning agent for PhaseAtlas.

Inspect the repository when useful, but do not modify files, install dependencies, or run mutating commands.
Turn the user's request into the smallest coherent set of task proposals matching the required JSON schema.

Rules:
${targetRules}
- Use repository-relative paths only. Never use absolute paths or ../ segments.
- temporaryId values must be unique and may be referenced by suggestedDependencies.
- Write objective and acceptance criteria as testable outcomes, not implementation narration.
- Produce task outlines only. PhaseAtlas initializes the detailed content for each task in parallel after this turn.
- phaseId and every verificationSuggestion are required non-empty strings.
- Keep dangerous capabilities out of scope unless the user explicitly requested them.
- Return only the structured result required by the schema.

Repository: ${context.repositoryName}
Planning target: ${workspaceTarget ? `existing workspace ${workspaceTarget}` : "repository (create a new workspace)"}
Existing workspaces:
${existingWorkspaces}
Existing canonical tasks:
${existingTasks}

User request:
${context.input.request}`;
}

function taskContentPrompt(context: PlanningContext, task: TaskProposalOutline): string {
  const relatedTasks = context.canonicalTasks
    .filter((candidate) => candidate.key.workspaceSlug === task.workspaceSlug)
    .map((candidate) => `- ${candidate.key.taskId}: ${candidate.title} [${candidate.state}]`)
    .join("\n") || "- None";
  return `You are initializing the implementation-ready content for one PhaseAtlas task.

Work read-only. Inspect repository files that are relevant to this task, but do not modify files,
install dependencies, or run mutating commands. Return only the structured result required by the schema.

Content rules:
- body is Markdown and uses exactly these top-level sections: Context, Requirements, Implementation notes, Constraints, Verification plan.
- Context explains the repository-specific problem, current behavior, and why this task exists; do not repeat the objective.
- Requirements are concrete outcomes and cover the important behavior implied by the task.
- Implementation notes name relevant repository-relative paths, boundaries, or integration points discovered during inspection.
- Constraints state safety limits and explicit non-goals. Do not invent dangerous capabilities.
- Verification plan describes specific checks that prove the task is complete without claiming they already pass.
- The body must be task-specific and useful to a different agent starting with no conversation history.

Repository: ${context.repositoryName}
Workspace: ${task.workspaceSlug}
Original user request: ${context.input.request}
Task outline:
${JSON.stringify(task, null, 2)}

Existing canonical tasks in this workspace:
${relatedTasks}`;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced) as unknown;
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    throw new Error("Runner did not return a JSON object.");
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function tokenCount(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("en-US")
    : null;
}

export function formatCodexJsonEvent(value: unknown): string {
  const event = recordValue(value);
  if (!event || typeof event.type !== "string") return "";

  if (event.type === "thread.started") {
    const threadId = typeof event.thread_id === "string" ? ` · ${event.thread_id.slice(0, 8)}` : "";
    return `Session opened${threadId}\n`;
  }
  if (event.type === "turn.started") return "Agent is inspecting the repository…\n";

  if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
    const item = recordValue(event.item);
    if (!item || typeof item.type !== "string") return "";
    const completed = event.type === "item.completed";
    const text = typeof item.text === "string" ? item.text.trim() : "";

    if (item.type === "reasoning" && text && completed) return `Thinking · ${text}\n`;
    if (item.type === "agent_message" && text && completed) return `${text}\n`;
    if (item.type === "command_execution") {
      const command = typeof item.command === "string" ? item.command : "repository command";
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output.trim() : "";
      if (!completed) return `→ ${command}\n`;
      return output ? `${output}\n✓ Command completed\n` : "✓ Command completed\n";
    }
    if (item.type === "mcp_tool_call") {
      const server = typeof item.server === "string" ? `${item.server}.` : "";
      const tool = typeof item.tool === "string" ? item.tool : "tool";
      return `${completed ? "✓" : "→"} Tool · ${server}${tool}\n`;
    }
    if (completed) return `✓ ${item.type.replaceAll("_", " ")}\n`;
    return `→ ${item.type.replaceAll("_", " ")}\n`;
  }

  if (event.type === "turn.completed") {
    const usage = recordValue(event.usage);
    const input = tokenCount(usage?.input_tokens);
    const output = tokenCount(usage?.output_tokens);
    return input && output
      ? `Turn completed · ${input} input / ${output} output tokens\n`
      : "Turn completed · validating structured proposals…\n";
  }

  if (event.type === "turn.failed" || event.type === "error") {
    const error = recordValue(event.error);
    const message = typeof event.message === "string"
      ? event.message
      : typeof error?.message === "string" ? error.message : "Codex reported an error.";
    return `Error · ${message}\n`;
  }
  return "";
}

function validatedOutlines(value: unknown, context: PlanningContext): PlanningOutlineSet {
  const validation = validatePlanningOutlineSet(value, {
    target: context.input.target,
    existingWorkspaceSlugs: context.workspaces.map((workspace) => workspace.slug),
  });
  if (!validation.proposals) throw new ProposalValidationError(validation.issues);
  return validation.proposals;
}

function validatedContent(value: unknown): TaskContentDraft {
  const validation = validateTaskContent(value);
  if (!validation.content) throw new ProposalValidationError(validation.issues);
  return validation.content;
}

function runChildProcess(options: {
  executable: string;
  args: string[];
  cwd: string;
  stdin?: string;
  signal: AbortSignal;
  onStdout: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: process.env,
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let exitFallback: NodeJS.Timeout | null = null;
    const finish = (code: number | null, childSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (exitFallback) clearTimeout(exitFallback);
      options.signal.removeEventListener("abort", abort);
      if (options.signal.aborted) {
        reject(new Error("Planning run was cancelled."));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${options.executable} exited with ${childSignal || `code ${code}`}: ${stderr.trim()}`));
      }
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(child.exitCode, child.signalCode);
    };
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdout(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", finish);
    child.once("exit", (code, childSignal) => {
      // `close` normally follows `exit` after stdout/stderr drain. A few packaged CLIs hand
      // their pipes to another process, so keep an exit fallback instead of hanging forever.
      exitFallback = setTimeout(() => finish(code, childSignal), 250);
      exitFallback.unref();
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

class CodexPlanningAdapter implements PlanningRunnerAdapter {
  readonly id = "codex-cli";
  private executable = "codex";

  async describe(): Promise<RunnerDescriptor> {
    try {
      const resolved = await resolveCodexExecutable();
      this.executable = resolved.executable;
      return {
        id: this.id,
        provider: "openai",
        name: "Codex CLI",
        version: resolved.version,
        available: true,
        capabilities: ["planning", "streaming", "structured_output", "repository_read"],
      };
    } catch (error) {
      return {
        id: this.id,
        provider: "openai",
        name: "Codex CLI",
        available: false,
        unavailableReason: error instanceof Error ? error.message : "Codex CLI is unavailable.",
        capabilities: ["planning", "streaming", "structured_output", "repository_read"],
      };
    }
  }

  private async executeStructured(
    context: PlanningContext,
    signal: AbortSignal,
    onDelta: (text: string) => void,
    prompt: string,
    schema: unknown,
    temporaryPrefix: string,
  ): Promise<unknown> {
    const resolved = await resolveCodexExecutable();
    this.executable = resolved.executable;
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), temporaryPrefix));
    const schemaPath = path.join(temporaryDirectory, "output.schema.json");
    const outputPath = path.join(temporaryDirectory, "result.json");
    await writeFile(schemaPath, JSON.stringify(schema), "utf8");
    const args = [
      "exec",
      "--sandbox", "read-only",
      "--ephemeral",
      "--color", "never",
      "--json",
      "--output-schema", schemaPath,
      "--output-last-message", outputPath,
      "--cd", context.repositoryRoot,
    ];
    if (context.input.model?.trim()) args.push("--model", context.input.model.trim());
    args.push("-");
    let lineBuffer = "";
    const consumeLine = (line: string): void => {
      if (!line.trim()) return;
      try {
        const displayText = formatCodexJsonEvent(JSON.parse(line) as unknown);
        if (displayText) onDelta(displayText);
      } catch {
        onDelta(`${line}\n`);
      }
    };
    try {
      await runChildProcess({
        executable: this.executable,
        args,
        cwd: context.repositoryRoot,
        stdin: prompt,
        signal,
        onStdout: (chunk) => {
          lineBuffer += chunk;
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";
          lines.forEach(consumeLine);
        },
        onStderr: onDelta,
      });
      consumeLine(lineBuffer);
      return parseJsonText(await readFile(outputPath, "utf8"));
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async run(context: PlanningContext, signal: AbortSignal, onDelta: (text: string) => void): Promise<PlanningOutlineSet> {
    const value = await this.executeStructured(
      context,
      signal,
      onDelta,
      planningPrompt(context),
      TASK_PROPOSAL_SCHEMA,
      "phaseatlas-codex-plan-",
    );
    return validatedOutlines(value, context);
  }

  async initializeContent(
    context: PlanningContext,
    task: TaskProposalOutline,
    signal: AbortSignal,
    onDelta: (text: string) => void,
  ): Promise<TaskContentDraft> {
    const value = await this.executeStructured(
      context,
      signal,
      onDelta,
      taskContentPrompt(context, task),
      TASK_CONTENT_SCHEMA,
      "phaseatlas-codex-content-",
    );
    return validatedContent(value);
  }
}

class ClaudePlanningAdapter implements PlanningRunnerAdapter {
  readonly id = "claude-code";

  describe(): Promise<RunnerDescriptor> {
    return detectRunner({ id: this.id, provider: "anthropic", name: "Claude Code", executable: "claude" });
  }

  private async executeStructured(
    context: PlanningContext,
    signal: AbortSignal,
    onDelta: (text: string) => void,
    prompt: string,
    schema: unknown,
  ): Promise<unknown> {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--json-schema", JSON.stringify(schema),
      "--permission-mode", "plan",
      "--tools", "Read,Glob,Grep",
      "--no-session-persistence",
    ];
    if (context.input.model?.trim()) args.push("--model", context.input.model.trim());
    args.push("--", prompt);

    let lineBuffer = "";
    let structuredOutput: unknown;
    let resultText = "";
    const consumeLine = (line: string): void => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "stream_event" && typeof event.event === "object" && event.event) {
          const streamEvent = event.event as Record<string, unknown>;
          const delta = streamEvent.delta;
          if (streamEvent.type === "content_block_delta" && typeof delta === "object" && delta) {
            const text = (delta as Record<string, unknown>).text;
            if (typeof text === "string") onDelta(text);
          }
        }
        if (event.type === "result") {
          structuredOutput = event.structured_output;
          if (typeof event.result === "string") resultText = event.result;
        }
      } catch {
        onDelta(line);
      }
    };

    await runChildProcess({
      executable: "claude",
      args,
      cwd: context.repositoryRoot,
      signal,
      onStdout: (chunk) => {
        lineBuffer += chunk;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        lines.forEach(consumeLine);
      },
      onStderr: onDelta,
    });
    consumeLine(lineBuffer);
    return structuredOutput ?? parseJsonText(resultText);
  }

  async run(context: PlanningContext, signal: AbortSignal, onDelta: (text: string) => void): Promise<PlanningOutlineSet> {
    const value = await this.executeStructured(
      context,
      signal,
      onDelta,
      planningPrompt(context),
      TASK_PROPOSAL_SCHEMA,
    );
    return validatedOutlines(value, context);
  }

  async initializeContent(
    context: PlanningContext,
    task: TaskProposalOutline,
    signal: AbortSignal,
    onDelta: (text: string) => void,
  ): Promise<TaskContentDraft> {
    const value = await this.executeStructured(
      context,
      signal,
      onDelta,
      taskContentPrompt(context, task),
      TASK_CONTENT_SCHEMA,
    );
    return validatedContent(value);
  }
}

export class RunnerRegistry {
  private readonly adapters: PlanningRunnerAdapter[] = [
    new CodexPlanningAdapter(),
    new ClaudePlanningAdapter(),
  ];

  list(): Promise<RunnerDescriptor[]> {
    return Promise.all(this.adapters.map((adapter) => adapter.describe()));
  }

  get(runnerId: string): PlanningRunnerAdapter {
    const adapter = this.adapters.find((candidate) => candidate.id === runnerId);
    if (!adapter) throw new Error(`Runner ${runnerId} is not registered.`);
    return adapter;
  }
}
