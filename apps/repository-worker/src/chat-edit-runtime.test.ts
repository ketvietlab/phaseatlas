import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ChatEditSpec, RepositorySummary, RunnerDescriptor } from "@phaseatlas/contracts";
import { CheckoutOperationalStore, WorktreeLeaseManager } from "@phaseatlas/core";
import { ChatEditAdapterRegistry, type ChatEditAdapter } from "./chat-edit-adapter-registry.js";
import { ChatEditRuntime } from "./chat-edit-runtime.js";

const exec = promisify(execFile);

async function fixtureRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-chat-edit-"));
  await exec("git", ["init"], { cwd: root });
  await exec("git", ["config", "user.email", "phaseatlas@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "PhaseAtlas Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for isolated chat edit.");
}

test("requires confirmation, isolates edits, derives review evidence, and applies only after acceptance", async () => {
  const root = await fixtureRepository();
  const support = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-chat-edit-support-"));
  const checkoutId = "b".repeat(20);
  const store = new CheckoutOperationalStore(path.join(support, "operations.sqlite"), checkoutId);
  const leases = new WorktreeLeaseManager(root, checkoutId, store);
  const now = new Date().toISOString();
  store.createChatSession({
    sessionId: "session-one",
    checkoutId,
    runnerId: "codex-cli",
    model: "gpt-fixture",
    reasoningEffort: "high",
    title: "Edit fixture",
    state: "open",
    createdAt: now,
    updatedAt: now,
  });
  store.createChatTurn({
    turn: {
      turnId: "context-turn",
      sessionId: "session-one",
      status: "starting",
      runnerId: "codex-cli",
      model: "gpt-fixture",
      reasoningEffort: "high",
      userMessageId: "context-user",
      createdAt: now,
      updatedAt: now,
    },
    userMessage: {
      messageId: "context-user",
      sessionId: "session-one",
      turnId: "context-turn",
      role: "user",
      content: "Design a settings card based on the attached reference.",
      attachments: [
        { path: "README.md" },
        { type: "image", name: "history.png", mediaType: "image/png", data: "aGlzdG9yeQ==" },
      ],
      sequence: 1,
      createdAt: now,
    },
  });
  store.completeChatTurn({
    turnId: "context-turn",
    assistantMessage: {
      messageId: "context-assistant",
      sessionId: "session-one",
      turnId: "context-turn",
      role: "assistant",
      content: "Use a compact select beside the attachment controls.",
      attachments: [],
      sequence: 2,
      createdAt: now,
    },
  });
  const repository: RepositorySummary = {
    id: "fixture-repository",
    checkoutId,
    name: "fixture",
    path: root,
    configuration: "configured",
    workspaceCount: 1,
    openedAt: now,
  };
  const descriptor: RunnerDescriptor = {
    id: "codex-cli",
    provider: "OpenAI",
    name: "Codex CLI",
    available: true,
    capabilities: ["execution", "repository_write"],
    models: [{ id: "gpt-fixture", displayName: "GPT Fixture", isDefault: true, reasoningEfforts: ["high"], defaultReasoningEffort: "high" }],
    modelDiscovery: { status: "available" },
  };
  let editNumber = 0;
  let observedAccessMode = "";
  let observedAttachmentCount = 0;
  let observedConversation = "";
  const adapter: ChatEditAdapter = {
    runnerId: "codex-cli",
    async execute(context) {
      editNumber += 1;
      observedAccessMode = context.spec.accessMode;
      observedAttachmentCount = context.spec.attachments.length;
      observedConversation = JSON.stringify(context.spec.conversationContext);
      await writeFile(path.join(context.workingDirectory, "README.md"), `# Edited in isolation ${editNumber}\n`, "utf8");
      await writeFile(path.join(context.workingDirectory, "NEW.md"), "new file\n", "utf8");
      context.emit("chat.edit.delta", { text: "Edited the fixture." });
      return "Edited two files in the isolated worktree.";
    },
  };
  const runtime = new ChatEditRuntime(
    store,
    { describe: async () => repository },
    leases,
    { list: async () => [descriptor] },
    { get: () => adapter },
    root,
    checkoutId,
  );

  await assert.rejects(
    runtime.prepare({ sessionId: "session-one", prompt: "Edit files", accessMode: "invalid" as never }),
    /access mode is invalid/,
  );
  const cancelledBeforeApproval = await runtime.prepare({
    sessionId: "session-one",
    prompt: "Prepare an edit but do not start it",
    accessMode: "ask_for_approval",
  });
  assert.equal(runtime.result(cancelledBeforeApproval.editId).status, "awaiting_confirmation");
  assert.equal((await runtime.cancel(cancelledBeforeApproval.editId)).disposition, "cancelled");
  assert.equal(runtime.result(cancelledBeforeApproval.editId).status, "cancelled");
  await assert.rejects(
    runtime.start({ editId: cancelledBeforeApproval.editId, confirmationDigest: cancelledBeforeApproval.confirmationDigest }),
    /current state/,
  );
  const prepared = await runtime.prepare({
    sessionId: "session-one",
    prompt: "Edit the fixture files",
    accessMode: "ask_for_approval",
    attachments: [
      { path: "README.md" },
      { type: "image", name: "reference.png", mediaType: "image/png", data: "aGVsbG8=" },
    ],
  });
  assert.equal(prepared.reasoningEffort, "high");
  assert.equal(prepared.accessMode, "ask_for_approval");
  assert.deepEqual(prepared.scope.allowedPaths, ["**"]);
  assert.deepEqual(prepared.scope.forbiddenPaths, [".git", ".phaseatlas"]);
  assert.equal(prepared.scope.allowDependencyChanges, true);
  assert.equal(prepared.scope.allowDatabaseMigrations, true);
  assert.equal(leases.list().length, 0, "preparation must not allocate a worktree");
  await assert.rejects(runtime.start({ editId: prepared.editId, confirmationDigest: "stale" }), /stale or incomplete/);
  assert.equal(leases.list().length, 0);
  await runtime.start({ editId: prepared.editId, confirmationDigest: prepared.confirmationDigest });
  await waitFor(() => runtime.result(prepared.editId).status === "completed");
  assert.equal(observedAccessMode, "ask_for_approval");
  assert.equal(observedAttachmentCount, 3);
  assert.match(observedConversation, /Design a settings card/);
  assert.match(observedConversation, /compact select/);
  const review = runtime.result(prepared.editId);
  assert.equal(review.reasoningEffort, "high");
  assert.deepEqual(review.changedFiles.map((change) => change.path), ["NEW.md", "README.md"]);
  assert.match(review.patch, /NEW\.md/);
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "# Fixture\n", "canonical checkout must remain unchanged before acceptance");
  const publicEvents = JSON.stringify(runtime.events(prepared.editId, 0, 200).events);
  assert.equal(publicEvents.includes(root), false);
  assert.equal(publicEvents.includes(support), false);
  assert.equal("spec" in runtime.events(prepared.editId, 0, 1).events[0]!.payload, false);
  const accepted = await runtime.accept(prepared.editId);
  assert.equal(accepted.disposition, "accepted");
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "# Edited in isolation 1\n");
  assert.equal(await readFile(path.join(root, "NEW.md"), "utf8"), "new file\n");
  assert.equal(leases.list().at(-1)?.status, "released");

  const retainedConfirmation = await runtime.prepare({
    sessionId: "session-one",
    prompt: "Continue editing the fixture",
    accessMode: "full_access",
  });
  assert.equal(retainedConfirmation.accessMode, "full_access");
  await runtime.start({ editId: retainedConfirmation.editId, confirmationDigest: retainedConfirmation.confirmationDigest });
  await waitFor(() => runtime.result(retainedConfirmation.editId).status === "completed");
  assert.equal(runtime.retain(retainedConfirmation.editId).disposition, "retained");
  await leases.reconcileAbandoned("fixture_restart");
  assert.equal(leases.list().find((lease) => lease.runId === retainedConfirmation.editId)?.status, "abandoned");
  assert.equal((await runtime.recover(retainedConfirmation.editId, "resume_review")).disposition, "pending_review");
  assert.equal((await runtime.discard(retainedConfirmation.editId)).disposition, "discarded");
  assert.equal(leases.list().find((lease) => lease.runId === retainedConfirmation.editId)?.status, "released");

  store.close();
  await rm(root, { recursive: true, force: true });
  await rm(support, { recursive: true, force: true });
});

test("projects image and repository attachments into edit providers", async () => {
  const spec: ChatEditSpec = {
    schemaVersion: "phaseatlas.chat-edit/v1",
    editId: "edit-one",
    sessionId: "session-one",
    checkout: { repositoryId: "repo-one", checkoutId: "checkout-one", canonicalPath: "/private/repository" },
    baseRevision: "a".repeat(40),
    runnerId: "codex-cli",
    model: "model-one",
    prompt: "Follow the visual reference.",
    conversationContext: [{
      role: "user",
      content: "Build the repository settings experience we discussed.",
      attachments: [{ type: "repository", path: "apps/ui/src" }],
    }],
    accessMode: "full_access",
    attachments: [
      { path: "apps/ui/src" },
      { type: "image", name: "reference.png", mediaType: "image/png", data: "aGVsbG8=" },
    ],
    scope: { allowedPaths: ["**"], forbiddenPaths: [".git", ".phaseatlas"], writable: true, allowDependencyChanges: true, allowDatabaseMigrations: true, allowExternalNetwork: false },
    sandbox: "workspace-write",
    createdAt: new Date().toISOString(),
    confirmationDigest: "digest",
  };
  let codexImagePath = "";
  let codexInput = "";
  const codexRegistry = new ChatEditAdapterRegistry({
    codexExecutableResolver: async () => ({ executable: "codex", version: "fixture" }),
    processRunner: async (input) => {
      codexInput = input.stdin ?? "";
      const imageArgument = input.args.indexOf("--image");
      codexImagePath = input.args[imageArgument + 1] ?? "";
      assert.equal(await readFile(codexImagePath, "utf8"), "hello");
      input.onStdout?.(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done" } })}\n`);
      return { stdout: "", stderr: "" };
    },
  });
  await codexRegistry.get("codex-cli").execute({ spec, workingDirectory: "/private/worktree", signal: new AbortController().signal, emit: () => undefined });
  assert.match(codexInput, /apps\/ui\/src/);
  assert.match(codexInput, /Build the repository settings experience/);
  assert.match(codexInput, /Current edit request/);
  await assert.rejects(stat(codexImagePath));

  let claudeInput = "";
  const claudeRegistry = new ChatEditAdapterRegistry({
    processRunner: async (input) => {
      claudeInput = input.stdin ?? "";
      assert.ok(input.args.includes("--input-format"));
      input.onStdout?.(`${JSON.stringify({ type: "result", result: "Done" })}\n`);
      return { stdout: "", stderr: "" };
    },
  });
  await claudeRegistry.get("claude-code").execute({ spec: { ...spec, runnerId: "claude-code" }, workingDirectory: "/private/worktree", signal: new AbortController().signal, emit: () => undefined });
  assert.match(claudeInput, /"type":"image"/);
  assert.match(claudeInput, /aGVsbG8=/);
});
