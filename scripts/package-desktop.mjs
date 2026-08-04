import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  applicationPath,
  artifactRoot,
  filesBelow,
  repositoryRoot,
  resourcesPath,
  sha256,
} from "./release-utils.mjs";

const execFileAsync = promisify(execFile);
if (process.platform !== "darwin") throw new Error("PhaseAtlas desktop packaging currently supports macOS hosts only.");
const channel = process.env.PHASEATLAS_RELEASE_CHANNEL || "development";
if (!["development", "release"].includes(channel)) throw new Error("PHASEATLAS_RELEASE_CHANNEL must be development or release.");

const releaseInputs = channel === "release" ? {
  signingIdentity: process.env.PHASEATLAS_SIGN_IDENTITY,
  notarizationProfile: process.env.PHASEATLAS_NOTARIZATION_PROFILE,
  updateFeedUrl: process.env.PHASEATLAS_UPDATE_FEED_URL,
  updatePublicKey: process.env.PHASEATLAS_UPDATE_PUBLIC_KEY_FILE,
  updateManifest: process.env.PHASEATLAS_UPDATE_MANIFEST_FILE,
  updateSignature: process.env.PHASEATLAS_UPDATE_SIGNATURE_FILE,
} : null;
if (releaseInputs) {
  const missing = Object.entries(releaseInputs).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Release packaging requires explicit signing, notarization, and signed update inputs: ${missing.join(", ")}.`);
  if (!String(releaseInputs.updateFeedUrl).startsWith("https://")) throw new Error("Release update feed must use HTTPS.");
}

for (const required of [
  "apps/desktop/dist/main.js",
  "apps/desktop/dist/preload.cjs",
  "apps/repository-worker/dist/index.js",
  "apps/ui/build/index.html",
]) {
  await readFile(path.join(repositoryRoot, required));
}

const desktopRequire = createRequire(path.join(repositoryRoot, "apps", "desktop", "package.json"));
const workerRequire = createRequire(path.join(repositoryRoot, "apps", "repository-worker", "package.json"));
const electronExecutable = desktopRequire("electron");
const electronApplication = path.resolve(path.dirname(electronExecutable), "../..");
const nodePtyPackage = path.dirname(workerRequire.resolve("node-pty/package.json"));
if (!electronApplication.endsWith("Electron.app")) throw new Error("Installed Electron runtime has an unexpected macOS layout.");

await rm(artifactRoot, { recursive: true, force: true });
await mkdir(artifactRoot, { recursive: true });
await cp(electronApplication, applicationPath, { recursive: true, preserveTimestamps: true });
await rename(
  path.join(applicationPath, "Contents", "MacOS", "Electron"),
  path.join(applicationPath, "Contents", "MacOS", "PhaseAtlas"),
);

const plist = path.join(applicationPath, "Contents", "Info.plist");
const plistSet = (key, type, value) => execFileAsync("plutil", ["-replace", key, `-${type}`, value, plist]);
await plistSet("CFBundleDisplayName", "string", "PhaseAtlas");
await plistSet("CFBundleExecutable", "string", "PhaseAtlas");
await plistSet("CFBundleIdentifier", "string", "vn.ketviet.phaseatlas");
await plistSet("CFBundleName", "string", "PhaseAtlas");
await plistSet("CFBundleShortVersionString", "string", "0.1.0");
await plistSet("CFBundleVersion", "string", "1");
for (const key of [
  "ElectronAsarIntegrity",
  "NSAppTransportSecurity",
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
]) await execFileAsync("plutil", ["-remove", key, plist]).catch(() => undefined);

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-package-"));
try {
  const iconset = path.join(temporaryRoot, "PhaseAtlas.iconset");
  await mkdir(iconset);
  const iconSource = path.join(repositoryRoot, "apps", "ui", "static", "assets", "phaseatlas-logo-mark.png");
  for (const size of [16, 32, 128, 256, 512]) {
    await execFileAsync("sips", ["-z", String(size), String(size), iconSource, "--out", path.join(iconset, `icon_${size}x${size}.png`)]);
    await execFileAsync("sips", ["-z", String(size * 2), String(size * 2), iconSource, "--out", path.join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  const iconPath = path.join(applicationPath, "Contents", "Resources", "PhaseAtlas.icns");
  await execFileAsync("iconutil", ["-c", "icns", iconset, "-o", iconPath]);
  await plistSet("CFBundleIconFile", "string", "PhaseAtlas.icns");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

await rm(path.join(resourcesPath, "default_app.asar"), { force: true });
await mkdir(path.join(resourcesPath, "app", "desktop"), { recursive: true });
await mkdir(path.join(resourcesPath, "repository-worker"), { recursive: true });
await mkdir(path.join(resourcesPath, "ui"), { recursive: true });
await mkdir(path.join(resourcesPath, "node_modules"), { recursive: true });
await cp(path.join(repositoryRoot, "apps", "desktop", "dist", "main.js"), path.join(resourcesPath, "app", "desktop", "main.js"));
await cp(path.join(repositoryRoot, "apps", "desktop", "dist", "preload.cjs"), path.join(resourcesPath, "app", "desktop", "preload.cjs"));
await cp(path.join(repositoryRoot, "apps", "repository-worker", "dist", "index.js"), path.join(resourcesPath, "repository-worker", "index.js"));
await cp(path.join(repositoryRoot, "apps", "ui", "build"), path.join(resourcesPath, "ui", "build"), { recursive: true });
await cp(nodePtyPackage, path.join(resourcesPath, "node_modules", "node-pty"), { recursive: true, preserveTimestamps: true });
await writeFile(path.join(resourcesPath, "app", "package.json"), JSON.stringify({
  name: "phaseatlas-desktop",
  version: "0.1.0",
  private: true,
  type: "module",
  main: "desktop/main.js",
}, null, 2));

const policy = {
  schemaVersion: "phaseatlas.release/v1",
  channel,
  updateMode: channel === "release" ? "manual" : "disabled",
  signedMetadata: channel === "release",
  ...(releaseInputs ? {
    update: {
      feedUrl: releaseInputs.updateFeedUrl,
      publicKey: "update/public-key.pem",
      manifest: "update/manifest.json",
      signature: "update/manifest.sig",
    },
  } : {}),
};
if (releaseInputs) {
  await execFileAsync("openssl", ["dgst", "-sha256", "-verify", releaseInputs.updatePublicKey, "-signature", releaseInputs.updateSignature, releaseInputs.updateManifest]);
  const updateRoot = path.join(resourcesPath, "update");
  await mkdir(updateRoot);
  await cp(releaseInputs.updatePublicKey, path.join(updateRoot, "public-key.pem"));
  await cp(releaseInputs.updateManifest, path.join(updateRoot, "manifest.json"));
  await cp(releaseInputs.updateSignature, path.join(updateRoot, "manifest.sig"));
}
await writeFile(path.join(resourcesPath, "release-policy.json"), JSON.stringify(policy, null, 2));

const manifestRoots = ["app", "repository-worker", "ui", "node_modules/node-pty", "release-policy.json", ...(releaseInputs ? ["update"] : [])];
const manifestFiles = {};
for (const root of manifestRoots) {
  const absolute = path.join(resourcesPath, root);
  const relativeFiles = (await import("node:fs/promises")).stat(absolute).then((entry) => entry.isDirectory())
    ? await filesBelow(absolute)
    : [""];
  for (const relative of relativeFiles) {
    const manifestPath = relative ? path.posix.join(root, relative) : root;
    manifestFiles[manifestPath] = await sha256(relative ? path.join(absolute, relative) : absolute);
  }
}
await writeFile(path.join(resourcesPath, "bundle-manifest.json"), JSON.stringify({
  schemaVersion: "phaseatlas.bundle-manifest/v1",
  generatedAt: new Date().toISOString(),
  files: manifestFiles,
}, null, 2));

const signArguments = channel === "release"
  ? ["--force", "--deep", "--options", "runtime", "--timestamp", "--sign", releaseInputs.signingIdentity, applicationPath]
  : ["--force", "--deep", "--sign", "-", applicationPath];
await execFileAsync("codesign", signArguments, { maxBuffer: 4 * 1024 * 1024 });
await execFileAsync("codesign", ["--verify", "--deep", "--strict", applicationPath]);

let archivePath = path.join(artifactRoot, `PhaseAtlas-0.1.0-darwin-${process.arch}.zip`);
await execFileAsync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", applicationPath, archivePath]);
if (releaseInputs) {
  await execFileAsync("xcrun", ["notarytool", "submit", archivePath, "--keychain-profile", releaseInputs.notarizationProfile, "--wait"], { maxBuffer: 8 * 1024 * 1024 });
  await execFileAsync("xcrun", ["stapler", "staple", applicationPath]);
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", applicationPath]);
  await rm(archivePath);
  await execFileAsync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", applicationPath, archivePath]);
}

process.stdout.write(`${JSON.stringify({ applicationPath, archivePath, channel, files: Object.keys(manifestFiles).length }, null, 2)}\n`);
