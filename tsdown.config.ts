import { defineConfig } from "tsdown";

export default defineConfig([
  {
    name: "launcher",
    entry: { zcode: "bin/zcode.ts" },
    outDir: "bin",
    outExtensions: () => ({ js: ".js" }),
    format: "esm",
    platform: "node",
    target: "node22.19",
    clean: false,
    dts: false,
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
    deps: {
      neverBundle: ["zigpty"],
      onlyBundle: false
    }
  },
  {
    name: "tui",
    entry: { index: "packages/zcode-tui/src/index.ts" },
    outDir: "packages/zcode-tui/dist",
    outExtensions: () => ({ js: ".js" }),
    format: "esm",
    platform: "node",
    target: "node22.19",
    clean: true,
    dts: false,
    sourcemap: false,
    deps: {
      neverBundle: ["@earendil-works/pi-tui"],
      onlyBundle: false
    }
  }
]);
