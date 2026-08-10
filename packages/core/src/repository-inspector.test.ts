import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  validatePlanningProposalSet,
  validateTaskContent,
  validateTaskProposalSet,
} from "./proposal-service.js";
import { listRepositoryFiles, readRepositoryFile, saveRepositoryFile } from "./repository-files.js";
import { RepositoryInspector } from "./repository-inspector.js";

test("inspects a configured repository and counts workspace tasks", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-core-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".phaseatlas", "workspaces", "core", "tasks"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, ".phaseatlas", "repository.yaml"),
    "schemaVersion: phaseatlas.repository/v1\nid: repo-test\nname: Test Atlas\n",
  );
  await writeFile(
    path.join(root, ".phaseatlas", "workspaces", "core", "workspace.yaml"),
    "schemaVersion: phaseatlas.workspace/v1\nslug: core\nname: Core\ndescription: Core workspace\n",
  );
  await writeFile(
    path.join(root, ".phaseatlas", "workspaces", "core", "tasks", "PHA-001.yaml"),
    "schemaVersion: phaseatlas.task/v1\nid: PHA-001\n",
  );

  const inspector = await RepositoryInspector.open(root);
  const repository = await inspector.describe();
  const workspaces = await inspector.listWorkspaces();

  assert.equal(repository.id, "repo-test");
  assert.equal(repository.configuration, "configured");
  assert.equal(repository.workspaceCount, 1);
  assert.equal(workspaces[0]?.slug, "core");
  assert.equal(workspaces[0]?.taskCount, 1);
});

test("loads canonical tasks from a dedicated registry root while preserving checkout identity", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-code-checkout-"));
  const registryRoot = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-task-contracts-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(registryRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".phaseatlas"));
  await writeFile(path.join(root, ".phaseatlas", "repository.yaml"), [
    "schemaVersion: phaseatlas.repository/v1",
    "id: repo-test",
    "name: Test Atlas",
    "taskRegistry:",
    "  remote: origin",
    "  ref: refs/heads/phaseatlas/tasks",
    "  defaultDeliveryRef: refs/heads/develop",
    "",
  ].join("\n"));
  const tasksRoot = await createConfiguredRepository(registryRoot);
  await writeFile(path.join(tasksRoot, "PHA-001.yaml"), validTask({ id: "PHA-001" }));

  const inspector = await RepositoryInspector.open(root, { contractRoot: registryRoot });
  inspector.setRegistrySource({
    remote: "origin",
    ref: "refs/heads/phaseatlas/tasks",
    defaultDeliveryRef: "refs/heads/develop",
    commit: "a".repeat(40),
    syncState: "current",
    changedPaths: [],
  });
  const repository = await inspector.describe();
  const snapshot = await inspector.taskSnapshot();

  assert.equal(repository.path, await realpath(root));
  assert.equal(repository.workspaceCount, 1);
  assert.equal(repository.taskRegistry?.ref, "refs/heads/phaseatlas/tasks");
  assert.equal(snapshot.tasks[0]?.key.taskId, "PHA-001");
  assert.equal(snapshot.registry?.commit, "a".repeat(40));
});

test("rejects directories that are not Git repositories", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-not-git-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(RepositoryInspector.open(root), /Git repository/);
});

test("projects deterministic legacy candidates without creating canonical tasks", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-legacy-"));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-legacy-other-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "TODO.md"), [
    "## Delivery {#delivery}",
    "- [ ] [LEG-002]  Ship   renderer  ::  Deliver   the renderer. ",
    "- [x] [LEG-001] Normalize café :: Preserve Unicode identity.",
  ].join("\r\n"));
  await writeFile(path.join(root, "docs", "TODO.md"), [
    "## Delivery {#delivery}",
    "- [X] [LEG-001] Normalize cafe\u0301 :: Preserve Unicode identity.",
  ].join("\n"));
  await mkdir(path.join(otherRoot, ".git"));
  await mkdir(path.join(otherRoot, "docs"));
  await writeFile(path.join(otherRoot, "docs", "TODO.md"), await readFile(path.join(root, "docs", "TODO.md")));
  await writeFile(path.join(otherRoot, "TODO.md"), await readFile(path.join(root, "TODO.md")));

  const inspector = await RepositoryInspector.open(root);
  const repository = await inspector.describe();
  const canonical = await inspector.taskSnapshot();
  const first = await inspector.legacySnapshot();
  inspector.invalidate();
  const second = await inspector.legacySnapshot();
  const fromOtherCheckout = await (await RepositoryInspector.open(otherRoot)).legacySnapshot();

  assert.equal(repository.configuration, "legacy");
  assert.equal(canonical.tasks.length, 0);
  assert.deepEqual(first, second);
  assert.deepEqual(first, fromOtherCheckout);
  assert.deepEqual(first.candidates.map((candidate) => candidate.nativeId), ["LEG-001", "LEG-002"]);
  assert.equal(first.candidates[0]?.candidateId, "legacy_0d54e701694c91540eebd91fc0c0c990");
  assert.equal(first.candidates[0]?.title, "Normalize café");
  assert.equal(first.candidates[0]?.completionHint, "completed");
  assert.deepEqual(first.candidates[0]?.provenance, {
    primary: { path: "TODO.md", nativeId: "LEG-001", line: 3, column: 1 },
    identicalDuplicates: [{ path: "docs/TODO.md", nativeId: "LEG-001", line: 2, column: 1 }],
  });
  assert.equal(first.candidates[0]?.warnings[0]?.code, "LEGACY_DUPLICATE_IDENTICAL");
  assert.equal(first.issues.filter((issue) => issue.code === "LEGACY_SOURCE_MISSING").length, 2);
});

test("invalidates the cached legacy projection after source changes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-legacy-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "TODO.md"), "## Core {#core}\n- [ ] [LEG-001] First title :: First objective.\n");
  const inspector = await RepositoryInspector.open(root);

  const first = await inspector.legacySnapshot();
  await writeFile(path.join(root, "TODO.md"), "## Core {#core}\n- [ ] [LEG-002] Second title :: Second objective.\n");
  assert.equal((await inspector.legacySnapshot()).candidates[0]?.nativeId, "LEG-001");
  inspector.invalidate();
  const refreshed = await inspector.legacySnapshot();

  assert.equal(first.candidates[0]?.nativeId, "LEG-001");
  assert.equal(refreshed.candidates[0]?.nativeId, "LEG-002");
  assert.equal(refreshed.candidates[0]?.candidateId, "legacy_68f2eece99e5a928337079abfbbeb8bc");
});

test("excludes conflicting and malformed legacy entries with located issues", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-legacy-errors-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "TODO.md"), [
    "- [ ] [ORPHAN] No phase :: Must not be accepted.",
    "## Core {#core}",
    "- [ ] [bad-id] Invalid identifier :: Must not be accepted.",
    "- [ ] malformed task",
    "- [ ] [LEG-001] Stable title :: First objective.",
    "- [ ] [LEG-003] Valid sibling :: Keep this candidate.",
  ].join("\n"));
  await writeFile(path.join(root, "docs", "TODO.md"), [
    "## Core {#core}",
    "- [ ] [LEG-001] Stable title :: Conflicting objective.",
  ].join("\n"));

  const snapshot = await (await RepositoryInspector.open(root)).legacySnapshot();
  const codes = new Set(snapshot.issues.map((issue) => issue.code));

  assert.deepEqual(snapshot.candidates.map((candidate) => candidate.nativeId), ["LEG-003"]);
  assert.equal(codes.has("LEGACY_TASK_OUTSIDE_PHASE"), true);
  assert.equal(codes.has("LEGACY_TASK_ID_INVALID"), true);
  assert.equal(codes.has("LEGACY_TASK_SYNTAX_INVALID"), true);
  assert.equal(codes.has("LEGACY_DUPLICATE_CONFLICT"), true);
  assert.deepEqual(snapshot.issues.find((issue) => issue.code === "LEGACY_TASK_OUTSIDE_PHASE"), {
    severity: "error",
    code: "LEGACY_TASK_OUTSIDE_PHASE",
    message: "Task entries must appear below a valid phase heading.",
    sourcePath: "TODO.md",
    line: 1,
    column: 1,
  });
});

test("fails closed for unsafe and invalid legacy source files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-legacy-files-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "target.md"), "## Core {#core}\n- [ ] [LEG-001] Hidden :: Symlink content.\n");
  await symlink("target.md", path.join(root, "TODO.md"));
  await writeFile(path.join(root, "docs", "TODO.md"), Buffer.from([0xc3, 0x28]));
  await writeFile(path.join(root, "ROADMAP.md"), "x".repeat(1024 * 1024 + 1));
  await writeFile(path.join(root, "docs", "ROADMAP.md"), "```ts\n- [ ] [LEG-002] Hidden :: Fence never closes.\n");

  const snapshot = await (await RepositoryInspector.open(root)).legacySnapshot();
  const codes = snapshot.issues.map((issue) => issue.code);

  assert.equal(snapshot.candidates.length, 0);
  assert.deepEqual(codes, [
    "LEGACY_SOURCE_SYMLINK",
    "LEGACY_SOURCE_INVALID_UTF8",
    "LEGACY_SOURCE_TOO_LARGE",
    "LEGACY_MARKDOWN_UNTERMINATED_FENCE",
  ]);
});

test("does not follow a legacy source parent directory outside the repository", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-legacy-parent-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-legacy-outside-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(outside, "TODO.md"), "## Core {#core}\n- [ ] [LEG-001] Outside :: Must never be read.\n");
  await symlink(outside, path.join(root, "docs"));

  const snapshot = await (await RepositoryInspector.open(root)).legacySnapshot();

  assert.equal(snapshot.candidates.length, 0);
  assert.equal(snapshot.issues.some((issue) =>
    issue.sourcePath === "docs/TODO.md" && issue.code === "LEGACY_SOURCE_SYMLINK"
  ), true);
  assert.equal(snapshot.issues.some((issue) =>
    issue.sourcePath === "docs/ROADMAP.md" && issue.code === "LEGACY_SOURCE_SYMLINK"
  ), true);
});

test("configured repositories never inspect or merge legacy candidates", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-configured-authority-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const tasksRoot = await createConfiguredRepository(root);
  await writeFile(path.join(tasksRoot, "PHA-001.yaml"), validTask({ id: "PHA-001" }));
  await writeFile(path.join(tasksRoot, "PHA-002.yaml"), "schemaVersion: phaseatlas.task/v1\nid: PHA-002\n");
  await writeFile(path.join(root, "TODO.md"), "## Core {#core}\n- [ ] [LEG-001] Legacy title :: Must stay isolated.\n");

  const inspector = await RepositoryInspector.open(root);
  const canonical = await inspector.taskSnapshot();
  const legacy = await inspector.legacySnapshot();

  assert.deepEqual(canonical.tasks.map((task) => task.key.taskId), ["PHA-001"]);
  assert.equal(canonical.issues.some((issue) => issue.sourcePath.endsWith("PHA-002.yaml")), true);
  assert.deepEqual(legacy, { candidates: [], issues: [] });
});

test("a present invalid manifest never falls back to legacy inspection", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-invalid-authority-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".phaseatlas"));
  await writeFile(path.join(root, ".phaseatlas", "repository.yaml"), "schemaVersion: unsupported\nid: repo-test\nname: Invalid\n");
  await writeFile(path.join(root, "TODO.md"), "## Core {#core}\n- [ ] [LEG-001] Legacy title :: Must not become a fallback.\n");

  const inspector = await RepositoryInspector.open(root);
  await assert.rejects(inspector.legacySnapshot(), /schemaVersion must be phaseatlas.repository\/v1/);
});

test("missing manifest isolates legacy inspection from partial canonical directories", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-legacy-remnants-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".phaseatlas", "workspaces", "broken"), { recursive: true });
  await writeFile(path.join(root, ".phaseatlas", "workspaces", "broken", "workspace.yaml"), "not: a valid workspace\n");
  await writeFile(path.join(root, "TODO.md"), "## Core {#core}\n- [ ] [LEG-001] Legacy title :: Remains inspectable.\n");

  const inspector = await RepositoryInspector.open(root);
  assert.equal((await inspector.describe()).configuration, "legacy");
  assert.deepEqual(await inspector.listWorkspaces(), []);
  assert.equal((await inspector.legacySnapshot()).candidates[0]?.nativeId, "LEG-001");
});

const validTask = (options: {
  id: string;
  title?: string;
  dependencies?: string;
  allowedPath?: string;
}) => `schemaVersion: phaseatlas.task/v1
id: ${options.id}
title: ${options.title ?? options.id}
kind: code
phase: foundation
state: ready
priority: normal
objective: Deliver ${options.id}.
owners:
  - Core
dependencies:${options.dependencies ?? " []"}
scope:
  allowedPaths:
    - ${options.allowedPath ?? "packages/**"}
  forbiddenPaths: []
  writable: true
  allowDependencyChanges: false
  allowDatabaseMigrations: false
  allowExternalNetwork: false
acceptanceCriteria:
  - id: AC-1
    statement: The change is verified.
    verification:
      type: command
      commandId: verify
verification:
  - id: verify
    command: pnpm test
    timeoutSeconds: 300
    required: true
evidenceRequirements:
  - type: test
`;

async function createConfiguredRepository(root: string): Promise<string> {
  const tasksRoot = path.join(root, ".phaseatlas", "workspaces", "core", "tasks");
  await mkdir(path.join(root, ".git"));
  await mkdir(tasksRoot, { recursive: true });
  await writeFile(
    path.join(root, ".phaseatlas", "repository.yaml"),
    "schemaVersion: phaseatlas.repository/v1\nid: repo-test\nname: Test Atlas\n",
  );
  await writeFile(
    path.join(root, ".phaseatlas", "workspaces", "core", "workspace.yaml"),
    "schemaVersion: phaseatlas.workspace/v1\nslug: core\nname: Core\ndescription: Core workspace\n",
  );
  return tasksRoot;
}

test("normalizes canonical tasks, revisions, and dependency edges", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-task-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const tasksRoot = await createConfiguredRepository(root);
  await writeFile(path.join(tasksRoot, "PHA-001.yaml"), validTask({ id: "PHA-001" }));
  await writeFile(
    path.join(tasksRoot, "PHA-002.yaml"),
    validTask({
      id: "PHA-002",
      dependencies: `
  - taskKey: PHA-001
    relation: blocks_start
    requiredState: done`,
    }),
  );

  const inspector = await RepositoryInspector.open(root);
  const first = await inspector.taskSnapshot();
  inspector.invalidate();
  const second = await inspector.taskSnapshot();

  assert.equal(first.tasks.length, 2);
  assert.equal(first.issues.length, 0);
  assert.deepEqual(first.graph.edges, [{
    fromTaskKey: "core/PHA-002",
    toTaskKey: "core/PHA-001",
    relation: "blocks_start",
  }]);
  assert.equal(first.tasks[1]?.dependencies[0]?.taskKey, "core/PHA-001");
  assert.match(first.tasks[0]?.revision ?? "", /^[a-f0-9]{64}$/);
  assert.equal(first.tasks[0]?.revision, second.tasks[0]?.revision);
});

test("reports invalid tasks, missing dependencies, and dependency cycles", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-task-errors-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const tasksRoot = await createConfiguredRepository(root);
  await writeFile(
    path.join(tasksRoot, "PHA-001.yaml"),
    validTask({
      id: "PHA-001",
      dependencies: `
  - taskKey: PHA-002
    relation: blocks_start`,
    }),
  );
  await writeFile(
    path.join(tasksRoot, "PHA-002.yaml"),
    validTask({
      id: "PHA-002",
      dependencies: `
  - taskKey: PHA-001
    relation: blocks_start
  - taskKey: PHA-404
    relation: related`,
    }),
  );
  await writeFile(
    path.join(tasksRoot, "PHA-003.yaml"),
    validTask({ id: "PHA-003", allowedPath: "../outside/**" }),
  );

  const snapshot = await (await RepositoryInspector.open(root)).taskSnapshot();
  const codes = new Set(snapshot.issues.map((issue) => issue.code));

  assert.equal(snapshot.tasks.length, 2);
  assert.equal(snapshot.graph.hasCycles, true);
  assert.equal(codes.has("TASK_SCOPE_UNSAFE_PATH"), true);
  assert.equal(codes.has("TASK_DEPENDENCY_MISSING"), true);
  assert.equal(codes.has("TASK_DEPENDENCY_CYCLE"), true);
});

test("fails closed when a configured workspace manifest is ambiguous", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-invalid-workspace-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createConfiguredRepository(root);
  await writeFile(
    path.join(root, ".phaseatlas", "workspaces", "core", "workspace.yaml"),
    "schemaVersion: phaseatlas.workspace/v1\nslug: another-core\nname: Core\ndescription: Core workspace\n",
  );

  const inspector = await RepositoryInspector.open(root);
  await assert.rejects(inspector.listWorkspaces(), /slug must match/);
});

const proposalSet = {
  workspaces: [],
  tasks: [{
    temporaryId: "proposal-1",
    title: "Publish a canonical task",
    objective: "Create a reviewed task contract from a planning proposal.",
    kind: "code",
    workspaceSlug: "core",
    phaseId: "planning",
    priority: "normal",
    suggestedDependencies: [],
    suggestedPaths: ["packages/core/**"],
    acceptanceCriteria: [{
      statement: "The published task passes canonical validation.",
      verificationSuggestion: "Run the core test suite.",
    }],
    risks: [],
    questions: [],
    confidence: "high",
  }],
};

test("validates and publishes reviewed task proposals", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-proposal-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createConfiguredRepository(root);

  const validation = validateTaskProposalSet(proposalSet);
  assert.equal(validation.issues.length, 0);
  assert.equal(validation.proposals?.tasks.length, 1);

  const inspector = await RepositoryInspector.open(root);
  const snapshot = await inspector.publishTaskProposals("core", proposalSet);
  const source = await readFile(
    path.join(root, ".phaseatlas", "workspaces", "core", "tasks", "COR-001.yaml"),
    "utf8",
  );

  assert.equal(snapshot.tasks[0]?.key.taskId, "COR-001");
  assert.equal(snapshot.tasks[0]?.state, "planned");
  assert.equal(snapshot.issues.length, 0);
  assert.match(source, /state: planned/);
  assert.equal(snapshot.tasks[0]?.content, undefined);
});

test("initializes an optional Markdown task body after outline publication", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-content-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createConfiguredRepository(root);
  const inspector = await RepositoryInspector.open(root);
  const published = await inspector.publishTaskProposals("core", proposalSet);
  const initialRevision = published.tasks[0]?.revision;
  const body = "# Context\n\nThis task now has repository-specific implementation context.\n\n# Requirements\n\n- Preserve the contract.\n";

  const initialized = await inspector.saveTaskContent("core/COR-001", body);
  const task = initialized.tasks[0];
  const yaml = await readFile(path.join(root, ".phaseatlas", "workspaces", "core", "tasks", "COR-001.yaml"), "utf8");

  assert.equal(task?.content?.path, ".phaseatlas/workspaces/core/tasks/COR-001.md");
  assert.equal(task?.content?.body, body);
  assert.notEqual(task?.revision, initialRevision);
  assert.match(yaml, /content:\n  path: COR-001.md/);
});

test("validates generated task body length and safely edits repository text files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-files-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "README.md"), "before\n");

  assert.equal(validateTaskContent({ body: "short" }).content, null);
  const generatedBody = [
    "# Context\n\n" + "Useful repository detail. ".repeat(14),
    "# Requirements\n\n- The expected behavior is explicit.",
    "# Implementation notes\n\n- Inspect packages/core before changing the boundary.",
    "# Constraints\n\n- Do not enable external network access.",
    "# Verification plan\n\n- Run the focused tests and inspect the task projection.",
  ].join("\n\n");
  assert.ok(validateTaskContent({ body: generatedBody }).content);
  assert.deepEqual((await listRepositoryFiles(root)).map((entry) => entry.name), ["README.md"]);
  await saveRepositoryFile(root, "README.md", "after\n");
  assert.equal((await readRepositoryFile(root, "README.md")).content, "after\n");
  await assert.rejects(readRepositoryFile(root, "../outside.txt"), /outside/);
});

test("rejects proposal paths outside the repository boundary", () => {
  const unsafe = structuredClone(proposalSet);
  unsafe.tasks[0]!.suggestedPaths = ["../outside/**"];
  const validation = validateTaskProposalSet(unsafe);
  assert.equal(validation.proposals, null);
  assert.equal(validation.issues.some((issue) => issue.code === "PROPOSAL_PATH_UNSAFE"), true);
});

const workspaceProposalSet = {
  workspaces: [{
    temporaryId: "workspace-desktop",
    slug: "desktop",
    name: "Desktop",
    description: "Electron runtime and desktop user experience.",
    rationale: "The repository contains a distinct desktop application boundary.",
    confidence: "high",
  }],
  tasks: [{
    ...proposalSet.tasks[0],
    temporaryId: "desktop-task-1",
    workspaceSlug: "desktop",
    suggestedPaths: ["apps/desktop/**"],
  }],
};

test("publishes a reviewed workspace and starter tasks as one planning result", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-workspace-proposal-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".phaseatlas"), { recursive: true });
  await writeFile(
    path.join(root, ".phaseatlas", "repository.yaml"),
    "schemaVersion: phaseatlas.repository/v1\nid: repo-test\nname: Test Atlas\n",
  );

  const validation = validatePlanningProposalSet(workspaceProposalSet, {
    target: { type: "repository" },
    existingWorkspaceSlugs: [],
  });
  assert.equal(validation.issues.length, 0);

  const inspector = await RepositoryInspector.open(root);
  const snapshot = await inspector.publishPlanningProposals({ type: "repository" }, workspaceProposalSet);
  const manifest = await readFile(
    path.join(root, ".phaseatlas", "workspaces", "desktop", "workspace.yaml"),
    "utf8",
  );

  assert.match(manifest, /slug: desktop/);
  assert.equal((await inspector.listWorkspaces())[0]?.name, "Desktop");
  assert.equal(snapshot.tasks[0]?.key.taskId, "DES-001");
  assert.equal(snapshot.tasks[0]?.key.workspaceSlug, "desktop");
  assert.equal(snapshot.issues.length, 0);
});

test("rejects a workspace proposal whose slug already exists", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-workspace-collision-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createConfiguredRepository(root);
  const colliding = structuredClone(workspaceProposalSet);
  colliding.workspaces[0]!.slug = "core";
  colliding.tasks[0]!.workspaceSlug = "core";

  const inspector = await RepositoryInspector.open(root);
  await assert.rejects(
    inspector.publishPlanningProposals({ type: "repository" }, colliding),
    /already exists/,
  );
});
