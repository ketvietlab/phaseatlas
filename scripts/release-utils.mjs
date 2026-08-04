import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const repositoryRoot = path.resolve(import.meta.dirname, "..");
export const artifactRoot = path.join(repositoryRoot, "artifacts", "desktop", `darwin-${process.arch}`);
export const applicationPath = path.join(artifactRoot, "PhaseAtlas.app");
export const resourcesPath = path.join(applicationPath, "Contents", "Resources");
export const applicationExecutable = path.join(applicationPath, "Contents", "MacOS", "PhaseAtlas");

export async function exists(candidate) {
  try { await access(candidate); return true; } catch { return false; }
}

export async function sha256(candidate) {
  return createHash("sha256").update(await readFile(candidate)).digest("hex");
}

export async function filesBelow(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(absolute, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}

export async function verifyBundleLayout(candidate = applicationPath) {
  const resources = path.join(candidate, "Contents", "Resources");
  const required = [
    "app/package.json",
    "app/desktop/main.js",
    "app/desktop/preload.cjs",
    "repository-worker/index.js",
    "ui/build/index.html",
    "node_modules/node-pty/package.json",
    "release-policy.json",
    "bundle-manifest.json",
  ];
  for (const relative of required) {
    if (!await exists(path.join(resources, relative))) throw new Error(`Packaged desktop bundle is missing ${relative}.`);
  }
  const [policy, manifest, main, preload, worker] = await Promise.all([
    readFile(path.join(resources, "release-policy.json"), "utf8").then(JSON.parse),
    readFile(path.join(resources, "bundle-manifest.json"), "utf8").then(JSON.parse),
    readFile(path.join(resources, "app", "desktop", "main.js"), "utf8"),
    readFile(path.join(resources, "app", "desktop", "preload.cjs"), "utf8"),
    readFile(path.join(resources, "repository-worker", "index.js"), "utf8"),
  ]);
  if (policy.schemaVersion !== "phaseatlas.release/v1") throw new Error("Packaged release policy has an invalid schema version.");
  if (policy.channel === "development" && (policy.updateMode !== "disabled" || policy.signedMetadata !== false)) {
    throw new Error("Development artifacts must disable updates and signed release metadata.");
  }
  if (policy.channel === "release" && (policy.updateMode !== "manual" || policy.signedMetadata !== true)) {
    throw new Error("Release artifacts must require manually initiated signed updates.");
  }
  if (!main.includes("../../ui/build/index.html") || !main.includes("repository-worker")) {
    throw new Error("Desktop main bundle does not contain the static renderer and bundled worker paths.");
  }
  for (const boundary of ["contextIsolation: true", "nodeIntegration: false", "sandbox: true"]) {
    if (!main.includes(boundary)) throw new Error(`Desktop main bundle is missing sandbox boundary ${boundary}.`);
  }
  if (!preload.includes("exposeInMainWorld")) throw new Error("Packaged preload does not expose the typed desktop bridge.");
  if (!worker.includes("PHASEATLAS_REPO_ROOT")) throw new Error("Packaged repository worker entry is invalid.");
  if (worker.includes('from "@phaseatlas/') || worker.includes('from "chokidar"')) {
    throw new Error("Packaged worker still depends on workspace JavaScript layout.");
  }
  if (manifest.schemaVersion !== "phaseatlas.bundle-manifest/v1" || typeof manifest.files !== "object") {
    throw new Error("Packaged bundle manifest is invalid.");
  }
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const filePath = path.resolve(resources, relative);
    const containment = path.relative(resources, filePath);
    if (!containment || containment.startsWith("..") || path.isAbsolute(containment)) throw new Error("Bundle manifest contains an unsafe path.");
    if (await sha256(filePath) !== digest) throw new Error(`Bundle manifest digest mismatch for ${relative}.`);
  }
  const privateFilePattern = /(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|.*\.(?:pem|p12|pfx|key))$/i;
  const customRoots = ["app", "repository-worker", "ui"];
  for (const customRoot of customRoots) {
    for (const relative of await filesBelow(path.join(resources, customRoot))) {
      if (privateFilePattern.test(relative)) throw new Error(`Credential-like file was embedded in the artifact: ${customRoot}/${relative}.`);
    }
  }
  const executable = path.join(candidate, "Contents", "MacOS", "PhaseAtlas");
  if (!(await stat(executable)).isFile()) throw new Error("Packaged application executable is missing.");
  return { applicationPath: candidate, policy, fileCount: Object.keys(manifest.files).length };
}
