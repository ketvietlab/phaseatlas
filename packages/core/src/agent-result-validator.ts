import path from "node:path";
import {
  AGENT_RUN_RESULT_SCHEMA,
  TASK_STATES,
  type AgentFileChangeType,
  type AgentRunOutcome,
  type AgentRunResult,
} from "@phaseatlas/contracts";

const RESULT_SCHEMA = AGENT_RUN_RESULT_SCHEMA as unknown as {
  required: string[];
  properties: Record<string, unknown>;
};
const OUTCOMES = new Set<AgentRunOutcome>(["completed", "partial", "blocked", "failed"]);
const CHANGE_TYPES = new Set<AgentFileChangeType>(["added", "modified", "deleted"]);
const VERIFICATION_STATUSES = new Set(["passed", "failed", "not_run"]);
const EVIDENCE_TYPES = new Set(["diff", "test", "commit", "pull_request", "document"]);
const RESULT_FIELDS = new Set(Object.keys(RESULT_SCHEMA.properties));

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

export function isSafeAgentPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) return false;
  const segments = normalized.split("/");
  return !segments.includes("..") && !segments.includes(".git") && !segments.some((segment) => !segment);
}

export function validateAgentRunResult(value: unknown): AgentRunResult {
  if (!isRecord(value)) throw new Error("Agent result must be an object.");
  for (const field of Object.keys(value)) {
    if (!RESULT_FIELDS.has(field)) throw new Error(`Agent result contains unsupported field ${field}.`);
  }
  for (const field of RESULT_SCHEMA.required) {
    if (!(field in value)) throw new Error(`Agent result is missing required field ${field}.`);
  }
  if (!OUTCOMES.has(value.outcome as AgentRunOutcome)) throw new Error("Agent result outcome is invalid.");
  const summary = requiredString(value.summary, "summary");
  const nextAction = requiredString(value.nextAction, "nextAction");
  if (typeof value.requiresHumanReview !== "boolean") throw new Error("requiresHumanReview must be a boolean.");
  if (!Array.isArray(value.changedFiles)) throw new Error("changedFiles must be an array.");
  const changedFiles = value.changedFiles.map((item, index) => {
    if (!isRecord(item) || Object.keys(item).some((field) => !["path", "changeType"].includes(field))) {
      throw new Error(`changedFiles[${index}] is invalid.`);
    }
    const filePath = requiredString(item.path, `changedFiles[${index}].path`).replaceAll("\\", "/");
    if (!isSafeAgentPath(filePath)) throw new Error(`changedFiles[${index}].path is unsafe.`);
    if (!CHANGE_TYPES.has(item.changeType as AgentFileChangeType)) {
      throw new Error(`changedFiles[${index}].changeType is invalid.`);
    }
    return { path: filePath, changeType: item.changeType as AgentFileChangeType };
  });
  if (!Array.isArray(value.verification)) throw new Error("verification must be an array.");
  const verification = value.verification.map((item, index) => {
    if (!isRecord(item) || Object.keys(item).some((field) => !["stepId", "status", "details"].includes(field))) {
      throw new Error(`verification[${index}] is invalid.`);
    }
    if (!VERIFICATION_STATUSES.has(String(item.status))) throw new Error(`verification[${index}].status is invalid.`);
    return {
      stepId: requiredString(item.stepId, `verification[${index}].stepId`),
      status: item.status as "passed" | "failed" | "not_run",
      details: requiredString(item.details, `verification[${index}].details`),
    };
  });
  if (!Array.isArray(value.producedEvidence)) throw new Error("producedEvidence must be an array.");
  const producedEvidence = value.producedEvidence.map((item, index) => {
    if (!isRecord(item) || Object.keys(item).some((field) => !["type", "reference"].includes(field))) {
      throw new Error(`producedEvidence[${index}] is invalid.`);
    }
    if (!EVIDENCE_TYPES.has(String(item.type))) throw new Error(`producedEvidence[${index}].type is invalid.`);
    return {
      type: item.type as "diff" | "test" | "commit" | "pull_request" | "document",
      reference: requiredString(item.reference, `producedEvidence[${index}].reference`),
    };
  });
  if (!Array.isArray(value.blockers) || value.blockers.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("blockers must be an array of non-empty strings.");
  }
  if (value.proposedTaskState !== undefined && !TASK_STATES.includes(value.proposedTaskState as never)) {
    throw new Error("proposedTaskState is invalid.");
  }
  return {
    outcome: value.outcome as AgentRunOutcome,
    summary,
    changedFiles,
    verification,
    producedEvidence,
    blockers: (value.blockers as string[]).map((item) => item.trim()),
    nextAction,
    requiresHumanReview: value.requiresHumanReview,
    ...(value.proposedTaskState ? { proposedTaskState: value.proposedTaskState as AgentRunResult["proposedTaskState"] } : {}),
  };
}
