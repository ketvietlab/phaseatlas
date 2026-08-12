#!/usr/bin/env node
// Downloads the pinned default extensions into ide/default-extensions and
// rejects any file whose digest does not match the manifest.
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  for (const extension of manifest.localExtensions ?? []) {
    const source = path.resolve(repositoryRoot, "ide", extension.source);
    const localRoot = path.resolve(repositoryRoot, "ide", "extensions");
    if (!source.startsWith(`${localRoot}${path.sep}`)) {
      throw new Error(`${extension.id}: local extension source must be inside ide/extensions.`);
    }
    const destination = path.join(pluginsTarget, `${extension.id}-${extension.version}`);
    const extensionRoot = path.join(destination, "extension");
    await cp(source, extensionRoot, { recursive: true });
    const extensionPackage = JSON.parse(await readFile(path.join(extensionRoot, "package.json"), "utf8"));
    const actualId = `${extensionPackage.publisher}.${extensionPackage.name}`;
    if (actualId.toLowerCase() !== extension.id.toLowerCase() || extensionPackage.version !== extension.version) {
      throw new Error(
        `${extension.id}: local identity is ${actualId}@${extensionPackage.version}, expected ${extension.id}@${extension.version}.`,
      );
    }
    const themes = extensionPackage.contributes?.themes;
    if (!Array.isArray(themes) || themes.length === 0) {
      throw new Error(`${extension.id}: local theme extension has no contributed themes.`);
    }
    for (const theme of themes) {
      if (typeof theme.id !== "string" || typeof theme.path !== "string") {
        throw new Error(`${extension.id}: every theme must declare a stable id and path.`);
      }
      const themePath = path.resolve(extensionRoot, theme.path);
      if (!themePath.startsWith(`${extensionRoot}${path.sep}`)) {
        throw new Error(`${extension.id}: theme path must stay inside the extension.`);
      }
      const themeDocument = JSON.parse(await readFile(themePath, "utf8"));
      if (!themeDocument.colors || !Array.isArray(themeDocument.tokenColors) || !themeDocument.semanticTokenColors) {
        throw new Error(`${extension.id}: ${theme.id} must define UI, TextMate, and semantic colors.`);
      }
    }
    // Theia's local-dir resolver expects the same root metadata as an unpacked
    // VSIX for system extensions. A bare extension directory is treated as a
    // development plugin and can block frontend contribution deployment.
    await writeFile(path.join(destination, "extension.vsixmanifest"), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${extensionPackage.name}" Version="${extensionPackage.version}" Publisher="${extensionPackage.publisher}" />
    <DisplayName>${extensionPackage.displayName}</DisplayName>
    <Description>${extensionPackage.description}</Description>
    <Categories>Themes</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${extensionPackage.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>\n`, "utf8");
    await writeFile(path.join(destination, "[Content_Types].xml"), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>\n`, "utf8");
    console.log(`${extension.id} ${extension.version} (local)`);
  }
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
const extensionCount = manifest.extensions.length + (manifest.localExtensions?.length ?? 0);
console.log(`${extensionCount} extensions verified into ide/default-extensions`);
