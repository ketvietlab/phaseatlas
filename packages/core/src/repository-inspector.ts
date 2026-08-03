import { createHash } from "node:crypto";
import { access, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  PlanningTarget,
  RepositorySummary,
  TaskSnapshot,
  WorkspaceSummary,
} from "@phaseatlas/contracts";
import { parse } from "yaml";
import { loadTaskSnapshot } from "./task-loader.js";
import {
  publishPlanningProposals as publishPlanning,
  publishTaskProposals as publishProposals,
} from "./proposal-service.js";
import { writeTaskContent } from "./task-content-store.js";

interface RepositoryManifest {
  schemaVersion: "phaseatlas.repository/v1";
  id: string;
  name: string;
}

interface WorkspaceManifest {
  schemaVersion: "phaseatlas.workspace/v1";
  slug: string;
  name: string;
  description: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateRepositoryManifest(value: unknown, filePath: string): RepositoryManifest {
  if (!isRecord(value)) throw new Error(`${filePath} must contain a YAML object.`);
  if (value.schemaVersion !== "phaseatlas.repository/v1") {
    throw new Error(`${filePath}: schemaVersion must be phaseatlas.repository/v1.`);
  }
  if (typeof value.id !== "string" || !value.id.trim()) {
    throw new Error(`${filePath}: id must be a non-empty string.`);
  }
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new Error(`${filePath}: name must be a non-empty string.`);
  }
  return { schemaVersion: value.schemaVersion, id: value.id.trim(), name: value.name.trim() };
}

function validateWorkspaceManifest(
  value: unknown,
  filePath: string,
  directorySlug: string,
): WorkspaceManifest {
  if (!isRecord(value)) throw new Error(`${filePath} must contain a YAML object.`);
  if (value.schemaVersion !== "phaseatlas.workspace/v1") {
    throw new Error(`${filePath}: schemaVersion must be phaseatlas.workspace/v1.`);
  }
  for (const field of ["slug", "name", "description"] as const) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      throw new Error(`${filePath}: ${field} must be a non-empty string.`);
    }
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value.slug as string)) {
    throw new Error(`${filePath}: slug must use lowercase letters, numbers, and hyphens.`);
  }
  if (value.slug !== directorySlug) {
    throw new Error(`${filePath}: slug must match its workspace directory (${directorySlug}).`);
  }
  return {
    schemaVersion: value.schemaVersion,
    slug: value.slug as string,
    name: (value.name as string).trim(),
    description: (value.description as string).trim(),
  };
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readYaml(filePath: string): Promise<unknown | null> {
  try {
    return parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot parse ${filePath}: ${(error as Error).message}`);
  }
}

function localIdentity(canonicalPath: string): string {
  return createHash("sha256").update(canonicalPath).digest("hex").slice(0, 20);
}

export class RepositoryInspector {
  readonly root: string;
  private repository: RepositorySummary | null = null;
  private workspaces: WorkspaceSummary[] | null = null;
  private tasks: TaskSnapshot | null = null;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(candidate: string): Promise<RepositoryInspector> {
    const root = await realpath(candidate);
    if (!(await exists(path.join(root, ".git")))) {
      throw new Error("Selected directory is not a Git repository or worktree.");
    }
    return new RepositoryInspector(root);
  }

  invalidate(): void {
    this.repository = null;
    this.workspaces = null;
    this.tasks = null;
  }

  async describe(): Promise<RepositorySummary> {
    if (this.repository) return this.repository;

    const manifestPath = path.join(this.root, ".phaseatlas", "repository.yaml");
    const manifestValue = await readYaml(manifestPath);
    const manifest = manifestValue === null ? null : validateRepositoryManifest(manifestValue, manifestPath);
    const checkoutId = localIdentity(this.root);
    const workspaces = await this.listWorkspaces();

    this.repository = {
      id: manifest?.id || `local-${checkoutId}`,
      checkoutId,
      name: manifest?.name || path.basename(this.root),
      path: this.root,
      configuration: manifest?.id ? "configured" : "legacy",
      workspaceCount: workspaces.length,
      openedAt: new Date().toISOString(),
    };

    return this.repository;
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    if (this.workspaces) return this.workspaces;

    const workspacesRoot = path.join(this.root, ".phaseatlas", "workspaces");
    if (!(await exists(workspacesRoot))) {
      this.workspaces = [];
      return this.workspaces;
    }

    const entries = await readdir(workspacesRoot, { withFileTypes: true });
    const workspaces = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry): Promise<WorkspaceSummary | null> => {
          const manifestPath = path.join(workspacesRoot, entry.name, "workspace.yaml");
          const manifestValue = await readYaml(manifestPath);
          if (!manifestValue) return null;
          const manifest = validateWorkspaceManifest(manifestValue, manifestPath, entry.name);

          const tasksRoot = path.join(workspacesRoot, entry.name, "tasks");
          const taskCount = (await exists(tasksRoot))
            ? (await readdir(tasksRoot, { withFileTypes: true })).filter(
                (task) => task.isFile() && /\.ya?ml$/i.test(task.name),
              ).length
            : 0;

          return {
            slug: manifest.slug,
            name: manifest.name,
            description: manifest.description,
            taskCount,
            sourcePath: path.relative(this.root, manifestPath).replaceAll(path.sep, "/"),
          };
        }),
    );

    const normalizedWorkspaces = workspaces
      .filter((workspace): workspace is WorkspaceSummary => Boolean(workspace))
      .sort((left, right) => left.name.localeCompare(right.name));
    this.workspaces = normalizedWorkspaces;
    return normalizedWorkspaces;
  }

  async taskSnapshot(): Promise<TaskSnapshot> {
    if (this.tasks) return this.tasks;
    const repository = await this.describe();
    this.tasks = await loadTaskSnapshot({
      root: this.root,
      repositoryId: repository.id,
      workspaces: await this.listWorkspaces(),
    });
    return this.tasks;
  }

  async publishTaskProposals(workspaceSlug: string, value: unknown): Promise<TaskSnapshot> {
    const workspace = (await this.listWorkspaces()).find((item) => item.slug === workspaceSlug);
    if (!workspace) throw new Error(`Workspace ${workspaceSlug} does not exist.`);
    await publishProposals({ root: this.root, workspace, value });
    this.invalidate();
    return this.taskSnapshot();
  }

  async publishPlanningProposals(target: PlanningTarget, value: unknown): Promise<TaskSnapshot> {
    await publishPlanning({
      root: this.root,
      workspaces: await this.listWorkspaces(),
      target,
      value,
    });
    this.invalidate();
    return this.taskSnapshot();
  }

  async saveTaskContent(taskKey: string, body: string): Promise<TaskSnapshot> {
    const task = (await this.taskSnapshot()).tasks.find(
      (candidate) => `${candidate.key.workspaceSlug}/${candidate.key.taskId}` === taskKey,
    );
    if (!task) throw new Error(`Task ${taskKey} does not exist.`);
    await writeTaskContent({ root: this.root, task, body });
    this.invalidate();
    return this.taskSnapshot();
  }
}

export async function inspectRepository(candidate: string): Promise<{
  repository: RepositorySummary;
  workspaces: WorkspaceSummary[];
  tasks: TaskSnapshot;
}> {
  const inspector = await RepositoryInspector.open(candidate);
  return {
    repository: await inspector.describe(),
    workspaces: await inspector.listWorkspaces(),
    tasks: await inspector.taskSnapshot(),
  };
}
