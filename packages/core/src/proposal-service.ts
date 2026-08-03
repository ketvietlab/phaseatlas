import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type PlanningProposalSet,
  type PlanningTarget,
  type TaskContentDraft,
  type TaskKind,
  type TaskPriority,
  type TaskProposal,
  type TaskProposalCriterion,
  type TaskProposalOutline,
  type ValidationIssue,
  type WorkspaceProposal,
  type WorkspaceSummary,
} from "@phaseatlas/contracts";
import { stringify } from "yaml";

const TASK_KINDS = ["code", "docs", "research", "review", "operations"] as const;
const TASK_PRIORITIES = ["critical", "high", "normal", "low"] as const;
const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function safeRepositoryPath(value: string): boolean {
  return !path.isAbsolute(value) && value !== ".." && !value.startsWith("../") && !value.includes("/../");
}

function issue(
  issues: ValidationIssue[],
  code: string,
  message: string,
  field?: string,
): void {
  issues.push({
    severity: "error",
    code,
    message,
    sourcePath: "runner-output",
    ...(field ? { field } : {}),
  });
}

function requiredString(
  value: unknown,
  field: string,
  issues: ValidationIssue[],
): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  issue(issues, "PROPOSAL_FIELD_REQUIRED", `${field} must be a non-empty string.`, field);
  return null;
}

function stringArray(
  value: unknown,
  field: string,
  issues: ValidationIssue[],
): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    issue(issues, "PROPOSAL_FIELD_INVALID", `${field} must be an array of non-empty strings.`, field);
    return null;
  }
  return value.map((item) => (item as string).trim());
}

function parseTaskContentDraft(
  value: unknown,
  field: string,
  issues: ValidationIssue[],
): TaskContentDraft | null {
  if (!isRecord(value)) {
    issue(issues, "TASK_CONTENT_INVALID", `${field} must be a task content object.`, field);
    return null;
  }
  const body = requiredString(value.body, `${field}.body`, issues);
  if (body && body.length < 300) {
    issue(
      issues,
      "TASK_CONTENT_TOO_SHORT",
      `${field}.body must contain at least 300 characters of task-specific Markdown.`,
      `${field}.body`,
    );
  }
  const requiredHeadings = ["Context", "Requirements", "Implementation notes", "Constraints", "Verification plan"];
  if (body) {
    for (const heading of requiredHeadings) {
      if (!new RegExp(`^#{1,2}\\s+${heading}\\s*$`, "im").test(body)) {
        issue(
          issues,
          "TASK_CONTENT_SECTION_MISSING",
          `${field}.body must include a ${heading} heading.`,
          `${field}.body`,
        );
      }
    }
  }
  return body && body.length >= 300 && !issues.length ? { body } : null;
}

export function validateTaskContent(value: unknown): {
  content: TaskContentDraft | null;
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  const content = parseTaskContentDraft(value, "content", issues);
  return { content: issues.length ? null : content, issues };
}

function parseCriteria(
  value: unknown,
  taskIndex: number,
  issues: ValidationIssue[],
): TaskProposalCriterion[] | null {
  const field = `tasks[${taskIndex}].acceptanceCriteria`;
  if (!Array.isArray(value) || value.length === 0) {
    issue(issues, "PROPOSAL_ACCEPTANCE_INVALID", `${field} must contain at least one criterion.`, field);
    return null;
  }
  const criteria: TaskProposalCriterion[] = [];
  value.forEach((item, criterionIndex) => {
    const criterionField = `${field}[${criterionIndex}]`;
    if (!isRecord(item)) {
      issue(issues, "PROPOSAL_ACCEPTANCE_INVALID", `${criterionField} must be an object.`, criterionField);
      return;
    }
    const statement = requiredString(item.statement, `${criterionField}.statement`, issues);
    if (typeof item.verificationSuggestion !== "string") {
      issue(
        issues,
        "PROPOSAL_ACCEPTANCE_INVALID",
        `${criterionField}.verificationSuggestion must be a string.`,
        `${criterionField}.verificationSuggestion`,
      );
      return;
    }
    if (statement) {
      criteria.push({
        statement,
        verificationSuggestion: item.verificationSuggestion.trim(),
      });
    }
  });
  return criteria;
}

function validateProposalSet(value: unknown, options: {
  target?: PlanningTarget;
  existingWorkspaceSlugs?: string[];
}): {
  proposals: PlanningProposalSet | null;
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value) || !Array.isArray(value.workspaces) || !Array.isArray(value.tasks) || value.tasks.length === 0) {
    issue(
      issues,
      "PROPOSAL_DOCUMENT_INVALID",
      "Runner output must contain a workspaces array and a non-empty tasks array.",
    );
    return { proposals: null, issues };
  }

  const workspaces: WorkspaceProposal[] = [];
  if (value.workspaces.length > 1) {
    issue(issues, "PROPOSAL_WORKSPACE_COUNT", "A planning run may propose at most one workspace.", "workspaces");
  }

  const temporaryIds = new Set<string>();
  value.workspaces.forEach((item, index) => {
    const firstIssue = issues.length;
    const base = `workspaces[${index}]`;
    if (!isRecord(item)) {
      issue(issues, "PROPOSAL_WORKSPACE_INVALID", `${base} must be an object.`, base);
      return;
    }
    const temporaryId = requiredString(item.temporaryId, `${base}.temporaryId`, issues);
    const slug = requiredString(item.slug, `${base}.slug`, issues);
    const name = requiredString(item.name, `${base}.name`, issues);
    const description = requiredString(item.description, `${base}.description`, issues);
    const rationale = requiredString(item.rationale, `${base}.rationale`, issues);
    if (temporaryId && temporaryIds.has(temporaryId)) {
      issue(issues, "PROPOSAL_ID_DUPLICATE", `temporaryId ${temporaryId} is duplicated.`, `${base}.temporaryId`);
    } else if (temporaryId) temporaryIds.add(temporaryId);
    if (slug && !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      issue(issues, "PROPOSAL_WORKSPACE_INVALID", `${base}.slug is invalid.`, `${base}.slug`);
    }
    if (!isOneOf(item.confidence, CONFIDENCE_LEVELS)) {
      issue(issues, "PROPOSAL_FIELD_INVALID", `${base}.confidence is not supported.`, `${base}.confidence`);
    }
    if (issues.length !== firstIssue) return;
    workspaces.push({
      temporaryId: temporaryId as string,
      slug: slug as string,
      name: name as string,
      description: description as string,
      rationale: rationale as string,
      confidence: item.confidence as WorkspaceProposal["confidence"],
    });
  });

  const tasks: TaskProposalOutline[] = [];
  value.tasks.forEach((item, index) => {
    const firstIssue = issues.length;
    const base = `tasks[${index}]`;
    if (!isRecord(item)) {
      issue(issues, "PROPOSAL_TASK_INVALID", `${base} must be an object.`, base);
      return;
    }
    const temporaryId = requiredString(item.temporaryId, `${base}.temporaryId`, issues);
    const title = requiredString(item.title, `${base}.title`, issues);
    const objective = requiredString(item.objective, `${base}.objective`, issues);
    const workspaceSlug = requiredString(item.workspaceSlug, `${base}.workspaceSlug`, issues);
    const suggestedDependencies = stringArray(item.suggestedDependencies, `${base}.suggestedDependencies`, issues);
    const suggestedPaths = stringArray(item.suggestedPaths, `${base}.suggestedPaths`, issues);
    const acceptanceCriteria = parseCriteria(item.acceptanceCriteria, index, issues);
    const risks = stringArray(item.risks, `${base}.risks`, issues);
    const questions = stringArray(item.questions, `${base}.questions`, issues);

    if (temporaryId && temporaryIds.has(temporaryId)) {
      issue(issues, "PROPOSAL_ID_DUPLICATE", `temporaryId ${temporaryId} is duplicated.`, `${base}.temporaryId`);
    } else if (temporaryId) temporaryIds.add(temporaryId);
    if (workspaceSlug && !/^[a-z0-9][a-z0-9-]*$/.test(workspaceSlug)) {
      issue(issues, "PROPOSAL_WORKSPACE_INVALID", `${base}.workspaceSlug is invalid.`, `${base}.workspaceSlug`);
    }
    if (!isOneOf(item.kind, TASK_KINDS)) {
      issue(issues, "PROPOSAL_FIELD_INVALID", `${base}.kind is not supported.`, `${base}.kind`);
    }
    if (!isOneOf(item.priority, TASK_PRIORITIES)) {
      issue(issues, "PROPOSAL_FIELD_INVALID", `${base}.priority is not supported.`, `${base}.priority`);
    }
    if (!isOneOf(item.confidence, CONFIDENCE_LEVELS)) {
      issue(issues, "PROPOSAL_FIELD_INVALID", `${base}.confidence is not supported.`, `${base}.confidence`);
    }
    if (typeof item.phaseId !== "string" || !item.phaseId.trim()) {
      issue(issues, "PROPOSAL_FIELD_INVALID", `${base}.phaseId must be a non-empty string.`, `${base}.phaseId`);
    }
    for (const candidate of suggestedPaths ?? []) {
      if (!safeRepositoryPath(candidate)) {
        issue(
          issues,
          "PROPOSAL_PATH_UNSAFE",
          `${base}.suggestedPaths contains a path outside the repository boundary: ${candidate}`,
          `${base}.suggestedPaths`,
        );
      }
    }

    if (issues.length !== firstIssue) return;
    const task: TaskProposalOutline = {
      temporaryId: temporaryId as string,
      title: title as string,
      objective: objective as string,
      kind: item.kind as TaskKind,
      workspaceSlug: workspaceSlug as string,
      phaseId: (item.phaseId as string).trim(),
      priority: item.priority as TaskPriority,
      suggestedDependencies: suggestedDependencies as string[],
      suggestedPaths: suggestedPaths as string[],
      acceptanceCriteria: acceptanceCriteria as TaskProposalCriterion[],
      risks: risks as string[],
      questions: questions as string[],
      confidence: item.confidence as TaskProposal["confidence"],
    };
    tasks.push(task);
  });

  if (!issues.length && options?.target?.type === "repository") {
    if (workspaces.length !== 1) {
      issue(
        issues,
        "PROPOSAL_WORKSPACE_REQUIRED",
        "Repository-scoped planning must propose exactly one workspace.",
        "workspaces",
      );
    } else {
      const proposedSlug = workspaces[0]?.slug;
      if (proposedSlug && options.existingWorkspaceSlugs?.includes(proposedSlug)) {
        issue(
          issues,
          "PROPOSAL_WORKSPACE_EXISTS",
          `Workspace ${proposedSlug} already exists.`,
          "workspaces[0].slug",
        );
      }
      if (proposedSlug && tasks.some((task) => task.workspaceSlug !== proposedSlug)) {
        issue(
          issues,
          "PROPOSAL_WORKSPACE_MISMATCH",
          `Every task must target proposed workspace ${proposedSlug}.`,
          "tasks.workspaceSlug",
        );
      }
    }
  }

  if (!issues.length && options?.target?.type === "workspace") {
    const workspaceSlug = options.target.workspaceSlug;
    if (workspaces.length !== 0) {
      issue(
        issues,
        "PROPOSAL_WORKSPACE_UNEXPECTED",
        "Workspace-scoped planning cannot create another workspace.",
        "workspaces",
      );
    }
    if (tasks.some((task) => task.workspaceSlug !== workspaceSlug)) {
      issue(
        issues,
        "PROPOSAL_WORKSPACE_MISMATCH",
        `Every task must target workspace ${workspaceSlug}.`,
        "tasks.workspaceSlug",
      );
    }
  }

  return { proposals: issues.length ? null : { workspaces, tasks }, issues };
}

export function validatePlanningProposalSet(value: unknown, options?: {
  target?: PlanningTarget;
  existingWorkspaceSlugs?: string[];
}): {
  proposals: PlanningProposalSet | null;
  issues: ValidationIssue[];
} {
  return validateProposalSet(value, options ?? {});
}

export const validatePlanningOutlineSet = validatePlanningProposalSet;

export const validateTaskProposalSet = validatePlanningProposalSet;

export class ProposalValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(issues.map((item) => item.message).join(" "));
    this.name = "ProposalValidationError";
  }
}

function taskPrefix(workspaceSlug: string): string {
  const letters = workspaceSlug.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase();
  return letters.padEnd(3, "X");
}

async function publishTasks(options: {
  root: string;
  workspaceSlug: string;
  tasksDirectory: string;
  proposals: TaskProposal[];
}): Promise<string[]> {
  const tasksDirectory = options.tasksDirectory;
  await mkdir(tasksDirectory, { recursive: true });
  const prefix = taskPrefix(options.workspaceSlug);
  const entries = await readdir(tasksDirectory, { withFileTypes: true });
  let nextNumber = entries.reduce((highest, entry) => {
    const match = entry.name.match(new RegExp(`^${prefix}-(\\d+)\\.ya?ml$`, "i"));
    return match?.[1] ? Math.max(highest, Number(match[1])) : highest;
  }, 0) + 1;

  const assignedIds = new Map<string, string>();
  for (const proposal of options.proposals) {
    assignedIds.set(proposal.temporaryId, `${prefix}-${String(nextNumber).padStart(3, "0")}`);
    nextNumber += 1;
  }

  const createdPaths: string[] = [];
  try {
    for (const proposal of options.proposals) {
      const id = assignedIds.get(proposal.temporaryId) as string;
      const document = {
        schemaVersion: "phaseatlas.task/v1",
        id,
        title: proposal.title,
        kind: proposal.kind,
        phase: proposal.phaseId || "planning",
        state: "planned",
        priority: proposal.priority,
        objective: proposal.objective,
        owners: [],
        dependencies: proposal.suggestedDependencies.map((dependency) => ({
          taskKey: assignedIds.get(dependency) ?? dependency,
          relation: "blocks_start",
          requiredState: "done",
        })),
        scope: {
          allowedPaths: proposal.suggestedPaths,
          forbiddenPaths: [],
          writable: proposal.kind === "code" || proposal.kind === "operations",
          allowDependencyChanges: false,
          allowDatabaseMigrations: false,
          allowExternalNetwork: false,
        },
        acceptanceCriteria: proposal.acceptanceCriteria.map((criterion, index) => ({
          id: `AC-${index + 1}`,
          statement: criterion.statement,
          verification: { type: "human", reviewerRole: "PhaseAtlas maintainer" },
        })),
        verification: [],
        evidenceRequirements: [{ type: "human_review" }],
      };
      const filePath = path.join(tasksDirectory, `${id}.yaml`);
      await writeFile(filePath, stringify(document, { lineWidth: 100 }), { encoding: "utf8", flag: "wx" });
      createdPaths.push(filePath);
    }
  } catch (error) {
    await Promise.all(createdPaths.map((filePath) => unlink(filePath).catch(() => undefined)));
    throw error;
  }

  return createdPaths.map((filePath) => path.relative(options.root, filePath).replaceAll(path.sep, "/"));
}

export async function publishPlanningProposals(options: {
  root: string;
  workspaces: WorkspaceSummary[];
  target: PlanningTarget;
  value: unknown;
}): Promise<string[]> {
  const validation = validatePlanningProposalSet(options.value, {
    target: options.target,
    existingWorkspaceSlugs: options.workspaces.map((workspace) => workspace.slug),
  });
  if (!validation.proposals) throw new ProposalValidationError(validation.issues);

  if (options.target.type === "workspace") {
    const workspaceSlug = options.target.workspaceSlug;
    const workspace = options.workspaces.find((item) => item.slug === workspaceSlug);
    if (!workspace) throw new Error(`Workspace ${workspaceSlug} does not exist.`);
    return publishTasks({
      root: options.root,
      workspaceSlug: workspace.slug,
      tasksDirectory: path.join(path.dirname(path.join(options.root, workspace.sourcePath)), "tasks"),
      proposals: validation.proposals.tasks,
    });
  }

  const workspace = validation.proposals.workspaces[0] as WorkspaceProposal;
  const workspacesRoot = path.join(options.root, ".phaseatlas", "workspaces");
  const workspaceDirectory = path.join(workspacesRoot, workspace.slug);
  const temporaryDirectory = path.join(workspacesRoot, `.${workspace.slug}.${randomUUID()}.tmp`);
  await mkdir(temporaryDirectory, { recursive: true });
  try {
    await writeFile(
      path.join(temporaryDirectory, "workspace.yaml"),
      stringify({
        schemaVersion: "phaseatlas.workspace/v1",
        slug: workspace.slug,
        name: workspace.name,
        description: workspace.description,
      }, { lineWidth: 100 }),
      { encoding: "utf8", flag: "wx" },
    );
    await publishTasks({
      root: options.root,
      workspaceSlug: workspace.slug,
      tasksDirectory: path.join(temporaryDirectory, "tasks"),
      proposals: validation.proposals.tasks,
    });
    await rename(temporaryDirectory, workspaceDirectory);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  return [
    path.relative(options.root, path.join(workspaceDirectory, "workspace.yaml")).replaceAll(path.sep, "/"),
    ...validation.proposals.tasks.map((_task, index) => {
      const id = `${taskPrefix(workspace.slug)}-${String(index + 1).padStart(3, "0")}`;
      return path.relative(options.root, path.join(workspaceDirectory, "tasks", `${id}.yaml`)).replaceAll(path.sep, "/");
    }),
  ];
}

export async function publishTaskProposals(options: {
  root: string;
  workspace: WorkspaceSummary;
  value: unknown;
}): Promise<string[]> {
  const value = isRecord(options.value) && !Array.isArray(options.value.workspaces)
    ? { ...options.value, workspaces: [] }
    : options.value;
  return publishPlanningProposals({
    root: options.root,
    workspaces: [options.workspace],
    target: { type: "workspace", workspaceSlug: options.workspace.slug },
    value,
  });
}
