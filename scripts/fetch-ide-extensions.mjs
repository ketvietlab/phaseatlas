#!/usr/bin/env node
// Downloads the pinned default extensions into ide/default-extensions and
// rejects any file whose digest does not match the manifest.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import extract from "extract-zip";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repositoryRoot, "ide", "default-extensions.manifest.json");
const target = path.join(repositoryRoot, "ide", "default-extensions");
const pluginsTarget = path.join(target, "plugins");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schemaVersion !== "phaseatlas.theia-extensions/v1") {
  throw new Error("Unsupported extension manifest schema.");
}
await rm(target, { recursive: true, force: true });
await mkdir(pluginsTarget, { recursive: true });
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-extensions-"));

try {
  for (const extension of manifest.extensions) {
    const archive = path.join(temporaryRoot, `${extension.id}-${extension.version}.vsix`);
    const destination = path.join(pluginsTarget, `${extension.id}-${extension.version}`);
    const response = await fetch(extension.url);
    if (!response.ok) throw new Error(`${extension.id}: download failed with ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== extension.sha256) {
      throw new Error(`${extension.id}: digest mismatch. Expected ${extension.sha256}, got ${digest}.`);
    }
    await writeFile(archive, bytes);
    await extract(archive, { dir: destination });
    const extensionPackage = JSON.parse(await readFile(path.join(destination, "extension", "package.json"), "utf8"));
    const actualId = `${extensionPackage.publisher}.${extensionPackage.name}`;
    if (actualId.toLowerCase() !== extension.id.toLowerCase() || extensionPackage.version !== extension.version) {
      throw new Error(
        `${extension.id}: archive identity is ${actualId}@${extensionPackage.version}, expected ${extension.id}@${extension.version}.`,
      );
    }
    console.log(`${extension.id} ${extension.version}`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
await writeFile(path.join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`${manifest.extensions.length} extensions verified into ide/default-extensions`);
