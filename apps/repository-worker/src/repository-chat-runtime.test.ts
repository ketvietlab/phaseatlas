import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { PersistedRepositoryChatEvent } from "@phaseatlas/contracts";
import { CheckoutOperationalStore } from "@phaseatlas/core";
import { RepositoryChatAdapterRegistry } from "./chat-adapter-registry.js";
import { RepositoryChatRuntime } from "./repository-chat-runtime.js";
import { RunnerRegistry, type ProviderProcessRunner } from "./runner-registry.js";

const exec = promisify(execFile);
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl2QAAAAASUVORK5CYII=";

async function fixtureRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-chat-runtime-"));
  await exec("git", ["init"], { cwd: root });
  await exec("git", ["config", "user.email", "phaseatlas@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "PhaseAtlas Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for repository chat fixture.");
}

function runCodexAppServerFixture(
  options: Parameters<ProviderProcessRunner>[0],
  fixture: {
    deltas: string[];
    command?: boolean;
    mcpTool?: string;
    onTurnStart?: (request: Record<string, unknown>) => void;
  },
) {
  const finalText = fixture.deltas.join("");
  const emit = (value: unknown) => options.onStdout(`${JSON.stringify(value)}\n`);
  options.onStdinReady?.({
    write(data) {
      for (const line of data.split("\n").filter(Boolean)) {
        const request = JSON.parse(line) as { id?: number; method?: string };
        if (request.id === 1) emit({ id: 1, result: { userAgent: "fixture" } });
        if (request.id === 2) emit({ id: 2, result: { thread: { id: "thread-fixture" } } });
        if (request.id !== 3) continue;
        fixture.onTurnStart?.(request as Record<string, unknown>);
        emit({ id: 3, result: { turn: { id: "turn-fixture", status: "inProgress", items: [] } } });
        fixture.deltas.forEach((delta) => emit({ method: "item/agentMessage/delta", params: { itemId: "answer", delta } }));
        if (fixture.command) {
          emit({ method: "item/started", params: { item: { id: "read", type: "commandExecution", command: "git status --short", status: "inProgress" } } });
          emit({ method: "item/commandExecution/outputDelta", params: { itemId: "read", delta: "clean" } });
          emit({ method: "item/completed", params: { item: { id: "read", type: "commandExecution", command: "git status --short", aggregatedOutput: "clean", status: "completed" } } });
        }
        if (fixture.mcpTool) {
          emit({ method: "item/started", params: { item: { id: "external", type: "mcpToolCall", tool: fixture.mcpTool } } });
        }
        const answer = { id: "answer", type: "agentMessage", text: finalText };
        emit({ method: "item/completed", params: { item: answer } });
        emit({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { inputTokens: 5, outputTokens: 2 } } } });
        emit({ method: "turn/completed", params: { turn: { id: "turn-fixture", status: "completed", items: [answer], error: null } } });
      }
    },
    end() {},
  });
}

test("persists provider-neutral chat sessions, messages, replay, and cancellation", async () => {
  const root = await fixtureRepository();
  const supportRoot = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-chat-support-"));
  const checkoutId = "a".repeat(20);
  const databasePath = path.join(supportRoot, "operations.sqlite");
  const store = new CheckoutOperationalStore(databasePath, checkoutId);
  let mode: "complete" | "block" | "fail-long" = "complete";
  const processRunner: ProviderProcessRunner = async (options) => {
    if (mode === "fail-long") throw new Error(`provider failure ${"x".repeat(4_000)}`);
    if (mode === "block") {
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error("fixture provider cancelled"));
        options.signal.addEventListener("abort", abort, { once: true });
        if (options.signal.aborted) abort();
      });
    }
    runCodexAppServerFixture(options, { deltas: ["The fixture repository ", "contains a README."] });
    return { stdout: "", stderr: "" };
  };
  const runnerOptions = {
    processRunner,
    codexExecutableResolver: async () => ({ executable: "fixture-codex", version: "fixture" }),
    codexModelDiscovery: async () => [{
      id: "gpt-fixture",
      displayName: "GPT Fixture",
      isDefault: true,
      reasoningEfforts: [],
    }],
  };
  const events: PersistedRepositoryChatEvent[] = [];
  const runtime = new RepositoryChatRuntime(
    store,
    new RunnerRegistry(runnerOptions),
    new RepositoryChatAdapterRegistry(runnerOptions),
    root,
    checkoutId,
    (event) => events.push(event),
  );

  const first = await runtime.createSession({ runnerId: "codex-cli", model: "gpt-fixture", title: "Architecture" });
  const second = await runtime.createSession({ runnerId: "codex-cli", model: "gpt-fixture" });
  assert.equal(runtime.listSessions().length, 2);
  assert.equal("taskKey" in first, false);
  assert.equal("workspaceSlug" in first, false);
  assert.equal(runtime.renameSession({ sessionId: second.sessionId, title: "Second thread" }).title, "Second thread");
  await assert.rejects(
    runtime.createSession({ runnerId: "codex-cli", model: "manually-entered" }),
    /selected model is not present/,
  );

  const started = await runtime.send({
    sessionId: first.sessionId,
    text: "What is in this repository?",
    attachments: [
      { path: "README.md" },
      { type: "image", name: "screen.png", mediaType: "image/png", data: ONE_PIXEL_PNG },
    ],
  });
  await waitFor(() => ["completed", "failed", "cancelled", "interrupted"].includes(store.getChatTurn(started.turnId).status));
  assert.equal(
    store.getChatTurn(started.turnId).status,
    "completed",
    JSON.stringify(runtime.eventPage(started.turnId, 0, 20).events),
  );
  const messages = runtime.listMessages(first.sessionId);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(messages[0]?.attachments, [
    { path: "README.md" },
    { type: "image", name: "screen.png", mediaType: "image/png", data: ONE_PIXEL_PNG },
  ]);
  assert.equal(messages[1]?.content, "The fixture repository contains a README.");
  const firstPage = runtime.eventPage(started.turnId, 0, 2);
  const secondPage = runtime.eventPage(started.turnId, firstPage.nextSequence, 20);
  assert.equal(firstPage.hasMore, true);
  assert.deepEqual(
    [...firstPage.events, ...secondPage.events].map((event) => event.sequence),
    events.filter((event) => event.turnId === started.turnId).map((event) => event.sequence),
  );
  await assert.rejects(
    runtime.send({ sessionId: first.sessionId, text: "unsafe", attachments: [{ path: "../secret" }] }),
    /not allowed/,
  );
  await assert.rejects(
    runtime.send({ sessionId: first.sessionId, text: "unsafe image", attachments: [{ type: "image", name: "bad.png", mediaType: "image/png", data: "not-base64" }] }),
    /not valid base64/,
  );

  mode = "fail-long";
  const failed = await runtime.send({ sessionId: first.sessionId, text: "Fail safely." });
  await waitFor(() => store.getChatTurn(failed.turnId).status === "failed");
  const failedEvent = runtime.eventPage(failed.turnId).events.at(-1);
  assert.equal(failedEvent?.type, "chat.turn.failed");
  assert.equal(String(failedEvent?.payload.message).length, 2_000);

  mode = "block";
  const blocked = await runtime.send({ sessionId: first.sessionId, text: "Wait for cancellation." });
  await waitFor(() => store.getChatTurn(blocked.turnId).status === "running");
  const cancelled = await runtime.cancel(blocked.turnId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await runtime.cancel(blocked.turnId)).disposition, "already_terminal");
  assert.equal(runtime.closeSession(first.sessionId).state, "closed");

  store.close();
  const reopened = new CheckoutOperationalStore(databasePath, checkoutId);
  assert.equal(reopened.listChatSessions().length, 2);
  assert.equal(reopened.listChatMessages(first.sessionId).length, 4);
  assert.equal(reopened.getChatTurn(blocked.turnId).status, "cancelled");
  reopened.close();
  await rm(root, { recursive: true, force: true });
  await rm(supportRoot, { recursive: true, force: true });
});

test("reconciles active chat turns as one durable interruption", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-chat-store-"));
  const store = new CheckoutOperationalStore(path.join(root, "operations.sqlite"), "b".repeat(20));
  const timestamp = "2026-08-04T00:00:00.000Z";
  store.createChatSession({
    sessionId: "session-one",
    checkoutId: "b".repeat(20),
    runnerId: "codex-cli",
    model: "gpt-fixture",
    title: "Interrupted",
    state: "open",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  store.createChatTurn({
    turn: {
      turnId: "turn-one",
      sessionId: "session-one",
      status: "starting",
      runnerId: "codex-cli",
      model: "gpt-fixture",
      userMessageId: "message-one",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    userMessage: {
      messageId: "message-one",
      sessionId: "session-one",
      turnId: "turn-one",
      role: "user",
      content: "Resume me safely.",
      attachments: [],
      sequence: 1,
      createdAt: timestamp,
    },
  });
  store.appendChatEvent({ turnId: "turn-one", type: "chat.turn.status", payload: { status: "running" }, status: "running" });
  assert.equal(store.reconcileInterruptedChatTurns().length, 1);
  assert.equal(store.reconcileInterruptedChatTurns().length, 0);
  assert.equal(store.getChatTurn("turn-one").status, "interrupted");
  assert.deepEqual(store.listChatEventPage("turn-one").events.map((event) => event.sequence), [1, 2]);
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("normalizes Codex and Claude chat fixtures behind the same read-only boundary", async () => {
  const observedArgs = new Map<string, string[]>();
  let codexTurnStart: Record<string, unknown> | undefined;
  let claudeStdin = "";
  const processRunner: ProviderProcessRunner = async (options) => {
    observedArgs.set(options.executable, options.args);
    if (options.executable === "fixture-codex") {
      runCodexAppServerFixture(options, { deltas: ["An", "swer"], command: true, onTurnStart: (request) => codexTurnStart = request });
    } else {
      claudeStdin = options.stdin ?? "";
      options.onStdout([
        JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "An" } } }),
        JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "swer" } } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "README.md" } }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "clean" }] } }),
        JSON.stringify({ type: "result", result: "Answer", input_tokens: 5, output_tokens: 2, is_error: false }),
      ].join("\n"));
    }
    return { stdout: "", stderr: "" };
  };
  const registry = new RepositoryChatAdapterRegistry({
    processRunner,
    codexExecutableResolver: async () => ({ executable: "fixture-codex", version: "fixture" }),
  });
  const messages = [{
    messageId: "message",
    sessionId: "session",
    turnId: "turn",
    role: "user" as const,
    content: "Inspect the repository.",
    attachments: [
      { path: "README.md" },
      { type: "image" as const, name: "screen.png", mediaType: "image/png" as const, data: ONE_PIXEL_PNG },
    ],
    sequence: 1,
    createdAt: "2026-08-04T00:00:00.000Z",
  }];
  const run = async (runnerId: "codex-cli" | "claude-code") => {
    const events: string[] = [];
    const answer = await registry.get(runnerId).execute({
      repositoryRoot: "/private/repository",
      model: "fixture-model",
      messages,
      signal: new AbortController().signal,
      emit: (event) => events.push(event.type),
    });
    return { answer, events };
  };
  const codex = await run("codex-cli");
  const claude = await run("claude-code");
  assert.deepEqual(codex, claude);
  assert.deepEqual(codex.events, [
    "chat.assistant.delta",
    "chat.assistant.delta",
    "chat.tool.started",
    "chat.tool.output",
    "chat.tool.completed",
    "chat.usage",
  ]);
  assert.deepEqual(observedArgs.get("fixture-codex")?.slice(0, 2), ["app-server", "--stdio"]);
  assert.equal(observedArgs.get("fixture-codex")?.includes("mcp_servers={}"), true);
  assert.equal(observedArgs.get("fixture-codex")?.includes("features.apps=false"), true);
  assert.equal(observedArgs.get("claude")?.includes("--safe-mode"), true);
  assert.equal(observedArgs.get("claude")?.includes("--strict-mcp-config"), true);
  assert.equal(observedArgs.get("claude")?.includes("--input-format"), true);
  assert.equal(observedArgs.get("claude")?.includes("Read,Glob,Grep"), true);
  assert.equal(observedArgs.get("claude")?.some((argument) => /Edit|Write|Bash/.test(argument)), false);
  const codexInput = (codexTurnStart?.params as { input?: Array<Record<string, unknown>> } | undefined)?.input ?? [];
  assert.equal(String(codexInput[0]?.text).includes(ONE_PIXEL_PNG), false);
  assert.equal(codexInput[1]?.type, "image");
  assert.equal(String(codexInput[1]?.url).startsWith("data:image/png;base64,"), true);
  const claudeMessage = JSON.parse(claudeStdin) as { message: { content: Array<Record<string, unknown>> } };
  assert.equal(String(claudeMessage.message.content[0]?.text).includes(ONE_PIXEL_PNG), false);
  assert.equal(claudeMessage.message.content[1]?.type, "image");
  assert.deepEqual(claudeMessage.message.content[1]?.source, { type: "base64", media_type: "image/png", data: ONE_PIXEL_PNG });

  const mcpRegistry = new RepositoryChatAdapterRegistry({
    processRunner: async (options) => {
      runCodexAppServerFixture(options, { deltas: ["Unsafe answer"], mcpTool: "mutate" });
      return { stdout: "", stderr: "" };
    },
    codexExecutableResolver: async () => ({ executable: "fixture-codex", version: "fixture" }),
  });
  await assert.rejects(
    mcpRegistry.get("codex-cli").execute({
      repositoryRoot: "/private/repository",
      model: "fixture-model",
      messages,
      signal: new AbortController().signal,
      emit: () => undefined,
    }),
    /unsupported mutate MCP tool/,
  );
});

test("emits Codex assistant deltas before the provider turn completes", async () => {
  let finishProvider: (() => void) | undefined;
  const providerFinished = new Promise<void>((resolve) => {
    finishProvider = resolve;
  });
  const events: string[] = [];
  const registry = new RepositoryChatAdapterRegistry({
    processRunner: async (options) => {
      const emit = (value: unknown) => options.onStdout(`${JSON.stringify(value)}\n`);
      options.onStdinReady?.({
        write(data) {
          for (const line of data.split("\n").filter(Boolean)) {
            const request = JSON.parse(line) as { id?: number };
            if (request.id === 1) emit({ id: 1, result: { userAgent: "fixture" } });
            if (request.id === 2) emit({ id: 2, result: { thread: { id: "thread-fixture" } } });
            if (request.id === 3) {
              emit({ id: 3, result: { turn: { id: "turn-fixture", status: "inProgress", items: [] } } });
              emit({ method: "item/agentMessage/delta", params: { itemId: "answer", delta: "Visible now" } });
            }
          }
        },
        end() {},
      });
      await providerFinished;
      const answer = { id: "answer", type: "agentMessage", text: "Visible now" };
      emit({ method: "item/completed", params: { item: answer } });
      emit({ method: "turn/completed", params: { turn: { id: "turn-fixture", status: "completed", items: [answer], error: null } } });
      return { stdout: "", stderr: "" };
    },
    codexExecutableResolver: async () => ({ executable: "fixture-codex", version: "fixture" }),
  });
  const execution = registry.get("codex-cli").execute({
    repositoryRoot: "/private/repository",
    model: "fixture-model",
    messages: [],
    signal: new AbortController().signal,
    emit: (event) => events.push(event.type),
  });

  await waitFor(() => events.includes("chat.assistant.delta"));
  assert.deepEqual(events, ["chat.assistant.delta"]);
  finishProvider?.();
  assert.equal(await execution, "Visible now");
});
