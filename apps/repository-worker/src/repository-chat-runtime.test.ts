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
    options.onStdout([
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "Inspected repository context." } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "The fixture repository contains a README." } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 8 } }),
    ].join("\n"));
    return { stdout: "", stderr: "" };
  };
  const runnerOptions = {
    processRunner,
    codexExecutableResolver: async () => ({ executable: "fixture-codex", version: "fixture" }),
    codexModelDiscovery: async () => [{
      id: "gpt-fixture",
      displayName: "GPT Fixture",
      isDefault: true,
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
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

  const first = await runtime.createSession({
    runnerId: "codex-cli",
    model: "gpt-fixture",
    reasoningEffort: "high",
    title: "Architecture",
  });
  const second = await runtime.createSession({ runnerId: "codex-cli", model: "gpt-fixture" });
  assert.equal(runtime.listSessions().length, 2);
  assert.equal("taskKey" in first, false);
  assert.equal("workspaceSlug" in first, false);
  assert.equal(first.reasoningEffort, "high");
  assert.equal(runtime.renameSession({ sessionId: second.sessionId, title: "Second thread" }).title, "Second thread");
  await assert.rejects(
    runtime.createSession({ runnerId: "codex-cli", model: "manually-entered" }),
    /selected model is not present/,
  );
  await assert.rejects(
    runtime.createSession({ runnerId: "codex-cli", model: "gpt-fixture", reasoningEffort: "ultra" }),
    /reasoning effort is not supported/,
  );

  const started = await runtime.send({
    sessionId: first.sessionId,
    text: "What is in this repository?",
    attachments: [{ path: "README.md" }],
  });
  await waitFor(() => ["completed", "failed", "cancelled", "interrupted"].includes(store.getChatTurn(started.turnId).status));
  assert.equal(
    store.getChatTurn(started.turnId).status,
    "completed",
    JSON.stringify(runtime.eventPage(started.turnId, 0, 20).events),
  );
  const messages = runtime.listMessages(first.sessionId);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
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
  assert.equal(reopened.getChatSession(first.sessionId).reasoningEffort, "high");
  assert.equal(reopened.listChatMessages(first.sessionId).length, 4);
  assert.equal(reopened.getChatTurn(blocked.turnId).status, "cancelled");
  assert.equal(reopened.getChatTurn(blocked.turnId).reasoningEffort, "high");
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
  const processRunner: ProviderProcessRunner = async (options) => {
    observedArgs.set(options.executable, options.args);
    if (options.executable === "fixture-codex") {
      options.onStdout([
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Answer" } }),
        JSON.stringify({ type: "item.started", item: { id: "read", type: "command_execution", command: "git status --short" } }),
        JSON.stringify({ type: "item.completed", item: { id: "read", type: "command_execution", aggregated_output: "clean", exit_code: 0 } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } }),
      ].join("\n"));
    } else {
      options.onStdout([
        JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { text: "Answer" } } }),
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
    attachments: [{ path: "README.md" }],
    sequence: 1,
    createdAt: "2026-08-04T00:00:00.000Z",
  }];
  const run = async (runnerId: "codex-cli" | "claude-code") => {
    const events: string[] = [];
    const answer = await registry.get(runnerId).execute({
      repositoryRoot: "/private/repository",
      model: "fixture-model",
      ...(runnerId === "codex-cli" ? { reasoningEffort: "high" } : {}),
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
    "chat.tool.started",
    "chat.tool.output",
    "chat.tool.completed",
    "chat.usage",
  ]);
  assert.deepEqual(observedArgs.get("fixture-codex")?.slice(0, 4), ["exec", "--sandbox", "read-only", "--ephemeral"]);
  assert.equal(observedArgs.get("fixture-codex")?.includes("--ignore-user-config"), true);
  assert.equal(observedArgs.get("fixture-codex")?.includes("--ignore-rules"), true);
  assert.equal(observedArgs.get("fixture-codex")?.includes('model_reasoning_effort="high"'), true);
  assert.equal(observedArgs.get("claude")?.includes("--safe-mode"), true);
  assert.equal(observedArgs.get("claude")?.includes("--strict-mcp-config"), true);
  assert.equal(observedArgs.get("claude")?.includes("Read,Glob,Grep"), true);
  assert.equal(observedArgs.get("claude")?.some((argument) => /Edit|Write|Bash/.test(argument)), false);

  const mcpRegistry = new RepositoryChatAdapterRegistry({
    processRunner: async (options) => {
      options.onStdout([
        JSON.stringify({ type: "item.started", item: { id: "external", type: "mcp_tool_call", tool: "mutate" } }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Unsafe answer" } }),
      ].join("\n"));
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
