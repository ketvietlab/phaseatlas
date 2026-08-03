import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CanonicalTask } from "@phaseatlas/contracts";
import { parse, stringify } from "yaml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function writeTaskContent(options: {
  root: string;
  task: CanonicalTask;
  body: string;
}): Promise<string> {
  if (!options.body.trim()) throw new Error("Task content cannot be empty.");
  const taskSource = options.task.source.documents.find((document) => /\.ya?ml$/i.test(document.path));
  if (!taskSource) throw new Error(`Task ${options.task.key.taskId} has no canonical YAML source.`);
  const yamlPath = path.resolve(options.root, taskSource.path);
  if (!inside(options.root, yamlPath)) throw new Error("Task source is outside the repository boundary.");
  const document = parse(await readFile(yamlPath, "utf8")) as unknown;
  if (!isRecord(document)) throw new Error(`${taskSource.path} must contain a YAML object.`);

  const taskDirectory = path.dirname(yamlPath);
  const existingPath = isRecord(document.content) && typeof document.content.path === "string"
    ? document.content.path
    : undefined;
  const contentFileName = existingPath ?? `${options.task.key.taskId}.md`;
  const contentPath = path.resolve(taskDirectory, contentFileName);
  if (!inside(taskDirectory, contentPath)) throw new Error("Task content path must stay inside the task directory.");

  const nonce = randomUUID();
  const temporaryContentPath = path.join(taskDirectory, `.${path.basename(contentPath)}.${nonce}.tmp`);
  await writeFile(temporaryContentPath, options.body, "utf8");
  await rename(temporaryContentPath, contentPath);

  if (!existingPath) {
    document.content = { path: path.basename(contentPath) };
    const temporaryYamlPath = path.join(taskDirectory, `.${path.basename(yamlPath)}.${nonce}.tmp`);
    await writeFile(temporaryYamlPath, stringify(document, { lineWidth: 100 }), "utf8");
    await rename(temporaryYamlPath, yamlPath);
  }

  return path.relative(options.root, contentPath).replaceAll(path.sep, "/");
}
