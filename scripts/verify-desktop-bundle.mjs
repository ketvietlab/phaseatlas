import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
  const executable = candidate === applicationPath
    ? applicationExecutable
    : path.join(candidate, "Contents", "MacOS", "PhaseAtlas");
  const { stdout, stderr } = await execFileAsync(executable, [], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PHASEATLAS_RELEASE_SMOKE: "1",
      PHASEATLAS_RELEASE_SMOKE_REPOSITORY: repositoryRoot,
      PHASEATLAS_USER_DATA_PATH: userData,
    },
    timeout: 45_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${stdout}\n${stderr}`;
  if (!output.includes("PHASEATLAS_RELEASE_SMOKE_OK")) {
    throw new Error(`Packaged smoke test did not confirm renderer and worker startup.\n${output.slice(-4_000)}`);
  }
  process.stdout.write(`${JSON.stringify({ ...verification, smoke: "passed" }, null, 2)}\n`);
} finally {
  await rm(userData, { recursive: true, force: true });
}
