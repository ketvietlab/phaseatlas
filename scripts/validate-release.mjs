import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const packageManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const changelog = await readFile(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const version = packageManifest.version;
const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
if (typeof version !== "string" || !semanticVersion.test(version)) {
  throw new Error("The root package.json version must be a valid Semantic Versioning 2.0.0 value.");
}

if (!/^## \[Unreleased\]\s*$/m.test(changelog)) {
  throw new Error("CHANGELOG.md must contain an Unreleased section.");
}

const versionHeading = new RegExp(`^## \\[${escapeRegularExpression(version)}\\] - (\\d{4}-\\d{2}-\\d{2})\\s*$`, "m");
const headingMatch = changelog.match(versionHeading);
if (!headingMatch) {
  throw new Error(`CHANGELOG.md must contain \"## [${version}] - YYYY-MM-DD\".`);
}

const releaseDate = headingMatch[1];
const parsedDate = new Date(`${releaseDate}T00:00:00.000Z`);
if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== releaseDate) {
  throw new Error(`CHANGELOG.md contains an invalid release date for ${version}.`);
}

const sectionStart = headingMatch.index + headingMatch[0].length;
const remainder = changelog.slice(sectionStart);
const nextVersionHeading = remainder.search(/^## \[/m);
const releaseNotes = (nextVersionHeading === -1 ? remainder : remainder.slice(0, nextVersionHeading)).trim();
if (!/^### (Added|Changed|Deprecated|Removed|Fixed|Security)\s*$/m.test(releaseNotes) || !/^- .+/m.test(releaseNotes)) {
  throw new Error(`CHANGELOG.md must contain at least one categorized entry for ${version}.`);
}

const tag = argument("--tag") ?? process.env.GITHUB_REF_NAME;
if (tag && tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} does not match package version v${version}.`);
}

const notesOutput = argument("--notes-output");
if (notesOutput) {
  await writeFile(path.resolve(notesOutput), `${releaseNotes}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify({ version, tag: tag ?? null, releaseDate, changelog: "valid" }, null, 2)}\n`);
