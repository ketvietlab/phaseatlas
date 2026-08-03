import { chmod, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

if (process.platform === "darwin") {
  const nodePtyRoot = path.resolve(import.meta.dirname, "../apps/repository-worker/node_modules/node-pty");
  const helpers = [
    path.join(nodePtyRoot, "prebuilds/darwin-arm64/spawn-helper"),
    path.join(nodePtyRoot, "prebuilds/darwin-x64/spawn-helper"),
    path.join(nodePtyRoot, "build/Release/spawn-helper"),
  ];

  let fixed = 0;
  for (const helper of helpers) {
    try {
      await stat(helper);
      await chmod(helper, 0o755);
      fixed += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  if (!fixed) throw new Error("node-pty is installed without a macOS spawn helper.");
}
