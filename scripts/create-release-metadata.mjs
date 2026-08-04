import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const packageManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required.`);
  return value;
}

function optionalArgument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

const tag = requiredArgument("--tag");
const repository = requiredArgument("--repository");
const output = path.resolve(requiredArgument("--output"));
const assetsDirectory = optionalArgument("--assets-dir");
const version = packageManifest.version;

if (tag !== `v${version}`) throw new Error(`Release tag ${tag} does not match package version v${version}.`);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Repository must use owner/name format.");

const artifacts = await Promise.all(["arm64", "x64"].map(async (architecture) => {
  const file = `PhaseAtlas-${version}-darwin-${architecture}.zip`;
  const descriptor = {
    platform: "darwin",
    architecture,
    file,
    url: `https://github.com/${repository}/releases/download/${tag}/${file}`,
  };
  if (!assetsDirectory) return descriptor;

  const assetPath = path.resolve(assetsDirectory, file);
  const containment = path.relative(path.resolve(assetsDirectory), assetPath);
  if (!containment || containment.startsWith("..") || path.isAbsolute(containment)) {
    throw new Error(`Unsafe release asset path ${file}.`);
  }
  const [content, metadata] = await Promise.all([readFile(assetPath), stat(assetPath)]);
  return {
    ...descriptor,
    size: metadata.size,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}));

await writeFile(output, `${JSON.stringify({
  schemaVersion: "phaseatlas.update/v1",
  channel: "stable",
  version,
  tag,
  artifacts,
}, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({ version, tag, output, artifacts: artifacts.length }, null, 2)}\n`);
