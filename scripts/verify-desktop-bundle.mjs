import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  applicationExecutable,
  applicationPath,
  repositoryRoot,
  verifyBundleLayout,
} from "./release-utils.mjs";

const execFileAsync = promisify(execFile);
const candidate = process.argv[2] ? path.resolve(process.argv[2]) : applicationPath;
const verification = await verifyBundleLayout(candidate);
await execFileAsync("codesign", ["--verify", "--deep", "--strict", candidate], { maxBuffer: 2 * 1024 * 1024 });

const userData = await mkdtemp(path.join(os.tmpdir(), "phaseatlas-release-smoke-"));
try {
  const resultPath = path.join(userData, "result.json");
  const executable = candidate === applicationPath
    ? applicationExecutable
    : path.join(candidate, "Contents", "MacOS", "PhaseAtlas");
  let output = "";
  try {
    const execution = await execFileAsync(executable, [], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PHASEATLAS_RELEASE_SMOKE: "1",
        PHASEATLAS_RELEASE_SMOKE_REPOSITORY: repositoryRoot,
        PHASEATLAS_RELEASE_SMOKE_RESULT: resultPath,
        PHASEATLAS_USER_DATA_PATH: userData,
      },
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    output = `${execution.stdout}\n${execution.stderr}`;
  } catch (error) {
    const report = await readFile(resultPath, "utf8").then(JSON.parse).catch(() => null);
    throw new Error(`Packaged smoke test failed at ${report?.stage || "bootstrap"}: ${report?.error || (error instanceof Error ? error.message : String(error))}`);
  }
  const report = await readFile(resultPath, "utf8").then(JSON.parse).catch(() => null);
  if (!report?.ok) throw new Error(`Packaged smoke test stopped at ${report?.stage || "bootstrap"}.\n${output.slice(-4_000)}`);
  process.stdout.write(`${JSON.stringify({ ...verification, smoke: "passed", runtime: report }, null, 2)}\n`);
} finally {
  await rm(userData, { recursive: true, force: true });
}
