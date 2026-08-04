import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { RepositorySummary, RunnerDescriptor } from "@phaseatlas/contracts";
import { CheckoutOperationalStore, WorktreeLeaseManager } from "@phaseatlas/core";
import type { ChatEditAdapter } from "./chat-edit-adapter-registry.js";
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
  const adapter: ChatEditAdapter = {
    runnerId: "codex-cli",
    async execute(context) {
      editNumber += 1;
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
    runtime.prepare({ sessionId: "session-one", prompt: "Edit files", scope: { allowedPaths: ["../outside"], forbiddenPaths: [] } }),
    /unsafe or protected/,
  );
  const prepared = await runtime.prepare({
    sessionId: "session-one",
    prompt: "Edit the fixture files",
    scope: { allowedPaths: ["README.md", "NEW.md"], forbiddenPaths: [] },
  });
  assert.equal(prepared.reasoningEffort, "high");
  assert.equal(leases.list().length, 0, "preparation must not allocate a worktree");
  await assert.rejects(runtime.start({ editId: prepared.editId, confirmationDigest: "stale" }), /stale or incomplete/);
  assert.equal(leases.list().length, 0);
  await runtime.start({ editId: prepared.editId, confirmationDigest: prepared.confirmationDigest });
  await waitFor(() => runtime.result(prepared.editId).status === "completed");
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
    scope: { allowedPaths: ["README.md", "NEW.md"], forbiddenPaths: [] },
  });
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
