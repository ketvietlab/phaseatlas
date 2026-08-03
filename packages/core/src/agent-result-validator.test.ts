import assert from "node:assert/strict";
import test from "node:test";
import { validateAgentRunResult } from "./agent-result-validator.js";

const result = {
  outcome: "completed",
  summary: "Implementation is ready for independent review.",
  changedFiles: [{ path: "packages/core/src/index.ts", changeType: "modified" }],
  verification: [{ stepId: "test", status: "passed", details: "Tests passed." }],
  producedEvidence: [{ type: "test", reference: "local:test" }],
  blockers: [],
  nextAction: "Review the result.",
  requiresHumanReview: true,
  proposedTaskState: "done",
};

test("accepts advisory done without granting canonical authority", () => {
  const validated = validateAgentRunResult(result);
  assert.equal(validated.proposedTaskState, "done");
  assert.equal(validated.requiresHumanReview, true);
});

test("rejects unsafe paths and unsupported result fields", () => {
  assert.throws(() => validateAgentRunResult({ ...result, changedFiles: [{ path: "../secret", changeType: "modified" }] }), /unsafe/);
  assert.throws(() => validateAgentRunResult({ ...result, command: "rm -rf" }), /unsupported field/);
});
