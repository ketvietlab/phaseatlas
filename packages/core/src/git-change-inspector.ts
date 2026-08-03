import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentFileChangeType, InspectedAgentChange, TaskScope } from "@phaseatlas/contracts";
import { isSafeAgentPath } from "./agent-result-validator.js";

const execFileAsync = promisify(execFile);

export type GitCommand = (args: string[], cwd: string) => Promise<string>;

const defaultGitCommand: GitCommand = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return stdout;
};

function normalizeRule(rule: string): string {
  return rule.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/\*\*$/, "").replace(/\/$/, "");
}

function matchesRule(filePath: string, rule: string): boolean {
  const normalized = normalizeRule(rule);
  return Boolean(normalized && (filePath === normalized || filePath.startsWith(`${normalized}/`)));
}

function policyViolations(filePath: string, scope: TaskScope): string[] {
  const violations: string[] = [];
  if (!isSafeAgentPath(filePath)) return ["unsafe_path"];
  if (!scope.writable) violations.push("task_scope_read_only");
  if (!scope.allowedPaths.some((rule) => matchesRule(filePath, rule))) violations.push("outside_allowed_paths");
  if (scope.forbiddenPaths.some((rule) => matchesRule(filePath, rule))) violations.push("forbidden_path");
  return violations;
}

async function symlinkViolation(worktreePath: string, filePath: string): Promise<string | null> {
  const candidate = path.resolve(worktreePath, filePath);
  try {
    await access(candidate);
    const [root, target] = await Promise.all([realpath(worktreePath), realpath(candidate)]);
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "symlink_escape";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return null;
}

function parseTrackedChanges(output: string): Array<{ path: string; changeType: AgentFileChangeType }> {
  const fields = output.split("\0").filter(Boolean);
  const changes: Array<{ path: string; changeType: AgentFileChangeType }> = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++] as string;
    const firstPath = fields[index++] as string;
    if (/^[RC]/.test(status)) {
      const destination = fields[index++] as string;
      changes.push({ path: firstPath, changeType: "deleted" }, { path: destination, changeType: "added" });
    } else {
      changes.push({
        path: firstPath,
        changeType: status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted" : "modified",
      });
    }
  }
  return changes;
}

export async function inspectGitChanges(input: {
  worktreePath: string;
  scope: TaskScope;
  git?: GitCommand;
}): Promise<InspectedAgentChange[]> {
  const git = input.git ?? defaultGitCommand;
  const [trackedOutput, untrackedOutput] = await Promise.all([
    git(["diff", "--name-status", "-z", "HEAD"], input.worktreePath),
    git(["ls-files", "--others", "--exclude-standard", "-z"], input.worktreePath),
  ]);
  const changes = parseTrackedChanges(trackedOutput);
  for (const filePath of untrackedOutput.split("\0").filter(Boolean)) {
    changes.push({ path: filePath, changeType: "added" });
  }
  const unique = new Map<string, AgentFileChangeType>();
  for (const change of changes) unique.set(change.path.replaceAll("\\", "/"), change.changeType);
  const inspected: InspectedAgentChange[] = [];
  for (const [filePath, changeType] of [...unique].sort(([left], [right]) => left.localeCompare(right))) {
    const violations = policyViolations(filePath, input.scope);
    if (!violations.includes("unsafe_path")) {
      const symlink = await symlinkViolation(input.worktreePath, filePath);
      if (symlink) violations.push(symlink);
    }
    inspected.push({ path: filePath, changeType, policyViolations: violations });
  }
  return inspected;
}

export async function captureGitState(input: { worktreePath: string; git?: GitCommand }): Promise<string> {
  const git = input.git ?? defaultGitCommand;
  const [diff, untrackedOutput] = await Promise.all([
    git(["diff", "--binary", "HEAD"], input.worktreePath),
    git(["ls-files", "--others", "--exclude-standard", "-z"], input.worktreePath),
  ]);
  const hash = createHash("sha256").update(diff);
  for (const filePath of untrackedOutput.split("\0").filter(Boolean).sort()) {
    hash.update(filePath);
    const candidate = path.resolve(input.worktreePath, filePath);
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink()) {
      hash.update(await readlink(candidate));
    } else {
      if (!stat.isFile()) throw new Error(`Cannot fingerprint non-regular untracked path ${filePath}.`);
      if (stat.size > 10 * 1024 * 1024) throw new Error(`Cannot fingerprint oversized untracked file ${filePath}.`);
      hash.update(await readFile(candidate));
    }
  }
  return hash.digest("hex");
}
