import assert from "node:assert/strict";
import test from "node:test";
import { TASK_CONTENT_SCHEMA, TASK_PROPOSAL_SCHEMA } from "@phaseatlas/contracts";
import { formatCodexJsonEvent, RunnerRegistry } from "./runner-registry.js";

function assertStrictObjectSchemas(value: unknown, location = "root"): void {
  if (!value || typeof value !== "object") return;
  const schema = value as Record<string, unknown>;
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    const propertyNames = Object.keys(schema.properties as Record<string, unknown>).sort();
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string").sort()
      : [];
    assert.deepEqual(required, propertyNames, `${location} must require every declared property`);
  }
  for (const [key, nested] of Object.entries(schema)) {
    if (Array.isArray(nested)) {
      nested.forEach((item, index) => assertStrictObjectSchemas(item, `${location}.${key}[${index}]`));
    } else {
      assertStrictObjectSchemas(nested, `${location}.${key}`);
    }
  }
}

test("uses an OpenAI strict-compatible proposal schema", () => {
  assertStrictObjectSchemas(TASK_PROPOSAL_SCHEMA);
  assertStrictObjectSchemas(TASK_CONTENT_SCHEMA);
});

test("discovers provider-neutral planning runner descriptors", async () => {
  const descriptors = await new RunnerRegistry().list();
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), ["codex-cli", "claude-code"]);
  for (const descriptor of descriptors) {
    assert.equal(descriptor.capabilities.includes("planning"), true);
    assert.equal(descriptor.capabilities.includes("structured_output"), true);
    assert.equal(typeof descriptor.available, "boolean");
  }
});

test("formats Codex JSONL events as readable terminal progress", () => {
  assert.equal(
    formatCodexJsonEvent({ type: "thread.started", thread_id: "019fc766-e8b7" }),
    "Session opened · 019fc766\n",
  );
  assert.equal(
    formatCodexJsonEvent({
      type: "item.started",
      item: { type: "command_execution", command: "rg --files apps" },
    }),
    "→ rg --files apps\n",
  );
  assert.equal(
    formatCodexJsonEvent({
      type: "turn.completed",
      usage: { input_tokens: 1250, output_tokens: 340 },
    }),
    "Turn completed · 1,250 input / 340 output tokens\n",
  );
  assert.equal(formatCodexJsonEvent({ type: "unknown.event" }), "");
});
