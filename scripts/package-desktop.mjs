import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
const unsignedRelease = channel === "release" && process.env.PHASEATLAS_RELEASE_UNSIGNED === "1";
if (process.env.PHASEATLAS_RELEASE_UNSIGNED && process.env.PHASEATLAS_RELEASE_UNSIGNED !== "1") {
  throw new Error("PHASEATLAS_RELEASE_UNSIGNED must be omitted or set to 1.");
}
const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const applicationVersion = rootPackage.version;
const buildNumber = process.env.PHASEATLAS_BUILD_NUMBER || "1";
if (typeof applicationVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(applicationVersion)) {
  throw new Error("The root package manifest must declare a valid semantic application version.");
}
if (!/^\d+$/.test(buildNumber)) throw new Error("PHASEATLAS_BUILD_NUMBER must contain decimal digits only.");

const releaseInputs = channel === "release" && !unsignedRelease ? {
  signingIdentity: process.env.PHASEATLAS_SIGN_IDENTITY,
  notarizationProfile: process.env.PHASEATLAS_NOTARIZATION_PROFILE,
  notarizationKeychain: process.env.PHASEATLAS_NOTARIZATION_KEYCHAIN,
  updateFeedUrl: process.env.PHASEATLAS_UPDATE_FEED_URL,
  updatePublicKey: process.env.PHASEATLAS_UPDATE_PUBLIC_KEY_FILE,
  updateManifest: process.env.PHASEATLAS_UPDATE_MANIFEST_FILE,
  updateSignature: process.env.PHASEATLAS_UPDATE_SIGNATURE_FILE,
} : null;
if (releaseInputs) {
  const missing = Object.entries(releaseInputs)
    .filter(([key, value]) => key !== "notarizationKeychain" && !value)
    .map(([key]) => key);
  if (missing.length) throw new Error(`Release packaging requires explicit signing, notarization, and signed update inputs: ${missing.join(", ")}.`);
  if (!String(releaseInputs.updateFeedUrl).startsWith("https://")) throw new Error("Release update feed must use HTTPS.");
  await execFileAsync("openssl", ["dgst", "-sha256", "-verify", releaseInputs.updatePublicKey, "-signature", releaseInputs.updateSignature, releaseInputs.updateManifest]);
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
await cp(electronApplication, applicationPath, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
await rename(
  path.join(applicationPath, "Contents", "MacOS", "Electron"),
  path.join(applicationPath, "Contents", "MacOS", "PhaseAtlas"),
);

const plist = path.join(applicationPath, "Contents", "Info.plist");
const plistSetAt = (target, key, type, value) => execFileAsync("plutil", ["-replace", key, `-${type}`, value, target]);
const plistSet = (key, type, value) => plistSetAt(plist, key, type, value);
await plistSet("CFBundleDisplayName", "string", "PhaseAtlas");
await plistSet("CFBundleExecutable", "string", "PhaseAtlas");
await plistSet("CFBundleIdentifier", "string", "vn.ketviet.phaseatlas");
await plistSet("CFBundleName", "string", "PhaseAtlas");
await plistSet("CFBundleShortVersionString", "string", applicationVersion);
await plistSet("CFBundleVersion", "string", buildNumber);
for (const key of [
  "ElectronAsarIntegrity",
  "NSAppTransportSecurity",
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
]) await execFileAsync("plutil", ["-remove", key, plist]).catch(() => undefined);

const frameworksPath = path.join(applicationPath, "Contents", "Frameworks");
for (const suffix of ["", " (GPU)", " (Plugin)", " (Renderer)"]) {
  const electronName = `Electron Helper${suffix}`;
  const phaseAtlasName = `PhaseAtlas Helper${suffix}`;
  const electronHelper = path.join(frameworksPath, `${electronName}.app`);
  const phaseAtlasHelper = path.join(frameworksPath, `${phaseAtlasName}.app`);
  const helperPlist = path.join(electronHelper, "Contents", "Info.plist");
  await rename(
    path.join(electronHelper, "Contents", "MacOS", electronName),
    path.join(electronHelper, "Contents", "MacOS", phaseAtlasName),
  );
  await plistSetAt(helperPlist, "CFBundleIdentifier", "string", `vn.ketviet.phaseatlas.helper${suffix.replaceAll(/[^A-Za-z]/g, "")}`);
  await plistSetAt(helperPlist, "CFBundleName", "string", phaseAtlasName);
  await rename(electronHelper, phaseAtlasHelper);
}

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
const packagedNodePty = path.join(resourcesPath, "node_modules", "node-pty");
const nodePtyPrebuild = `${process.platform}-${process.arch}`;
await mkdir(path.join(packagedNodePty, "prebuilds"), { recursive: true });
await cp(path.join(repositoryRoot, "apps", "desktop", "dist", "main.js"), path.join(resourcesPath, "app", "desktop", "main.js"));
await cp(path.join(repositoryRoot, "apps", "desktop", "dist", "preload.cjs"), path.join(resourcesPath, "app", "desktop", "preload.cjs"));
await cp(path.join(repositoryRoot, "apps", "desktop", "dist", "theia-preload.cjs"), path.join(resourcesPath, "app", "desktop", "theia-preload.cjs"));
// The IDE build is a required input, not an optional extra: main.ts resolves it
// unconditionally and the IDE button fails at access() without it. It lands
// beside app/ rather than inside it, so Node keeps treating its CommonJS as
// CommonJS instead of inheriting app/package.json's type: module.
const ideBuild = path.join(repositoryRoot, "ide", "lib");
const ideExtensions = path.join(repositoryRoot, "ide", "default-extensions");
for (const [label, source] of [["ide/lib", ideBuild], ["ide/default-extensions", ideExtensions]]) {
  try {
    await access(source);
  } catch {
    throw new Error(`${label} is missing. Run "pnpm build:ide" and "pnpm fetch:ide-extensions" before packaging.`);
  }
}
await cp(ideBuild, path.join(resourcesPath, "theia-ide", "lib"), { recursive: true, verbatimSymlinks: true });
await cp(ideExtensions, path.join(resourcesPath, "theia-default-extensions"), { recursive: true });
await cp(path.join(repositoryRoot, "apps", "repository-worker", "dist", "index.js"), path.join(resourcesPath, "repository-worker", "index.js"));
await cp(path.join(repositoryRoot, "apps", "ui", "build"), path.join(resourcesPath, "ui", "build"), { recursive: true });
await cp(path.join(repositoryRoot, "LICENSE"), path.join(resourcesPath, "LICENSE"));
await cp(path.join(nodePtyPackage, "package.json"), path.join(packagedNodePty, "package.json"));
await cp(path.join(nodePtyPackage, "LICENSE"), path.join(packagedNodePty, "LICENSE"));
await cp(path.join(nodePtyPackage, "lib"), path.join(packagedNodePty, "lib"), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
await cp(path.join(nodePtyPackage, "prebuilds", nodePtyPrebuild), path.join(packagedNodePty, "prebuilds", nodePtyPrebuild), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
await writeFile(path.join(resourcesPath, "app", "package.json"), JSON.stringify({
  name: "phaseatlas-desktop",
  version: applicationVersion,
  private: true,
  license: "MIT",
  type: "module",
  main: "desktop/main.js",
}, null, 2));

const policy = {
  schemaVersion: "phaseatlas.release/v1",
  applicationVersion,
  buildNumber,
  channel,
  signingMode: releaseInputs ? "developer-id" : "ad-hoc",
  updateMode: releaseInputs ? "manual" : "disabled",
  signedMetadata: Boolean(releaseInputs),
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
  const updateRoot = path.join(resourcesPath, "update");
  await mkdir(updateRoot);
  await cp(releaseInputs.updatePublicKey, path.join(updateRoot, "public-key.pem"));
  await cp(releaseInputs.updateManifest, path.join(updateRoot, "manifest.json"));
  await cp(releaseInputs.updateSignature, path.join(updateRoot, "manifest.sig"));
}
await writeFile(path.join(resourcesPath, "release-policy.json"), JSON.stringify(policy, null, 2));

const manifestRoots = [
  "app",
  "repository-worker",
  "ui",
  "theia-ide",
  "theia-default-extensions",
  "node_modules/node-pty",
  "LICENSE",
  "release-policy.json",
  ...(releaseInputs ? ["update"] : []),
];
const manifestFiles = {};
for (const root of manifestRoots) {
  const absolute = path.join(resourcesPath, root);
  const relativeFiles = (await stat(absolute)).isDirectory()
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

const signArguments = releaseInputs
  ? ["--force", "--deep", "--options", "runtime", "--timestamp", "--sign", releaseInputs.signingIdentity, applicationPath]
  : ["--force", "--deep", "--sign", "-", applicationPath];
await execFileAsync("codesign", signArguments, { maxBuffer: 4 * 1024 * 1024 });
await execFileAsync("codesign", ["--verify", "--deep", "--strict", applicationPath]);

let archivePath = path.join(artifactRoot, `PhaseAtlas-${applicationVersion}-darwin-${process.arch}.zip`);
await execFileAsync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", applicationPath, archivePath]);
if (releaseInputs) {
  const notarizationArguments = [
    "notarytool",
    "submit",
    archivePath,
    "--keychain-profile",
    releaseInputs.notarizationProfile,
    ...(releaseInputs.notarizationKeychain ? ["--keychain", releaseInputs.notarizationKeychain] : []),
    "--wait",
  ];
  await execFileAsync("xcrun", notarizationArguments, { maxBuffer: 8 * 1024 * 1024 });
  await execFileAsync("xcrun", ["stapler", "staple", applicationPath]);
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", applicationPath]);
  await rm(archivePath);
  await execFileAsync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", applicationPath, archivePath]);
}

process.stdout.write(`${JSON.stringify({
  applicationPath,
  archivePath,
  channel,
  signingMode: releaseInputs ? "developer-id" : "ad-hoc",
  files: Object.keys(manifestFiles).length,
}, null, 2)}\n`);
