import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  TASK_STATES,
  type AcceptanceCriterion,
  type CanonicalTask,
  type EvidenceRequirement,
  type TaskDependency,
  type TaskGraphEdge,
  type TaskContent,
  type TaskKind,
  type TaskPriority,
  type TaskScope,
  type TaskSnapshot,
  type ValidationIssue,
  type VerificationStep,
  type WorkspaceSummary,
} from "@phaseatlas/contracts";
import { parse } from "yaml";

const TASK_KINDS = ["code", "docs", "research", "review", "operations"] as const;
const TASK_PRIORITIES = ["critical", "high", "normal", "low"] as const;
const DEPENDENCY_RELATIONS = [
  "blocks_start",
  "blocks_completion",
  "requires_contract",
  "requires_evidence",
  "related",
] as const;
const EVIDENCE_TYPES = ["test", "human_review", "ci", "artifact"] as const;

type JsonRecord = Record<string, unknown>;
type TaskWithoutRevision = Omit<CanonicalTask, "revision">;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function addIssue(
  issues: ValidationIssue[],
  sourcePath: string,
  code: string,
  message: string,
  field?: string,
  severity: ValidationIssue["severity"] = "error",
): void {
  issues.push({ severity, code, message, sourcePath, ...(field ? { field } : {}) });
}

function requiredString(
  source: JsonRecord,
  field: string,
  sourcePath: string,
  issues: ValidationIssue[],
): string | null {
  const value = source[field];
  if (typeof value === "string" && value.trim()) return value.trim();
  addIssue(issues, sourcePath, "TASK_FIELD_REQUIRED", `${field} must be a non-empty string.`, field);
  return null;
}

function stringArray(
  value: unknown,
  field: string,
  sourcePath: string,
  issues: ValidationIssue[],
): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    addIssue(issues, sourcePath, "TASK_FIELD_INVALID", `${field} must be an array of non-empty strings.`, field);
    return null;
  }
  return value.map((item) => (item as string).trim());
}

function safeRepositoryPath(value: string): boolean {
  return !path.isAbsolute(value) && value !== ".." && !value.startsWith("../") && !value.includes("/../");
}

function parseDependencies(
  value: unknown,
  sourcePath: string,
  issues: ValidationIssue[],
): TaskDependency[] | null {
  if (!Array.isArray(value)) {
    addIssue(issues, sourcePath, "TASK_FIELD_INVALID", "dependencies must be an array.", "dependencies");
    return null;
  }

  const dependencies: TaskDependency[] = [];
  value.forEach((item, index) => {
    const field = `dependencies[${index}]`;
    if (!isRecord(item)) {
      addIssue(issues, sourcePath, "TASK_DEPENDENCY_INVALID", `${field} must be an object.`, field);
      return;
    }
    const taskKey = requiredString(item, "taskKey", sourcePath, issues);
    if (!isOneOf(item.relation, DEPENDENCY_RELATIONS)) {
      addIssue(
        issues,
        sourcePath,
        "TASK_DEPENDENCY_INVALID",
        `${field}.relation is not supported.`,
        `${field}.relation`,
      );
      return;
    }
    if (item.requiredState !== undefined && !isOneOf(item.requiredState, TASK_STATES)) {
      addIssue(
        issues,
        sourcePath,
        "TASK_DEPENDENCY_INVALID",
        `${field}.requiredState is not a valid task state.`,
        `${field}.requiredState`,
      );
      return;
    }
    if (taskKey) {
      dependencies.push({
        taskKey,
        relation: item.relation,
        ...(item.requiredState ? { requiredState: item.requiredState } : {}),
      });
    }
  });
  return dependencies;
}

function parseScope(
  value: unknown,
  sourcePath: string,
  issues: ValidationIssue[],
): TaskScope | null {
  if (!isRecord(value)) {
    addIssue(issues, sourcePath, "TASK_SCOPE_INVALID", "scope must be an object.", "scope");
    return null;
  }

  const allowedPaths = stringArray(value.allowedPaths, "scope.allowedPaths", sourcePath, issues);
  const forbiddenPaths = stringArray(value.forbiddenPaths, "scope.forbiddenPaths", sourcePath, issues);
  const booleanFields = [
    "writable",
    "allowDependencyChanges",
    "allowDatabaseMigrations",
    "allowExternalNetwork",
  ] as const;
  for (const field of booleanFields) {
    if (typeof value[field] !== "boolean") {
      addIssue(issues, sourcePath, "TASK_SCOPE_INVALID", `scope.${field} must be a boolean.`, `scope.${field}`);
    }
  }

  for (const [field, paths] of [["allowedPaths", allowedPaths], ["forbiddenPaths", forbiddenPaths]] as const) {
    for (const candidate of paths ?? []) {
      if (!safeRepositoryPath(candidate)) {
        addIssue(
          issues,
          sourcePath,
          "TASK_SCOPE_UNSAFE_PATH",
          `scope.${field} contains a path outside the repository boundary: ${candidate}`,
          `scope.${field}`,
        );
      }
    }
  }

  if (
    !allowedPaths || !forbiddenPaths ||
    booleanFields.some((field) => typeof value[field] !== "boolean")
  ) return null;

  return {
    allowedPaths,
    forbiddenPaths,
    writable: value.writable as boolean,
    allowDependencyChanges: value.allowDependencyChanges as boolean,
    allowDatabaseMigrations: value.allowDatabaseMigrations as boolean,
    allowExternalNetwork: value.allowExternalNetwork as boolean,
  };
}

async function loadTaskContent(
  value: unknown,
  taskFilePath: string,
  repositoryRoot: string,
  sourcePath: string,
  issues: ValidationIssue[],
): Promise<TaskContent | undefined> {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    addIssue(issues, sourcePath, "TASK_CONTENT_INVALID", "content must be an object.", "content");
    return undefined;
  }
  const contentPath = requiredString(value, "path", sourcePath, issues);
  if (!contentPath || !safeRepositoryPath(contentPath)) {
    addIssue(
      issues,
      sourcePath,
      "TASK_CONTENT_INVALID",
      "content.path must be a repository-relative path inside the task directory.",
      "content.path",
    );
    return undefined;
  }
  const taskDirectory = path.dirname(taskFilePath);
  const absoluteContentPath = path.resolve(taskDirectory, contentPath);
  const relativeToTaskDirectory = path.relative(taskDirectory, absoluteContentPath);
  if (relativeToTaskDirectory.startsWith("..") || path.isAbsolute(relativeToTaskDirectory)) {
    addIssue(
      issues,
      sourcePath,
      "TASK_CONTENT_INVALID",
      "content.path must stay inside the task directory.",
      "content.path",
    );
    return undefined;
  }
  try {
    const body = await readFile(absoluteContentPath, "utf8");
    if (!body.trim()) {
      addIssue(issues, sourcePath, "TASK_CONTENT_INVALID", "The task content file is empty.", "content.path");
      return undefined;
    }
    return {
      path: path.relative(repositoryRoot, absoluteContentPath).replaceAll(path.sep, "/"),
      body,
    };
  } catch (error) {
    addIssue(
      issues,
      sourcePath,
      "TASK_CONTENT_MISSING",
      `The task content file could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
      "content.path",
    );
    return undefined;
  }
}

function parseAcceptanceCriteria(
  value: unknown,
  sourcePath: string,
  issues: ValidationIssue[],
): AcceptanceCriterion[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    addIssue(
      issues,
      sourcePath,
      "TASK_ACCEPTANCE_INVALID",
      "acceptanceCriteria must contain at least one criterion.",
      "acceptanceCriteria",
    );
    return null;
  }

  const criteria: AcceptanceCriterion[] = [];
  value.forEach((item, index) => {
    const field = `acceptanceCriteria[${index}]`;
    if (!isRecord(item) || !isRecord(item.verification)) {
      addIssue(issues, sourcePath, "TASK_ACCEPTANCE_INVALID", `${field} is invalid.`, field);
      return;
    }
    const id = requiredString(item, "id", sourcePath, issues);
    const statement = requiredString(item, "statement", sourcePath, issues);
    const verification = item.verification;
    const type = verification.type;
    let normalizedVerification: AcceptanceCriterion["verification"] | null = null;
    if (type === "command") {
      const commandId = requiredString(verification, "commandId", sourcePath, issues);
      if (commandId) normalizedVerification = { type, commandId };
    } else if (type === "file") {
      const filePath = requiredString(verification, "path", sourcePath, issues);
      const condition = requiredString(verification, "condition", sourcePath, issues);
      if (filePath && condition) normalizedVerification = { type, path: filePath, condition };
    } else if (type === "human") {
      const reviewerRole = requiredString(verification, "reviewerRole", sourcePath, issues);
      if (reviewerRole) normalizedVerification = { type, reviewerRole };
    } else {
      addIssue(
        issues,
        sourcePath,
        "TASK_ACCEPTANCE_INVALID",
        `${field}.verification.type is not supported.`,
        `${field}.verification.type`,
      );
    }
    if (id && statement && normalizedVerification) criteria.push({ id, statement, verification: normalizedVerification });
  });
  return criteria;
}

function parseVerification(
  value: unknown,
  sourcePath: string,
  issues: ValidationIssue[],
): VerificationStep[] | null {
  if (!Array.isArray(value)) {
    addIssue(issues, sourcePath, "TASK_VERIFICATION_INVALID", "verification must be an array.", "verification");
    return null;
  }
  const steps: VerificationStep[] = [];
  value.forEach((item, index) => {
    const field = `verification[${index}]`;
    if (!isRecord(item)) {
      addIssue(issues, sourcePath, "TASK_VERIFICATION_INVALID", `${field} must be an object.`, field);
      return;
    }
    const id = requiredString(item, "id", sourcePath, issues);
    const command = requiredString(item, "command", sourcePath, issues);
    const cwd = item.cwd;
    if (cwd !== undefined && (typeof cwd !== "string" || !safeRepositoryPath(cwd))) {
      addIssue(issues, sourcePath, "TASK_VERIFICATION_INVALID", `${field}.cwd must stay inside the repository.`, `${field}.cwd`);
    }
    if (typeof item.timeoutSeconds !== "number" || !Number.isInteger(item.timeoutSeconds) || item.timeoutSeconds <= 0) {
      addIssue(issues, sourcePath, "TASK_VERIFICATION_INVALID", `${field}.timeoutSeconds must be a positive integer.`, `${field}.timeoutSeconds`);
    }
    if (typeof item.required !== "boolean") {
      addIssue(issues, sourcePath, "TASK_VERIFICATION_INVALID", `${field}.required must be a boolean.`, `${field}.required`);
    }
    if (
      id && command &&
      (cwd === undefined || (typeof cwd === "string" && safeRepositoryPath(cwd))) &&
      typeof item.timeoutSeconds === "number" && Number.isInteger(item.timeoutSeconds) && item.timeoutSeconds > 0 &&
      typeof item.required === "boolean"
    ) {
      steps.push({
        id,
        command,
        ...(typeof cwd === "string" ? { cwd } : {}),
        timeoutSeconds: item.timeoutSeconds,
        required: item.required,
      });
    }
  });
  return steps;
}

function parseEvidenceRequirements(
  value: unknown,
  sourcePath: string,
  issues: ValidationIssue[],
): EvidenceRequirement[] | null {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      sourcePath,
      "TASK_EVIDENCE_INVALID",
      "evidenceRequirements must be an array.",
      "evidenceRequirements",
    );
    return null;
  }
  const requirements: EvidenceRequirement[] = [];
  value.forEach((item, index) => {
    const field = `evidenceRequirements[${index}]`;
    if (!isRecord(item) || !isOneOf(item.type, EVIDENCE_TYPES)) {
      addIssue(issues, sourcePath, "TASK_EVIDENCE_INVALID", `${field}.type is not supported.`, `${field}.type`);
      return;
    }
    if (item.description !== undefined && typeof item.description !== "string") {
      addIssue(issues, sourcePath, "TASK_EVIDENCE_INVALID", `${field}.description must be a string.`, `${field}.description`);
      return;
    }
    requirements.push({
      type: item.type,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
    });
  });
  return requirements;
}

function parseTask(
  value: unknown,
  repositoryId: string,
  workspaceSlug: string,
  sourcePath: string,
  extractedAt: string,
  issues: ValidationIssue[],
  content?: TaskContent,
): TaskWithoutRevision | null {
  const firstIssueIndex = issues.length;
  if (!isRecord(value)) {
    addIssue(issues, sourcePath, "TASK_DOCUMENT_INVALID", "The YAML document must be an object.");
    return null;
  }
  if (value.schemaVersion !== "phaseatlas.task/v1") {
    addIssue(
      issues,
      sourcePath,
      "TASK_SCHEMA_UNSUPPORTED",
      "schemaVersion must be phaseatlas.task/v1.",
      "schemaVersion",
    );
  }

  const taskId = requiredString(value, "id", sourcePath, issues);
  if (taskId && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) {
    addIssue(issues, sourcePath, "TASK_ID_INVALID", "id contains unsupported characters.", "id");
  }
  const title = requiredString(value, "title", sourcePath, issues);
  const objective = requiredString(value, "objective", sourcePath, issues);
  const phaseId = requiredString(value, "phase", sourcePath, issues);
  const owners = stringArray(value.owners, "owners", sourcePath, issues);
  if (!isOneOf(value.kind, TASK_KINDS)) {
    addIssue(issues, sourcePath, "TASK_FIELD_INVALID", "kind is not supported.", "kind");
  }
  if (!isOneOf(value.state, TASK_STATES)) {
    addIssue(issues, sourcePath, "TASK_FIELD_INVALID", "state is not supported.", "state");
  }
  if (!isOneOf(value.priority, TASK_PRIORITIES)) {
    addIssue(issues, sourcePath, "TASK_FIELD_INVALID", "priority is not supported.", "priority");
  }

  const dependencies = parseDependencies(value.dependencies, sourcePath, issues);
  const scope = parseScope(value.scope, sourcePath, issues);
  const acceptanceCriteria = parseAcceptanceCriteria(value.acceptanceCriteria, sourcePath, issues);
  const verification = parseVerification(value.verification, sourcePath, issues);
  const evidenceRequirements = parseEvidenceRequirements(value.evidenceRequirements, sourcePath, issues);

  if (acceptanceCriteria && verification) {
    const commandIds = new Set(verification.map((step) => step.id));
    for (const criterion of acceptanceCriteria) {
      if (criterion.verification.type === "command" && !commandIds.has(criterion.verification.commandId)) {
        addIssue(
          issues,
          sourcePath,
          "TASK_COMMAND_REFERENCE_MISSING",
          `Acceptance criterion ${criterion.id} references unknown command ${criterion.verification.commandId}.`,
          "acceptanceCriteria",
        );
      }
    }
  }

  if (issues.slice(firstIssueIndex).some((issue) => issue.severity === "error")) return null;

  return {
    schemaVersion: "phaseatlas.task/v1",
    key: { repositoryId, workspaceSlug, taskId: taskId as string },
    title: title as string,
    objective: objective as string,
    ...(content ? { content } : {}),
    phaseId: phaseId as string,
    kind: value.kind as TaskKind,
    state: value.state as CanonicalTask["state"],
    priority: value.priority as TaskPriority,
    owners: owners as string[],
    dependencies: dependencies as TaskDependency[],
    scope: scope as TaskScope,
    acceptanceCriteria: acceptanceCriteria as AcceptanceCriterion[],
    verification: verification as VerificationStep[],
    evidenceRequirements: evidenceRequirements as EvidenceRequirement[],
    source: {
      documents: [
        { path: sourcePath },
        ...(content ? [{ path: content.path }] : []),
      ],
      extractedAt,
      warnings: [],
    },
  };
}

function canonicalTaskKey(task: Pick<CanonicalTask, "key">): string {
  return `${task.key.workspaceSlug}/${task.key.taskId}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(
      ([key, nested]) => [key, stableValue(nested)],
    ),
  );
}

function taskRevision(task: TaskWithoutRevision): string {
  const payload = {
    schemaVersion: task.schemaVersion,
    key: task.key,
    title: task.title,
    objective: task.objective,
    content: task.content,
    phaseId: task.phaseId,
    kind: task.kind,
    state: task.state,
    priority: task.priority,
    owners: task.owners,
    dependencies: task.dependencies,
    scope: task.scope,
    acceptanceCriteria: task.acceptanceCriteria,
    verification: task.verification,
    evidenceRequirements: task.evidenceRequirements,
    documents: task.source.documents,
  };
  return createHash("sha256").update(JSON.stringify(stableValue(payload))).digest("hex");
}

function detectCycles(tasks: CanonicalTask[], edges: TaskGraphEdge[], issues: ValidationIssue[]): boolean {
  const adjacency = new Map<string, string[]>();
  for (const task of tasks) adjacency.set(canonicalTaskKey(task), []);
  for (const edge of edges) adjacency.get(edge.fromTaskKey)?.push(edge.toTaskKey);

  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const reported = new Set<string>();
  const taskByKey = new Map(tasks.map((task) => [canonicalTaskKey(task), task]));
  let hasCycles = false;

  const visit = (taskKey: string): void => {
    state.set(taskKey, "visiting");
    stack.push(taskKey);
    for (const dependencyKey of adjacency.get(taskKey) ?? []) {
      if (!state.has(dependencyKey)) {
        visit(dependencyKey);
      } else if (state.get(dependencyKey) === "visiting") {
        hasCycles = true;
        const start = stack.indexOf(dependencyKey);
        const cycle = [...stack.slice(Math.max(start, 0)), dependencyKey];
        const signature = cycle.join(" -> ");
        if (!reported.has(signature)) {
          reported.add(signature);
          const task = taskByKey.get(taskKey);
          addIssue(
            issues,
            task?.source.documents[0]?.path ?? ".phaseatlas",
            "TASK_DEPENDENCY_CYCLE",
            `Dependency cycle detected: ${signature}.`,
            "dependencies",
          );
        }
      }
    }
    stack.pop();
    state.set(taskKey, "visited");
  };

  for (const taskKey of adjacency.keys()) if (!state.has(taskKey)) visit(taskKey);
  return hasCycles;
}

export async function loadTaskSnapshot(options: {
  root: string;
  repositoryId: string;
  workspaces: WorkspaceSummary[];
}): Promise<TaskSnapshot> {
  const generatedAt = new Date().toISOString();
  const issues: ValidationIssue[] = [];
  const parsedTasks: TaskWithoutRevision[] = [];

  for (const workspace of options.workspaces) {
    const workspaceDirectory = path.dirname(path.join(options.root, workspace.sourcePath));
    const tasksDirectory = path.join(workspaceDirectory, "tasks");
    let entries;
    try {
      entries = await readdir(tasksDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.filter((candidate) => candidate.isFile() && /\.ya?ml$/i.test(candidate.name))) {
      const absolutePath = path.join(tasksDirectory, entry.name);
      const sourcePath = path.relative(options.root, absolutePath).replaceAll(path.sep, "/");
      try {
        const value = parse(await readFile(absolutePath, "utf8")) as unknown;
        const issueCount = issues.length;
        const content = isRecord(value)
          ? await loadTaskContent(value.content, absolutePath, options.root, sourcePath, issues)
          : undefined;
        const task = issues.length === issueCount
          ? parseTask(value, options.repositoryId, workspace.slug, sourcePath, generatedAt, issues, content)
          : null;
        if (task) parsedTasks.push(task);
      } catch (error) {
        addIssue(
          issues,
          sourcePath,
          "TASK_YAML_INVALID",
          `YAML could not be parsed: ${error instanceof Error ? error.message : "unknown parser error"}`,
        );
      }
    }
  }

  const taskIdCounts = new Map<string, number>();
  for (const task of parsedTasks) {
    taskIdCounts.set(task.key.taskId, (taskIdCounts.get(task.key.taskId) ?? 0) + 1);
  }
  const uniqueTasks = parsedTasks.filter((task) => {
    if ((taskIdCounts.get(task.key.taskId) ?? 0) === 1) return true;
    addIssue(
      issues,
      task.source.documents[0]?.path ?? ".phaseatlas",
      "TASK_ID_DUPLICATE",
      `Task id ${task.key.taskId} is declared more than once in this repository.`,
      "id",
    );
    return false;
  });

  const byFullKey = new Map(uniqueTasks.map((task) => [canonicalTaskKey(task), task]));
  const byTaskId = new Map(uniqueTasks.map((task) => [task.key.taskId, task]));
  const edges: TaskGraphEdge[] = [];

  const resolvedTasks = uniqueTasks.map((task): TaskWithoutRevision => {
    const dependencies = task.dependencies.map((dependency) => {
      const target = dependency.taskKey.includes("/")
        ? byFullKey.get(dependency.taskKey)
        : byTaskId.get(dependency.taskKey);
      if (!target) {
        addIssue(
          issues,
          task.source.documents[0]?.path ?? ".phaseatlas",
          "TASK_DEPENDENCY_MISSING",
          `Dependency ${dependency.taskKey} does not resolve to a canonical task.`,
          "dependencies",
        );
        return dependency;
      }
      const toTaskKey = canonicalTaskKey(target);
      edges.push({ fromTaskKey: canonicalTaskKey(task), toTaskKey, relation: dependency.relation });
      return { ...dependency, taskKey: toTaskKey };
    });
    return { ...task, dependencies };
  });

  const tasks = resolvedTasks.map((task): CanonicalTask => ({ ...task, revision: taskRevision(task) }))
    .sort((left, right) => canonicalTaskKey(left).localeCompare(canonicalTaskKey(right)));
  const hasCycles = detectCycles(tasks, edges, issues);

  return {
    repositoryId: options.repositoryId,
    generatedAt,
    tasks,
    issues: issues.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath) || left.code.localeCompare(right.code)),
    graph: { edges, hasCycles },
  };
}
