import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { main: "src/main.ts" },
    format: ["esm"],
    platform: "node",
    target: "node24",
    external: ["electron", "node:sqlite"],
    esbuildOptions(options) {
      options.supported = { ...options.supported, "node-colon-prefix-import": true };
    },
    clean: true,
  },
  {
    entry: { preload: "src/preload.ts" },
    format: ["cjs"],
    platform: "node",
    target: "node24",
    external: ["electron"],
    clean: false,
    outExtension: () => ({ js: ".cjs" }),
  },
]);
