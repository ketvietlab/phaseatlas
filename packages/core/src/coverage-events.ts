import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CoverageDocumentProjection,
  CoverageEvent,
  CoverageEventAppendInput,
  CoverageSnapshot,
  TaskRegistrySource,
  ValidationIssue,
} from "@phaseatlas/contracts";
import { parse, stringify } from "yaml";

const executeFile = promisify(execFile);
const EVENT_SCHEMA = "phaseatlas.coverage-event/v1" as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EVENT_KEYS = new Set([
  "schemaVersion", "id", "path", "contentSha256", "size", "sourceCommit", "recordedAt",
  "result", "codeScopes", "stagingStatus", "inlineFixes", "taskRefs", "workItemRefs", "resolves",
]);

interface CurrentDocument {
  path: string;
  contentSha256: string;
  size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function issue(sourcePath: string, code: string, message: string): ValidationIssue {
  return { severity: "error", sourcePath, code, message };
}

function safeDocumentPath(candidate: string): boolean {
  return candidate.startsWith("docs/") &&
    !candidate.startsWith("/") &&
    !candidate.includes("\\") &&
    !candidate.split("/").some((part) => !part || part === "." || part === "..");
}

function stringArray(value: unknown, field: string, sourcePath: string, issues: ValidationIssue[]): string[] {
  if (!Array.isArray(value) || value.length > 256 || value.some((entry) =>
    typeof entry !== "string" || !entry.trim() || entry.length > 500 || /[\r\n\0]/.test(entry)
  )) {
    issues.push(issue(sourcePath, "COVERAGE_EVENT_FIELD", `${field} must contain at most 256 bounded, non-empty strings.`));
    return [];
  }
  return [...new Set(value.map((entry) => (entry as string).trim()))].sort();
}

function parseCoverageEvent(value: unknown, sourcePath: string, filename: string, issues: ValidationIssue[]): CoverageEvent | undefined {
  if (!isRecord(value)) {
    issues.push(issue(sourcePath, "COVERAGE_EVENT_OBJECT", "Coverage event must contain a YAML object."));
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!EVENT_KEYS.has(key)) issues.push(issue(sourcePath, "COVERAGE_EVENT_UNKNOWN_FIELD", `Unknown coverage event field: ${key}.`));
  }
  const id = typeof value.id === "string" ? value.id : "";
  const documentPath = typeof value.path === "string" ? value.path : "";
  const contentSha256 = typeof value.contentSha256 === "string" ? value.contentSha256 : "";
  const sourceCommit = typeof value.sourceCommit === "string" ? value.sourceCommit : "";
  const recordedAt = typeof value.recordedAt === "string" ? value.recordedAt : "";
  const size = value.size;
  const result = value.result;
  const stagingStatus = value.stagingStatus;
  if (value.schemaVersion !== EVENT_SCHEMA) issues.push(issue(sourcePath, "COVERAGE_EVENT_SCHEMA", `schemaVersion must be ${EVENT_SCHEMA}.`));
  if (!ID_PATTERN.test(id) || filename !== `${id}.yaml`) issues.push(issue(sourcePath, "COVERAGE_EVENT_ID", "Event id must be a UUID matching its filename."));
  if (!safeDocumentPath(documentPath) || documentPath.length > 1024) issues.push(issue(sourcePath, "COVERAGE_EVENT_PATH", "Coverage path must be a safe, bounded path below docs/."));
  if (!SHA256_PATTERN.test(contentSha256)) issues.push(issue(sourcePath, "COVERAGE_EVENT_HASH", "contentSha256 must be a lowercase SHA-256 hash."));
  if (!Number.isSafeInteger(size) || (size as number) < 0) issues.push(issue(sourcePath, "COVERAGE_EVENT_SIZE", "size must be a non-negative integer."));
  if (!COMMIT_PATTERN.test(sourceCommit)) issues.push(issue(sourcePath, "COVERAGE_EVENT_COMMIT", "sourceCommit must be a Git object id."));
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(recordedAt) || Number.isNaN(Date.parse(recordedAt))) {
    issues.push(issue(sourcePath, "COVERAGE_EVENT_TIME", "recordedAt must be a canonical UTC ISO timestamp."));
  }
  if (!(["clean", "fixed", "issue"] as unknown[]).includes(result)) issues.push(issue(sourcePath, "COVERAGE_EVENT_RESULT", "result is invalid."));
  if (!(["not-applicable", "not-verified", "verified-read-only"] as unknown[]).includes(stagingStatus)) {
    issues.push(issue(sourcePath, "COVERAGE_EVENT_STAGING", "stagingStatus is invalid."));
  }
  const beforeArrays = issues.length;
  const codeScopes = stringArray(value.codeScopes, "codeScopes", sourcePath, issues);
  const inlineFixes = stringArray(value.inlineFixes, "inlineFixes", sourcePath, issues);
  const taskRefs = stringArray(value.taskRefs, "taskRefs", sourcePath, issues);
  const workItemRefs = stringArray(value.workItemRefs, "workItemRefs", sourcePath, issues);
  const resolves = stringArray(value.resolves, "resolves", sourcePath, issues);
  if (resolves.includes(id)) issues.push(issue(sourcePath, "COVERAGE_EVENT_SELF_RESOLUTION", "A coverage event cannot resolve itself."));
  if (issues.length !== beforeArrays || issues.some((candidate) => candidate.sourcePath === sourcePath)) return undefined;
  return {
    schemaVersion: EVENT_SCHEMA,
    id,
    path: documentPath,
    contentSha256,
    size: size as number,
    sourceCommit,
    recordedAt: new Date(recordedAt).toISOString(),
    result: result as CoverageEvent["result"],
    codeScopes,
    stagingStatus: stagingStatus as CoverageEvent["stagingStatus"],
    inlineFixes,
    taskRefs,
    workItemRefs,
    resolves,
  };
}

async function git(repositoryRoot: string, args: string[]): Promise<string> {
  const result = await executeFile("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  return result.stdout.trimEnd();
}

async function currentDocument(repositoryRoot: string, documentPath: string): Promise<CurrentDocument> {
  if (!safeDocumentPath(documentPath)) throw new Error("Coverage path must be a safe path below docs/.");
  const tracked = (await git(repositoryRoot, ["ls-files", "--error-unmatch", "--", documentPath])).split("\n").filter(Boolean);
  if (tracked.length !== 1 || tracked[0] !== documentPath) throw new Error("Coverage events may reference only a tracked documentation file.");
  const canonicalRoot = await realpath(repositoryRoot);
  const absolutePath = path.join(canonicalRoot, ...documentPath.split("/"));
  const resolvedPath = await realpath(absolutePath);
  if (resolvedPath !== absolutePath) throw new Error("Coverage document paths must not traverse symbolic links.");
  const stats = await lstat(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Coverage events may reference only a regular documentation file.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  return { path: documentPath, size: stats.size, contentSha256: hash.digest("hex") };
}

async function currentDocuments(repositoryRoot: string, issues: ValidationIssue[]): Promise<CurrentDocument[]> {
  const paths = (await git(repositoryRoot, ["ls-files", "-z", "--", "docs"])).split("\0").filter(Boolean).sort();
  const documents: CurrentDocument[] = [];
  for (const documentPath of paths) {
    try {
      documents.push(await currentDocument(repositoryRoot, documentPath));
    } catch (error) {
      issues.push(issue(documentPath, "COVERAGE_DOCUMENT_UNREADABLE", error instanceof Error ? error.message : "Documentation file is unreadable."));
    }
  }
  return documents;
}

async function loadEvents(contractRoot: string, workspaceSlug: string, issues: ValidationIssue[]): Promise<CoverageEvent[]> {
  const relativeRoot = `.phaseatlas/workspaces/${workspaceSlug}/coverage-events`;
  const eventRoot = path.join(contractRoot, ...relativeRoot.split("/"));
  let entries;
  try {
    entries = await readdir(eventRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: CoverageEvent[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = `${relativeRoot}/${entry.name}`;
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
      issues.push(issue(sourcePath, "COVERAGE_EVENT_ENTRY", "coverage-events may contain only flat .yaml event files."));
      continue;
    }
    try {
      const eventPath = path.join(eventRoot, entry.name);
      if ((await lstat(eventPath)).size > 1024 * 1024) {
        issues.push(issue(sourcePath, "COVERAGE_EVENT_SIZE_LIMIT", "Coverage event exceeds the one MiB limit."));
        continue;
      }
      const parsed = parse((await readFile(eventPath, "utf8")));
      const event = parseCoverageEvent(parsed, sourcePath, entry.name, issues);
      if (event) events.push(event);
    } catch (error) {
      issues.push(issue(sourcePath, "COVERAGE_EVENT_YAML", error instanceof Error ? error.message : "Coverage event YAML is invalid."));
    }
  }
  return events;
}

function semanticSignature(event: CoverageEvent): string {
  return JSON.stringify({
    result: event.result,
    codeScopes: event.codeScopes,
    stagingStatus: event.stagingStatus,
    inlineFixes: event.inlineFixes,
    taskRefs: event.taskRefs,
    workItemRefs: event.workItemRefs,
  });
}

export async function loadCoverageSnapshot(options: {
  repositoryRoot: string;
  contractRoot: string;
  repositoryId: string;
  workspaceSlug: string;
  registrySource?: TaskRegistrySource;
}): Promise<CoverageSnapshot> {
  if (!SLUG_PATTERN.test(options.workspaceSlug)) throw new Error("Coverage workspace slug is invalid.");
  const issues: ValidationIssue[] = [];
  const [documents, events, sourceCommit] = await Promise.all([
    currentDocuments(options.repositoryRoot, issues),
    loadEvents(options.contractRoot, options.workspaceSlug, issues),
    git(options.repositoryRoot, ["rev-parse", "HEAD"]),
  ]);
  const byId = new Map(events.map((event) => [event.id, event]));
  const resolutionEdges: Array<{ resolver: CoverageEvent; target: CoverageEvent }> = [];
  for (const resolver of events) {
    for (const targetId of resolver.resolves) {
      const target = byId.get(targetId);
      if (!target) {
        issues.push(issue(`.phaseatlas/workspaces/${options.workspaceSlug}/coverage-events/${resolver.id}.yaml`, "COVERAGE_EVENT_RESOLUTION_MISSING", `Resolved event ${targetId} does not exist.`));
      } else if (target.path !== resolver.path || target.contentSha256 !== resolver.contentSha256 || target.size !== resolver.size) {
        issues.push(issue(`.phaseatlas/workspaces/${options.workspaceSlug}/coverage-events/${resolver.id}.yaml`, "COVERAGE_EVENT_RESOLUTION_MISMATCH", `Resolved event ${targetId} belongs to a different document revision.`));
      } else {
        resolutionEdges.push({ resolver, target });
      }
    }
  }
  const adjacency = new Map<string, string[]>();
  for (const { resolver, target } of resolutionEdges) {
    adjacency.set(resolver.id, [...(adjacency.get(resolver.id) ?? []), target.id]);
  }
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycleNodes = new Set<string>();
  const visit = (id: string): void => {
    if (state.get(id) === "visited") return;
    if (state.get(id) === "visiting") {
      const start = stack.lastIndexOf(id);
      for (const cycleId of stack.slice(start)) cycleNodes.add(cycleId);
      return;
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const targetId of adjacency.get(id) ?? []) visit(targetId);
    stack.pop();
    state.set(id, "visited");
  };
  for (const event of events) visit(event.id);
  for (const eventId of [...cycleNodes].sort()) {
    issues.push(issue(`.phaseatlas/workspaces/${options.workspaceSlug}/coverage-events/${eventId}.yaml`, "COVERAGE_EVENT_RESOLUTION_CYCLE", "Coverage resolution graph must not contain a cycle."));
  }
  const validResolved = new Set(resolutionEdges
    .filter(({ resolver, target }) => !cycleNodes.has(resolver.id) && !cycleNodes.has(target.id))
    .map(({ target }) => target.id));
  const projections: CoverageDocumentProjection[] = documents.map((document) => {
    const active = events.filter((event) =>
      event.path === document.path && event.contentSha256 === document.contentSha256 && event.size === document.size && !validResolved.has(event.id)
    ).sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id));
    const signatures = new Set(active.map(semanticSignature));
    if (!active.length) return { ...document, status: "pending", activeEventIds: [] };
    if (signatures.size > 1) {
      issues.push(issue(document.path, "COVERAGE_PROJECTION_CONFLICT", `Document revision has conflicting active coverage events: ${active.map((event) => event.id).join(", ")}.`));
      return { ...document, status: "conflicted", activeEventIds: active.map((event) => event.id) };
    }
    return { ...document, status: "covered", activeEventIds: active.map((event) => event.id), event: active.at(-1) };
  });
  return {
    repositoryId: options.repositoryId,
    workspaceSlug: options.workspaceSlug,
    sourceCommit,
    ...(options.registrySource ? {
      registry: {
        remote: options.registrySource.remote,
        ref: options.registrySource.ref,
        commit: options.registrySource.commit,
      },
    } : {}),
    generatedAt: new Date().toISOString(),
    documents: projections,
    issues,
    summary: {
      pending: projections.filter((document) => document.status === "pending").length,
      covered: projections.filter((document) => document.status === "covered").length,
      conflicted: projections.filter((document) => document.status === "conflicted").length,
    },
  };
}

export async function createCoverageEvent(options: {
  repositoryRoot: string;
  input: CoverageEventAppendInput;
  id: string;
  recordedAt: string;
}): Promise<CoverageEvent> {
  if (!SLUG_PATTERN.test(options.input.workspaceSlug)) throw new Error("Coverage workspace slug is invalid.");
  if (!ID_PATTERN.test(options.id)) throw new Error("Coverage event id is invalid.");
  if (!SHA256_PATTERN.test(options.input.expectedContentSha256)) throw new Error("Expected coverage content hash is invalid.");
  const document = await currentDocument(options.repositoryRoot, options.input.path);
  if (document.contentSha256 !== options.input.expectedContentSha256) {
    throw new Error("Documentation changed after it was audited. Refresh coverage before recording the result.");
  }
  const sourceCommit = await git(options.repositoryRoot, ["rev-parse", "HEAD"]);
  const event: CoverageEvent = {
    schemaVersion: EVENT_SCHEMA,
    id: options.id,
    path: document.path,
    contentSha256: document.contentSha256,
    size: document.size,
    sourceCommit,
    recordedAt: new Date(options.recordedAt).toISOString(),
    result: options.input.result,
    codeScopes: [...new Set(options.input.codeScopes ?? [])].sort(),
    stagingStatus: options.input.stagingStatus ?? "not-applicable",
    inlineFixes: [...new Set(options.input.inlineFixes ?? [])].sort(),
    taskRefs: [...new Set(options.input.taskRefs ?? [])].sort(),
    workItemRefs: [...new Set(options.input.workItemRefs ?? [])].sort(),
    resolves: [...new Set(options.input.resolves ?? [])].sort(),
  };
  const validationIssues: ValidationIssue[] = [];
  if (!parseCoverageEvent(event, `${event.id}.yaml`, `${event.id}.yaml`, validationIssues)) {
    throw new Error(validationIssues.map((candidate) => candidate.message).join(" "));
  }
  return event;
}

export function serializeCoverageEvent(event: CoverageEvent): string {
  return stringify(event, { lineWidth: 0, sortMapEntries: false });
}
