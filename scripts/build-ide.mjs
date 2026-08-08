#!/usr/bin/env node
// Builds the embedded IDE from the pinned Theia source in ide/theia and places
// the result where apps/desktop expects it (ide/lib). Theia builds with its own
// toolchain, so this shells out rather than joining the pnpm workspace.
import { spawn } from "node:child_process";
import { access, cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const submodule = path.join(repositoryRoot, "ide", "theia");
const example = path.join(submodule, "examples", "browser");
const output = path.join(repositoryRoot, "ide", "lib");

// The repository pins Node 24; Theia needs >= 22. A shell still on an older
// default produces failures deep inside npm rather than at the entry point.
const [major] = process.versions.node.split(".").map(Number);
if (!Number.isInteger(major) || major < 22) {
  throw new Error(`The embedded IDE build needs Node 22 or newer; this is ${process.versions.node}. Run "nvm use" first.`);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });
    child.once("error", (error) => reject(
      error && error.code === "ENOENT"
        ? new Error(`${command} was not found on PATH.`)
        : error,
    ));
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`)));
  });
}

try {
  await access(path.join(submodule, "package.json"));
} catch {
  throw new Error("ide/theia is empty. Run: git submodule update --init --depth 1 ide/theia");
}

// Theia 1.74 ships package-lock.json and npm workspaces; it left yarn behind.
// npm is also invoked directly because corepack refuses to run a package manager
// other than the one this repository declares.
await run(npmCommand, ["ci"], submodule);
await run(npmCommand, ["run", "build:browser"], submodule);

await rm(output, { recursive: true, force: true });
await cp(path.join(example, "lib"), output, { recursive: true });
console.log(`Embedded IDE built into ${path.relative(repositoryRoot, output)}`);
