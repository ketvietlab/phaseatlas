import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { main: "src/main.ts" },
    format: ["esm"],
    platform: "node",
    target: "node24",
    external: ["electron", "node:sqlite"],
    noExternal: ["@phaseatlas/contracts"],
    esbuildOptions(options) {
      options.supported = { ...options.supported, "node-colon-prefix-import": true };
    },
    clean: true,
  },
  {
    // The IDE window gets its own preload: it is a separate sandboxed surface.
    entry: { "theia-preload": "src/theia-preload.ts" },
    format: ["cjs"],
    platform: "node",
    target: "node24",
    external: ["electron"],
    clean: false,
    outExtension: () => ({ js: ".cjs" }),
  },
  {
    entry: { preload: "src/preload.ts" },
    format: ["cjs"],
    platform: "node",
    target: "node24",
    external: ["electron"],
    noExternal: ["@phaseatlas/contracts"],
    clean: false,
    outExtension: () => ({ js: ".cjs" }),
  },
]);
