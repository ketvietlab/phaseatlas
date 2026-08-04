import type { AgentResultReview } from "@phaseatlas/contracts";
import type { CheckoutOperationalStore } from "./checkout-operational-store.js";
import type { RepositoryInspector } from "./repository-inspector.js";

export async function reviewAgentResult(
  store: CheckoutOperationalStore,
  inspector: RepositoryInspector,
  runId: string,
): Promise<AgentResultReview> {
  const persisted = store.getAgentResult(runId);
  if (!persisted) throw new Error(`Agent result ${runId} does not exist.`);
  const revalidation = store.latestResultRevalidation(runId);
  let snapshot;
  try {
    snapshot = await inspector.taskSnapshot();
  } catch {
    return {
      persisted,
      freshness: "unverifiable",
      ...(revalidation ? { revalidation } : {}),
      promotable: false,
      reason: "The canonical task registry could not be inspected.",
    };
  }
  if (snapshot.issues.some((issue) => issue.severity === "error")) {
    return {
      persisted,
      freshness: "unverifiable",
      ...(revalidation ? { revalidation } : {}),
      promotable: false,
      reason: "The canonical task registry contains validation errors.",
    };
  }
  const task = snapshot.tasks.find((candidate) =>
    `${candidate.key.workspaceSlug}/${candidate.key.taskId}` === persisted.taskKey,
  );
  if (!task) {
    return {
      persisted,
      freshness: "unverifiable",
      ...(revalidation ? { revalidation } : {}),
      promotable: false,
      reason: "The canonical task no longer resolves uniquely.",
    };
  }
  const revisionIsCurrent = persisted.taskRevision === task.revision;
  const passedCurrentRevalidation = revalidation?.outcome === "passed" && revalidation.taskRevision === task.revision;
  const failedCurrentRevalidation = revalidation?.outcome === "failed" && revalidation.taskRevision === task.revision;
  const freshness = revisionIsCurrent || passedCurrentRevalidation ? "current" : "stale";
  const resultAcceptable = persisted.validated.result.outcome !== "failed" &&
    persisted.validated.policyViolations.length === 0;
  return {
    persisted,
    freshness,
    currentTaskRevision: task.revision,
    ...(revalidation ? { revalidation } : {}),
    promotable: freshness === "current" && resultAcceptable && !failedCurrentRevalidation,
    ...(freshness === "stale"
      ? { reason: "The result was produced for an obsolete canonical task revision." }
      : failedCurrentRevalidation
        ? { reason: "The latest revalidation for the current task revision failed." }
      : !resultAcceptable
        ? { reason: "The validated result contains a failed outcome or policy violations." }
        : {}),
  };
}
