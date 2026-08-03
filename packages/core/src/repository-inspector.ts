import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  LegacyIngestionSnapshot,
  LegacySourceLocation,
  LegacyTaskCandidate,
  PlanningTarget,
  RepositorySummary,
  TaskSnapshot,
  ValidationIssue,
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

const LEGACY_SOURCE_FORMAT = "markdown-checklist/v1" as const;
const LEGACY_SOURCE_PATHS = ["TODO.md", "docs/TODO.md", "ROADMAP.md", "docs/ROADMAP.md"] as const;
const LEGACY_SOURCE_MAX_BYTES = 1024 * 1024;
const LEGACY_ID_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
const LEGACY_PHASE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface ParsedLegacyEntry {
  candidateId: string;
  nativeId: string;
  title: string;
  objective: string;
  phaseId: string;
  completionHint: "open" | "completed";
  location: LegacySourceLocation;
  documentRank: number;
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

function legacyCandidateIdentity(nativeId: string): string {
  return `legacy_${createHash("sha256")
    .update(`phaseatlas.legacy-candidate/v1\0${LEGACY_SOURCE_FORMAT}\0${nativeId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function normalizeLegacyText(value: string): string {
  return value.normalize("NFC").trim().replace(/[\t ]+/g, " ");
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function legacyIssue(
  sourcePath: string,
  code: string,
  message: string,
  options: {
    severity?: ValidationIssue["severity"];
    field?: string;
    line?: number;
    column?: number;
  } = {},
): ValidationIssue {
  return {
    severity: options.severity ?? "error",
    code,
    message,
    sourcePath,
    ...(options.field ? { field: options.field } : {}),
    ...(options.line !== undefined ? { line: options.line } : {}),
    ...(options.column !== undefined ? { column: options.column } : {}),
  };
}

function parseLegacyMarkdown(
  sourcePath: string,
  documentRank: number,
  source: string,
): { entries: ParsedLegacyEntry[]; issues: ValidationIssue[] } {
  const entries: ParsedLegacyEntry[] = [];
  const issues: ValidationIssue[] = [];
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  let phaseId: string | null = null;
  let fence: { marker: "`" | "~"; length: number; line: number } | null = null;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const markerText = fenceMatch[1]!;
      const marker = markerText[0] as "`" | "~";
      if (!fence) {
        fence = { marker, length: markerText.length, line: lineNumber };
      } else if (marker === fence.marker && markerText.length >= fence.length) {
        fence = null;
      }
      return;
    }
    if (fence) return;

    const heading = /^##\s+(.+?)\s+\{#([^}]+)\}\s*$/.exec(line);
    if (heading) {
      const candidatePhase = heading[2]!;
      if (!LEGACY_PHASE_PATTERN.test(candidatePhase)) {
        phaseId = null;
        issues.push(legacyIssue(sourcePath, "LEGACY_PHASE_INVALID", "Phase identifiers must use lowercase letters, numbers, and hyphens and contain at most 64 characters.", {
          field: "phaseId",
          line: lineNumber,
          column: 1,
        }));
      } else {
        phaseId = candidatePhase;
      }
      return;
    }

    const taskLike = /^- \[[ xX]\]/.test(line);
    if (!taskLike) return;
    const task = /^- \[([ xX])\] \[([^\]]+)\] (.+?) :: (.+)$/.exec(line);
    if (!task) {
      issues.push(legacyIssue(sourcePath, "LEGACY_TASK_SYNTAX_INVALID", "Task entries must use '- [ ] [ID] Title :: Objective.' syntax.", {
        line: lineNumber,
        column: 1,
      }));
      return;
    }
    if (!phaseId) {
      issues.push(legacyIssue(sourcePath, "LEGACY_TASK_OUTSIDE_PHASE", "Task entries must appear below a valid phase heading.", {
        line: lineNumber,
        column: 1,
      }));
      return;
    }

    const nativeId = task[2]!;
    if (!LEGACY_ID_PATTERN.test(nativeId)) {
      issues.push(legacyIssue(sourcePath, "LEGACY_TASK_ID_INVALID", "Task identifiers must use 1-64 uppercase letters, numbers, dots, underscores, or hyphens.", {
        field: "nativeId",
        line: lineNumber,
        column: 1,
      }));
      return;
    }
    const title = normalizeLegacyText(task[3]!);
    const objective = normalizeLegacyText(task[4]!);
    if (Array.from(title).length < 1 || Array.from(title).length > 160 || Array.from(objective).length < 1 || Array.from(objective).length > 2000) {
      issues.push(legacyIssue(sourcePath, "LEGACY_TASK_FIELD_INVALID", "Task titles must contain 1-160 characters and objectives 1-2000 characters.", {
        field: "title|objective",
        line: lineNumber,
        column: 1,
      }));
      return;
    }

    entries.push({
      candidateId: legacyCandidateIdentity(nativeId),
      nativeId,
      title,
      objective,
      phaseId,
      completionHint: task[1] === " " ? "open" : "completed",
      location: { path: sourcePath, nativeId, line: lineNumber, column: 1 },
      documentRank,
    });
  });

  const unterminatedFenceLine = (fence as { line: number } | null)?.line;
  if (unterminatedFenceLine !== undefined) {
    issues.push(legacyIssue(sourcePath, "LEGACY_MARKDOWN_UNTERMINATED_FENCE", "The Markdown source contains an unterminated fenced code block.", {
      line: unterminatedFenceLine,
      column: 1,
    }));
    return { entries: [], issues };
  }
  return { entries, issues };
}

function sameLegacySemantics(left: ParsedLegacyEntry, right: ParsedLegacyEntry): boolean {
  return left.phaseId === right.phaseId && left.title === right.title &&
    left.objective === right.objective && left.completionHint === right.completionHint;
}

function normalizeLegacyEntries(
  entries: ParsedLegacyEntry[],
  issues: ValidationIssue[],
): LegacyTaskCandidate[] {
  const byNativeId = new Map<string, ParsedLegacyEntry[]>();
  for (const entry of entries) {
    const matches = byNativeId.get(entry.nativeId) ?? [];
    matches.push(entry);
    byNativeId.set(entry.nativeId, matches);
  }

  const candidates: LegacyTaskCandidate[] = [];
  for (const matches of byNativeId.values()) {
    matches.sort((left, right) => left.documentRank - right.documentRank || left.location.line - right.location.line);
    const primary = matches[0]!;
    if (!matches.every((entry) => sameLegacySemantics(primary, entry))) {
      issues.push(legacyIssue(primary.location.path, "LEGACY_DUPLICATE_CONFLICT", `Task ${primary.nativeId} has conflicting legacy definitions and was excluded.`, {
        field: "nativeId",
        line: primary.location.line,
        column: 1,
      }));
      continue;
    }

    const duplicateWarning = matches.length > 1
      ? legacyIssue(primary.location.path, "LEGACY_DUPLICATE_IDENTICAL", `Task ${primary.nativeId} has identical legacy definitions; the highest-precedence location is primary.`, {
          severity: "warning",
          field: "nativeId",
          line: primary.location.line,
          column: 1,
        })
      : null;
    if (duplicateWarning) issues.push(duplicateWarning);
    candidates.push({
      candidateId: primary.candidateId,
      sourceFormat: LEGACY_SOURCE_FORMAT,
      nativeId: primary.nativeId,
      title: primary.title,
      objective: primary.objective,
      phaseId: primary.phaseId,
      completionHint: primary.completionHint,
      provenance: {
        primary: primary.location,
        identicalDuplicates: matches.slice(1).map((entry) => entry.location),
      },
      warnings: duplicateWarning ? [duplicateWarning] : [],
    });
  }

  const byCandidateId = new Map<string, LegacyTaskCandidate[]>();
  for (const candidate of candidates) {
    const matches = byCandidateId.get(candidate.candidateId) ?? [];
    matches.push(candidate);
    byCandidateId.set(candidate.candidateId, matches);
  }
  const collidedIds = new Set<string>();
  for (const [candidateId, matches] of byCandidateId) {
    if (matches.length < 2) continue;
    collidedIds.add(candidateId);
    const primary = matches[0]!;
    issues.push(legacyIssue(primary.provenance.primary.path, "LEGACY_IDENTITY_COLLISION", `Candidate identity ${candidateId} maps to multiple native identifiers and was excluded.`, {
      field: "candidateId",
      line: primary.provenance.primary.line,
      column: 1,
    }));
  }

  return candidates
    .filter((candidate) => !collidedIds.has(candidate.candidateId))
    .sort((left, right) => compareAscii(left.nativeId, right.nativeId) || compareAscii(left.candidateId, right.candidateId));
}

function sortLegacyIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const rank = new Map<string, number>(LEGACY_SOURCE_PATHS.map((sourcePath, index) => [sourcePath, index]));
  return issues.sort((left, right) =>
    (rank.get(left.sourcePath) ?? LEGACY_SOURCE_PATHS.length) - (rank.get(right.sourcePath) ?? LEGACY_SOURCE_PATHS.length) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    compareAscii(left.code, right.code) ||
    compareAscii(left.message, right.message)
  );
}

export class RepositoryInspector {
  readonly root: string;
  private repository: RepositorySummary | null = null;
  private workspaces: WorkspaceSummary[] | null = null;
  private tasks: TaskSnapshot | null = null;
  private legacy: LegacyIngestionSnapshot | null = null;

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
    this.legacy = null;
  }

  async describe(): Promise<RepositorySummary> {
    if (this.repository) return this.repository;

    const manifestPath = path.join(this.root, ".phaseatlas", "repository.yaml");
    const manifestValue = await readYaml(manifestPath);
    const manifest = manifestValue === null ? null : validateRepositoryManifest(manifestValue, manifestPath);
    const checkoutId = localIdentity(this.root);
    if (!manifest) this.workspaces = [];
    const workspaces = manifest ? await this.listWorkspaces() : [];

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

  async legacySnapshot(): Promise<LegacyIngestionSnapshot> {
    if (this.legacy) return this.legacy;
    const repository = await this.describe();
    if (repository.configuration === "configured") {
      this.legacy = { candidates: [], issues: [] };
      return this.legacy;
    }

    const entries: ParsedLegacyEntry[] = [];
    const issues: ValidationIssue[] = [];
    for (const [documentRank, sourcePath] of LEGACY_SOURCE_PATHS.entries()) {
      const absolutePath = path.join(this.root, ...sourcePath.split("/"));
      let metadata;
      try {
        metadata = await lstat(absolutePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        issues.push(legacyIssue(sourcePath, code === "ENOENT" ? "LEGACY_SOURCE_MISSING" : "LEGACY_SOURCE_UNREADABLE", code === "ENOENT"
          ? `Approved legacy source ${sourcePath} is missing.`
          : `Approved legacy source ${sourcePath} could not be inspected: ${(error as Error).message}`, {
          severity: code === "ENOENT" ? "warning" : "error",
        }));
        continue;
      }
      if (metadata.isSymbolicLink()) {
        issues.push(legacyIssue(sourcePath, "LEGACY_SOURCE_SYMLINK", "Legacy sources must not be symbolic links."));
        continue;
      }
      if (!metadata.isFile()) {
        issues.push(legacyIssue(sourcePath, "LEGACY_SOURCE_NOT_REGULAR", "Legacy sources must be regular files."));
        continue;
      }
      if (metadata.size > LEGACY_SOURCE_MAX_BYTES) {
        issues.push(legacyIssue(sourcePath, "LEGACY_SOURCE_TOO_LARGE", "Legacy sources must not exceed one MiB."));
        continue;
      }

      let bytes: Buffer;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const openedMetadata = await handle.stat();
        if (!openedMetadata.isFile()) {
          issues.push(legacyIssue(sourcePath, "LEGACY_SOURCE_NOT_REGULAR", "Legacy sources must be regular files."));
          continue;
        }
        if (openedMetadata.size > LEGACY_SOURCE_MAX_BYTES) {
          issues.push(legacyIssue(sourcePath, "LEGACY_SOURCE_TOO_LARGE", "Legacy sources must not exceed one MiB."));
          continue;
        }
        bytes = await handle.readFile();
      } catch (error) {
        issues.push(legacyIssue(sourcePath, "LEGACY_SOURCE_UNREADABLE", `Approved legacy source ${sourcePath} could not be read: ${(error as Error).message}`));
        continue;
      } finally {
        await handle?.close().catch(() => undefined);
      }
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        issues.push(legacyIssue(sourcePath, "LEGACY_SOURCE_INVALID_UTF8", "Legacy sources must contain valid UTF-8 text."));
        continue;
      }
      const parsed = parseLegacyMarkdown(sourcePath, documentRank, source);
      entries.push(...parsed.entries);
      issues.push(...parsed.issues);
    }

    this.legacy = {
      candidates: normalizeLegacyEntries(entries, issues),
      issues: sortLegacyIssues(issues),
    };
    return this.legacy;
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
  legacy: LegacyIngestionSnapshot;
}> {
  const inspector = await RepositoryInspector.open(candidate);
  return {
    repository: await inspector.describe(),
    workspaces: await inspector.listWorkspaces(),
    tasks: await inspector.taskSnapshot(),
    legacy: await inspector.legacySnapshot(),
  };
}
