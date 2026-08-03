import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const runtimeSources = [
  "packages/contracts/src",
  "packages/contracts/schemas",
  "packages/core/src",
  "apps/repository-worker/src",
  "apps/desktop/src",
].map((candidate) => path.join(root, candidate));

let rendererProcess;
let electronProcess;
let buildRunning = false;
let rebuildPending = false;
let rebuildTimer;
let shuttingDown = false;

function run(command, args, options = {}) {
  return spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Process exited with code ${code}.`)));
    child.once("error", reject);
  });
}

async function rendererPortIsOccupied() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 4177 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function buildRuntime() {
  console.info("[runtime] Building contracts, core, worker, and Electron…");
  await waitForExit(run(packageManager, ["build:runtime"]));
}

async function waitForRenderer() {
  while (!shuttingDown) {
    const ready = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: 4177 });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function electronExecutable() {
  const relativePath = (await readFile(
    path.join(root, "apps/desktop/node_modules/electron/path.txt"),
    "utf8",
  )).trim();
  return path.join(root, "apps/desktop/node_modules/electron/dist", relativePath);
}

async function startElectron() {
  electronProcess = run(await electronExecutable(), [path.join(root, "apps/desktop/dist/main.js")], {
    env: { ...process.env, PHASEATLAS_UI_DEV_URL: "http://127.0.0.1:4177" },
  });
  electronProcess.once("exit", () => { electronProcess = undefined; });
}

async function restartRuntime() {
  if (buildRunning) {
    rebuildPending = true;
    return;
  }
  buildRunning = true;
  try {
    await buildRuntime();
    if (electronProcess) {
      electronProcess.kill("SIGTERM");
      await new Promise((resolve) => electronProcess?.once("exit", resolve));
    }
    if (!shuttingDown) await startElectron();
  } catch (error) {
    console.error(`[runtime] ${error instanceof Error ? error.message : error}`);
  } finally {
    buildRunning = false;
    if (rebuildPending && !shuttingDown) {
      rebuildPending = false;
      void restartRuntime();
    }
  }
}

function scheduleRuntimeRestart() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => void restartRuntime(), 120);
}

if (await rendererPortIsOccupied()) {
  throw new Error("PhaseAtlas dev is already running on 127.0.0.1:4177. Stop the existing session before starting another one.");
}

await buildRuntime();
rendererProcess = run(packageManager, ["--filter", "@phaseatlas/ui", "dev"]);
await waitForRenderer();
await startElectron();

const watchers = runtimeSources.map((source) => watch(source, { recursive: true }, scheduleRuntimeRestart));

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(rebuildTimer);
  watchers.forEach((watcher) => watcher.close());
  electronProcess?.kill("SIGTERM");
  rendererProcess?.kill("SIGTERM");
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
rendererProcess.once("exit", () => {
  if (!shuttingDown) shutdown();
});
