import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  external: ["node:sqlite", "node-pty"],
  clean: true,
  esbuildOptions(options) {
    options.supported = { ...options.supported, "node-colon-prefix-import": true };
  },
});
