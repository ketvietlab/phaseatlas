import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectGitChanges, type GitCommand } from "./git-change-inspector.js";

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
