import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import {
  AGENT_RUN_RESULT_SCHEMA,
  TASK_CONTENT_SCHEMA,
  TASK_PROPOSAL_SCHEMA,
  type AgentEvent,
  type AgentRunResult,
  type AgentRunSpec,
} from "@phaseatlas/contracts";
import {
  formatCodexJsonEvent,
  assertRunnerModel,
  parseClaudeModelHelp,
  parseCodexModelCatalog,
  RunnerRegistry,
  runChildProcess,
  type ProviderProcessRunner,
} from "./runner-registry.js";

function assertStrictObjectSchemas(value: unknown, location = "root"): void {
  if (!value || typeof value !== "object") return;
  const schema = value as Record<string, unknown>;
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    const propertyNames = Object.keys(schema.properties as Record<string, unknown>).sort();
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string").sort()
      : [];
    assert.deepEqual(required, propertyNames, `${location} must require every declared property`);
  }
  for (const [key, nested] of Object.entries(schema)) {
    if (Array.isArray(nested)) {
      nested.forEach((item, index) => assertStrictObjectSchemas(item, `${location}.${key}[${index}]`));
    } else {
      assertStrictObjectSchemas(nested, `${location}.${key}`);
    }
  }
}

test("uses an OpenAI strict-compatible proposal schema", () => {
  assertStrictObjectSchemas(TASK_PROPOSAL_SCHEMA);
  assertStrictObjectSchemas(TASK_CONTENT_SCHEMA);
  assertStrictObjectSchemas(AGENT_RUN_RESULT_SCHEMA);
});

test("discovers provider-neutral planning runner descriptors", async () => {
  const descriptors = await new RunnerRegistry().list();
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), ["codex-cli", "claude-code"]);
  for (const descriptor of descriptors) {
    assert.equal(descriptor.capabilities.includes("planning"), true);
    assert.equal(descriptor.capabilities.includes("execution"), true);
    assert.equal(descriptor.capabilities.includes("structured_output"), true);
    assert.equal(typeof descriptor.available, "boolean");
    assert.equal(Array.isArray(descriptor.models), true);
    assert.match(descriptor.modelDiscovery.status, /^(available|unavailable)$/);
  }
});

test("projects provider model catalogs without accepting arbitrary model text", () => {
  const models = parseCodexModelCatalog(JSON.stringify({
    models: [
      {
        slug: "gpt-safe",
        display_name: "GPT Safe",
        visibility: "list",
        priority: 1,
        default_reasoning_level: "high",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        base_instructions: "private provider payload",
      },
      { slug: "hidden", display_name: "Hidden", visibility: "hide", priority: 2 },
      { slug: "bad model id", display_name: "Invalid", visibility: "list", priority: 3 },
    ],
  }));
  assert.deepEqual(models, [{
    id: "gpt-safe",
    displayName: "GPT Safe",
    isDefault: true,
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
  }]);
  assert.deepEqual(parseClaudeModelHelp("Model. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or full name."), [
    { id: "fable", displayName: "Fable", isDefault: false, reasoningEfforts: [] },
    { id: "opus", displayName: "Opus", isDefault: false, reasoningEfforts: [] },
    { id: "sonnet", displayName: "Sonnet", isDefault: false, reasoningEfforts: [] },
  ]);
  const descriptor = {
    id: "fixture",
    provider: "fixture",
    name: "Fixture provider",
    available: true,
    capabilities: [],
    models,
    modelDiscovery: { status: "available" as const },
  };
  assert.doesNotThrow(() => assertRunnerModel(descriptor, "gpt-safe"));
  assert.throws(() => assertRunnerModel(descriptor, "manually-entered-model"), /selected model is not present/);
});

const normalizedResult: AgentRunResult = {
  outcome: "completed",
  summary: "Provider-neutral execution completed.",
  changedFiles: [{ path: "src/example.ts", changeType: "modified" }],
  verification: [{ stepId: "test", status: "passed", details: "Fixture passed." }],
  producedEvidence: [{ type: "test", reference: "fixture:test" }],
  blockers: [],
  nextAction: "Request human review.",
  requiresHumanReview: true,
  proposedTaskState: "in_review",
};

const executionSpec: AgentRunSpec = {
  schemaVersion: "phaseatlas.run/v1",
  runId: "run-provider-fixture",
  taskKey: "core/PHA-005",
  taskRevision: "a".repeat(64),
  action: "implement",
  checkout: { repositoryId: "repo", checkoutId: "checkout", canonicalPath: "/private/repository" },
  executionDirectory: "/private/worktree",
  objective: "Exercise provider translation.",
  contextDocuments: [],
  scope: {
    allowedPaths: ["src"],
    forbiddenPaths: [],
    writable: true,
    allowDependencyChanges: false,
    allowDatabaseMigrations: false,
    allowExternalNetwork: false,
  },
  acceptanceCriteria: [],
  verification: [],
  sandbox: "workspace-write",
  createdAt: "2026-08-03T00:00:00.000Z",
};

test("Codex and Claude fixtures translate to the same normalized execution contract", async () => {
  const fakeProcessRunner: ProviderProcessRunner = async (options) => {
    if (options.executable === "fixture-codex") {
      const outputPath = options.args[options.args.indexOf("--output-last-message") + 1];
      assert.ok(outputPath);
      await writeFile(outputPath, JSON.stringify(normalizedResult), "utf8");
      options.onStdout([
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Working safely." } }),
        JSON.stringify({ type: "item.started", item: { id: "cmd", type: "command_execution", command: "pnpm test" } }),
        JSON.stringify({ type: "item.completed", item: { id: "cmd", type: "command_execution", command: "pnpm test", aggregated_output: "passed", exit_code: 0 } }),
        JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "src/example.ts" }] } }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n"));
      return { stdout: "", stderr: "" };
    }
    options.onStdout([
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "Working safely." } } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "cmd", name: "Bash", input: { command: "pnpm test" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "cmd", content: "passed", is_error: false }] } }),
      JSON.stringify({ type: "file_changed", path: "src/example.ts" }),
      JSON.stringify({ type: "result", structured_output: normalizedResult, result: JSON.stringify(normalizedResult), is_error: false }),
    ].join("\n"));
    return { stdout: "", stderr: "" };
  };
  const registry = new RunnerRegistry({
    processRunner: fakeProcessRunner,
    codexExecutableResolver: async () => ({ executable: "fixture-codex", version: "fixture" }),
    codexModelDiscovery: async () => [],
  });
  const run = async (runnerId: "codex-cli" | "claude-code") => {
    const events: Array<Omit<AgentEvent, "sequence">> = [];
    const result = await registry.getExecution(runnerId, "implement", "workspace-write").execute({
      spec: executionSpec,
      workingDirectory: executionSpec.executionDirectory,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });
    return { result, events };
  };
  const codex = await run("codex-cli");
  const claude = await run("claude-code");
  assert.deepEqual(codex.result, normalizedResult);
  assert.deepEqual(claude.result, normalizedResult);
  assert.deepEqual(codex.events.map((event) => event.type), claude.events.map((event) => event.type));
  assert.deepEqual(codex.events.map((event) => event.type), [
    "agent.delta",
    "command.started",
    "command.output",
    "command.completed",
    "file.changed",
    "turn.completed",
  ]);
  assert.equal(JSON.stringify(codex.events).includes("/private/"), false);
  assert.equal(JSON.stringify(claude.events).includes("/private/"), false);
});

test("formats Codex JSONL events as readable terminal progress", () => {
  assert.equal(
    formatCodexJsonEvent({ type: "thread.started", thread_id: "019fc766-e8b7" }),
    "Session opened\n",
  );
  assert.equal(
    formatCodexJsonEvent({
      type: "item.started",
      item: { type: "command_execution", command: "rg --files apps" },
    }),
    "→ rg --files apps\n",
  );
  assert.equal(
    formatCodexJsonEvent({
      type: "turn.completed",
      usage: { input_tokens: 1250, output_tokens: 340 },
    }),
    "Turn completed · 1,250 input / 340 output tokens\n",
  );
  assert.equal(formatCodexJsonEvent({ type: "unknown.event" }), "");
});

test("cancellation waits for provider exit and force-terminates an unresponsive owned process", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  let outputAfterAbort = "";
  const execution = runChildProcess({
    executable: process.execPath,
    args: ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => process.stdout.write('late\\n'), 20);"],
    cwd: process.cwd(),
    signal: controller.signal,
    terminationGraceMs: 80,
    onStdout: (chunk) => {
      if (chunk.includes("ready")) controller.abort();
      else if (controller.signal.aborted) outputAfterAbort += chunk;
    },
  });
  await assert.rejects(execution, /cancelled/);
  assert.ok(Date.now() - startedAt >= 60, "cancellation must wait for confirmed force termination");
  assert.equal(outputAfterAbort, "");
});
