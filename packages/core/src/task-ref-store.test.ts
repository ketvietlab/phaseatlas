import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { TASK_ROOT, TaskRefError, TaskRefStore } from "./task-ref-store.js";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
};

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "phaseatlas-ref-test-"));
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "user.email", "test@local");
  await writeFile(path.join(root, "README.md"), "code\n", "utf8");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "code");
  return root;
}

const task = async (root: string, id: string, body: string): Promise<void> => {
  const directory = path.join(root, TASK_ROOT, "workspaces", "w", "tasks");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${id}.yaml`), body, "utf8");
};

const readTask = (root: string, id: string): Promise<string> =>
  readFile(path.join(root, TASK_ROOT, "workspaces", "w", "tasks", `${id}.yaml`), "utf8");

/**
 * A commit made to the ref by somebody else — another machine's push, or a second
 * process. Built with plumbing from an existing commit so it never disturbs the
 * working tree this side is meanwhile editing, which is the whole point: the two
 * sides have to fork from a shared base for there to be anything to merge.
 */
async function foreignCommit(
  root: string,
  ref: string,
  parent: string,
  changes: Record<string, string>,
): Promise<string> {
  const index = path.join(root, ".git", "foreign-index");
  const run = (args: string[]) =>
    execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_INDEX_FILE: index,
        GIT_AUTHOR_NAME: "Other",
        GIT_AUTHOR_EMAIL: "other@local",
        GIT_COMMITTER_NAME: "Other",
        GIT_COMMITTER_EMAIL: "other@local",
      },
    });
  await run(["read-tree", `${parent}^{tree}`]);
  for (const [file, body] of Object.entries(changes)) {
    const staging = path.join(root, ".git", `foreign-${file}`);
    await writeFile(staging, body, "utf8");
    const blob = (await run(["hash-object", "-w", staging])).stdout.trim();
    await rm(staging, { force: true });
    await run(["update-index", "--add", "--cacheinfo", `100644,${blob},${TASK_ROOT}/workspaces/w/tasks/${file}`]);
  }
  const tree = (await run(["write-tree"])).stdout.trim();
  const commit = (await run(["commit-tree", tree, "-p", parent, "-m", "elsewhere"])).stdout.trim();
  await run(["update-ref", ref, commit, parent]);
  await rm(index, { force: true });
  return commit;
}

test("task ref: seeds from the working tree and keeps tasks out of the code branch", async () => {
  const root = await repository();
  const store = new TaskRefStore(root);

  await task(root, "PHA-001", "objective: first\n");
  const seeded = await store.sync();
  assert.equal(seeded.action, "seeded");
  assert.ok(seeded.commit);

  // The ref holds the tasks...
  const listed = await git(root, "ls-tree", "-r", "--name-only", store.ref);
  assert.match(listed, /\.phaseatlas\/workspaces\/w\/tasks\/PHA-001\.yaml/);
  // ...and its tree contains nothing else, so it is not a branch anyone works on.
  const top = (await git(root, "ls-tree", "--name-only", `${store.ref}^{tree}`)).trim().split("\n");
  assert.deepEqual(top, [TASK_ROOT]);

  // The code branch never sees them.
  const onMain = await git(root, "ls-tree", "-r", "--name-only", "main");
  assert.doesNotMatch(onMain, /\.phaseatlas/);
  await rm(root, { recursive: true, force: true });
});

test("task ref: materializes the cache, including deletions made elsewhere", async () => {
  const root = await repository();
  const store = new TaskRefStore(root);
  await task(root, "PHA-001", "objective: first\n");
  await task(root, "PHA-002", "objective: second\n");
  await store.sync();

  // A second checkout of the same repository removes one task and records it.
  await rm(path.join(root, TASK_ROOT, "workspaces", "w", "tasks", "PHA-002.yaml"));
  await store.commit("phaseatlas: drop PHA-002");

  // Something puts a stale file back; materializing restores exactly the ref.
  await task(root, "PHA-002", "objective: stale\n");
  await store.materialize();
  const remaining = await readdir(path.join(root, TASK_ROOT, "workspaces", "w", "tasks"));
  assert.deepEqual(remaining, ["PHA-001.yaml"], "a task deleted in the ref must not linger in the cache");
  await rm(root, { recursive: true, force: true });
});

test("task ref: a local edit is committed before the cache is written back over it", async () => {
  const root = await repository();
  const store = new TaskRefStore(root);
  await task(root, "PHA-001", "objective: first\n");
  await store.sync();

  // Someone edits the cache by hand, then the worker restarts.
  await task(root, "PHA-001", "objective: edited by hand\n");
  const synced = await store.sync();
  assert.equal(synced.action, "committed");
  assert.match(await readTask(root, "PHA-001"), /edited by hand/, "the edit survives the restart");
  await rm(root, { recursive: true, force: true });
});

test("task ref: concurrent writes to different tasks merge instead of overwriting", async () => {
  const root = await repository();
  await task(root, "PHA-001", "objective: first\n");
  const store = new TaskRefStore(root);
  const base = (await store.sync()).commit as string;

  // This side starts an edit of its own: a new task, not yet recorded.
  await task(root, "PHA-002", "objective: mine\n");
  // Somebody else records a different task against the same base. Both sides now
  // descend from `base`, which is exactly the fork a merge has to resolve.
  await foreignCommit(root, store.ref, base, { "PHA-009.yaml": "objective: from elsewhere\n" });

  const result = await store.commit("phaseatlas: add PHA-002");
  assert.equal(result.merged, true, "a different task must merge rather than overwrite");

  await store.materialize();
  const files = (await readdir(path.join(root, TASK_ROOT, "workspaces", "w", "tasks"))).sort();
  assert.deepEqual(files, ["PHA-001.yaml", "PHA-002.yaml", "PHA-009.yaml"], "no write is lost");
  await rm(root, { recursive: true, force: true });
});

test("task ref: the same task changed on both sides is refused, not guessed", async () => {
  const root = await repository();
  await task(root, "PHA-001", "objective: first\n");
  const store = new TaskRefStore(root);
  const base = (await store.sync()).commit as string;

  // Both sides change the same task, from the same base. Nothing can decide this.
  await task(root, "PHA-001", "objective: mine\n");
  await foreignCommit(root, store.ref, base, { "PHA-001.yaml": "objective: theirs\n" });

  await assert.rejects(
    () => store.commit("phaseatlas: edit PHA-001"),
    (error: TaskRefError) =>
      error.code === "E_TASK_REF_CONFLICT" && error.conflicts.some((file) => file.includes("PHA-001")),
    "the same task on both sides must be reported, never merged silently",
  );
  await rm(root, { recursive: true, force: true });
});

test("task ref: a ref that carries code is refused as a task store", async () => {
  const root = await repository();
  // Point the store at the code branch, which is exactly the mistake this undoes.
  const store = new TaskRefStore(root, { ref: "refs/heads/main" });
  await task(root, "PHA-001", "objective: first\n");
  await assert.rejects(
    () => store.sync(),
    (error: TaskRefError) => error.code === "E_TASK_REF_NOT_A_STORE",
    "a branch holding code must never be written to as a task store",
  );
  await rm(root, { recursive: true, force: true });
});

test("task ref: an unchanged store is a no-op", async () => {
  const root = await repository();
  const store = new TaskRefStore(root);
  await task(root, "PHA-001", "objective: first\n");
  const seeded = await store.sync();
  const again = await store.commit("phaseatlas: nothing changed");
  assert.equal(again.unchanged, true);
  assert.equal(again.commit, seeded.commit, "an unchanged store writes no commit");
  assert.equal((await store.sync()).action, "materialized");
  await rm(root, { recursive: true, force: true });
});

test("task ref: a repository with no tasks stays empty rather than committing nothing", async () => {
  const root = await repository();
  const store = new TaskRefStore(root);
  const synced = await store.sync();
  assert.equal(synced.action, "empty");
  assert.equal(synced.commit, null);
  assert.equal(await store.head(), null, "no ref is created until there is something to store");
  await rm(root, { recursive: true, force: true });
});
