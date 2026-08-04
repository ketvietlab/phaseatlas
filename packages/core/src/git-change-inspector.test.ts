import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { captureGitState, inspectGitChanges, type GitCommand } from "./git-change-inspector.js";

const execFileAsync = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root });
}

test("flags traversal, git metadata, forbidden paths, out-of-scope files, and symlink escapes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-change-policy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const worktreePath = path.join(root, "worktree");
  await mkdir(path.join(worktreePath, "allowed"), { recursive: true });
  const outsidePath = path.join(root, "outside.txt");
  await writeFile(outsidePath, "outside\n");
  await symlink(outsidePath, path.join(worktreePath, "allowed", "link.txt"));
  const git: GitCommand = async (args) => args[0] === "diff"
    ? "M\0README.md\0M\0forbidden/secret.ts\0M\0../escape\0M\0.git/config\0M\0allowed/package.json\0M\0allowed/migrations/001.sql\0"
    : "allowed/link.txt\0allowed/new.ts\0";
  const changes = await inspectGitChanges({
    worktreePath,
    scope: {
      allowedPaths: ["allowed"],
      forbiddenPaths: ["forbidden"],
      writable: true,
      allowDependencyChanges: false,
      allowDatabaseMigrations: false,
      allowExternalNetwork: false,
    },
    git,
  });
  const byPath = new Map(changes.map((change) => [change.path, change.policyViolations]));
  assert.deepEqual(byPath.get("allowed/new.ts"), []);
  assert.deepEqual(byPath.get("allowed/link.txt"), ["symlink_escape"]);
  assert.ok(byPath.get("README.md")?.includes("outside_allowed_paths"));
  assert.ok(byPath.get("forbidden/secret.ts")?.includes("forbidden_path"));
  assert.deepEqual(byPath.get("../escape"), ["unsafe_path"]);
  assert.deepEqual(byPath.get(".git/config"), ["unsafe_path"]);
  assert.deepEqual(byPath.get("allowed/package.json"), ["dependency_change_not_allowed"]);
  assert.deepEqual(byPath.get("allowed/migrations/001.sql"), ["database_migration_not_allowed"]);
});

test("fingerprints large untracked files and embedded repositories", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-git-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init");
  await git(root, "config", "user.email", "phaseatlas@example.test");
  await git(root, "config", "user.name", "PhaseAtlas Test");
  await writeFile(path.join(root, "README.md"), "root\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "root");

  const embedded = path.join(root, "embedded");
  await mkdir(embedded);
  await git(embedded, "init");
  await git(embedded, "config", "user.email", "phaseatlas@example.test");
  await git(embedded, "config", "user.name", "PhaseAtlas Test");
  await writeFile(path.join(embedded, "tracked.txt"), "before\n");
  await git(embedded, "add", "tracked.txt");
  await git(embedded, "commit", "-m", "embedded");
  const largeFile = path.join(root, "large.bin");
  await writeFile(largeFile, "");
  await truncate(largeFile, 11 * 1024 * 1024);

  const before = await captureGitState({ worktreePath: root });
  await writeFile(path.join(embedded, "tracked.txt"), "after\n");
  const after = await captureGitState({ worktreePath: root });
  assert.notEqual(after, before);
});
