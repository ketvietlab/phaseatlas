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

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });
    child.once("error", reject);
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

// Theia's monorepo is yarn/lerna based; using anything else silently produces a
// half-linked workspace that fails deep inside the build.
await run("yarn", ["install", "--frozen-lockfile"], submodule);
await run("yarn", ["build:browser"], submodule);

await rm(output, { recursive: true, force: true });
await cp(path.join(example, "lib"), output, { recursive: true });
console.log(`Embedded IDE built into ${path.relative(repositoryRoot, output)}`);
