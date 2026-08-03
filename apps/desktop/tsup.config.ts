import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { main: "src/main.ts" },
    format: ["esm"],
    platform: "node",
    external: ["electron"],
    clean: true,
  },
  {
    entry: { preload: "src/preload.ts" },
    format: ["cjs"],
    platform: "node",
    external: ["electron"],
    clean: false,
    outExtension: () => ({ js: ".cjs" }),
  },
]);

