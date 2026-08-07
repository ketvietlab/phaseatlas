#!/usr/bin/env node
// Downloads the pinned default extensions into ide/default-extensions and
// rejects any file whose digest does not match the manifest.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repositoryRoot, "ide", "default-extensions.manifest.json");
const target = path.join(repositoryRoot, "ide", "default-extensions");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schemaVersion !== "phaseatlas.theia-extensions/v1") {
  throw new Error("Unsupported extension manifest schema.");
}
await mkdir(target, { recursive: true });

for (const extension of manifest.extensions) {
  const file = path.join(target, `${extension.id}-${extension.version}.vsix`);
  const response = await fetch(extension.url);
  if (!response.ok) throw new Error(`${extension.id}: download failed with ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== extension.sha256) {
    throw new Error(`${extension.id}: digest mismatch. Expected ${extension.sha256}, got ${digest}.`);
  }
  await writeFile(file, bytes);
  console.log(`${extension.id} ${extension.version}`);
}
await writeFile(path.join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`${manifest.extensions.length} extensions verified into ide/default-extensions`);
