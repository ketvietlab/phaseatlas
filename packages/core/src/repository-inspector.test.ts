import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("rejects directories that are not Git repositories", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-not-git-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(RepositoryInspector.open(root), /Git repository/);
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
