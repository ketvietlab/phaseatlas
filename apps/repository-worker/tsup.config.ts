import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  external: ["node:sqlite"],
  noExternal: [/.+/],
  clean: true,
  esbuildOptions(options) {
    options.supported = { ...options.supported, "node-colon-prefix-import": true };
    options.banner = {
      js: 'import { createRequire as __phaseatlasCreateRequire } from "node:module"; const require = __phaseatlasCreateRequire(import.meta.url);',
    };
  },
});
