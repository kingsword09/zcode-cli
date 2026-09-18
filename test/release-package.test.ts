import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { validatePackageTree } from "../scripts/check-package.ts";
import { runtimePatchPlan } from "../scripts/sync-runtime.ts";
import {
  type PackFile,
  type PackResult,
  parsePackResult,
  validatePackResult
} from "../scripts/pack-release.ts";

const requiredPaths = [
  "LICENSE",
  "README.md",
  "bin/zcode.js",
  "setting.example.json",
  "provider.example.json",
  "docs/CONFIGURATION.md",
  "docs/CONFIGURATION.zh-CN.md",
  "docs/PROVIDER_CONFIG.md",
  "docs/PROVIDER_CONFIG.zh-CN.md",
  "package.json",
  "vendor/extraction.json",
  "vendor/node_modules/@zcode/tui/dist/index.js",
  "vendor/node_modules/@zcode/tui/package.json",
  "vendor/zcode.cjs",
  "vendor/cli-config.cjs",
  "vendor/provider/zcode-builtin.json",
  "zcode-runtime.lock.json"
];

function packFile(path: string): PackFile {
  return { path, mode: path === "bin/zcode.js" ? 0o755 : 0o644, size: 1 };
}

function result(files = requiredPaths.map(packFile)): PackResult {
  return {
    name: "zcode-app-cli",
    version: "3.3.5-1",
    filename: "zcode-app-cli-3.3.5-1.tgz",
    size: 10,
    unpackedSize: 20,
    integrity: "sha512-test",
    shasum: "test",
    files
  };
}

describe("release package", () => {
  test("parses npm 11 and npm 12 JSON after named tsdown build logs", () => {
    const expected = result();
    const output = `$ tsdown\nℹ [launcher] Build complete\nℹ [tui] Build complete\n${JSON.stringify([expected])}`;

    expect(parsePackResult(output)).toEqual(expected);
    expect(parsePackResult(`$ tsdown\n${JSON.stringify({ [expected.name]: expected })}`)).toEqual(expected);
    expect(() => parsePackResult("ℹ [launcher] Build complete")).toThrow(/JSON package result/);
    expect(() => parsePackResult(JSON.stringify({ first: expected, second: expected }))).toThrow(
      /JSON package result/
    );
  });

  test("defines one locked build, pack, and offline prepack path", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();

    expect(packageJson.scripts["release:prepare"]).toContain("--latest");
    expect(packageJson.scripts["release:build"]).toBe("bun scripts/build-release.ts");
    expect(packageJson.scripts["release:pack"]).toBe("bun scripts/pack-release.ts");
    expect(packageJson.scripts.prepack).toBe("bun scripts/check-package.ts --prepack");
    expect(packageJson.scripts.build).toBe("tsdown");
    expect(packageJson.scripts["build:launcher"]).toContain("--filter launcher");
    expect(packageJson.scripts["build:tui"]).toContain("--filter tui");
    expect(packageJson.scripts.test).toBe("bun run test:unit");
    expect(packageJson.scripts["test:unit"]).toBe("bun test test/*.test.ts");
    expect(packageJson.scripts["test:tui:component"]).toContain("scenario-runtime.test.ts");
    expect(packageJson.scripts["test:tui:e2e"]).toContain("write-and-diff.test.ts");
    expect(packageJson.scripts["test:tui:host"]).toBe("bun test test/tui/scenario-mountx.test.ts");
    expect(packageJson.scripts["test:all"]).toContain("test:unit");
    expect(packageJson.scripts["test:all"]).toContain("test:tui");
    expect(packageJson.scripts["test:all"]).toContain("test:runtime");
    expect(packageJson.bin.zcode).toBe("bin/zcode.js");
    expect(packageJson.engines).toEqual({ node: ">=22.19.0" });
    expect(packageJson.dependencies.zigpty).toBeUndefined();
    expect(packageJson.dependencies.bun).toBeUndefined();
    expect(packageJson.dependencies["playwright-core"]).toBe("1.59.1");
    expect(packageJson.homepage).toBe("https://github.com/kingsword09/zcode-cli#readme");
    expect(packageJson.bugs.url).toBe("https://github.com/kingsword09/zcode-cli/issues");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/kingsword09/zcode-cli.git"
    });
    expect(packageJson.keywords).toEqual(expect.arrayContaining(["cli", "node", "terminal", "tui", "zcode"]));
  });

  test("syncs the runtime before running runtime-backed integration tests", async () => {
    const source = await Bun.file(new URL("../scripts/build-release.ts", import.meta.url)).text();
    const syncStep = source.indexOf('await run(["run", latest ? "sync" : "sync:locked"]);');
    const testStep = source.indexOf('await run(["run", "test:all"]);');

    expect(syncStep).toBeGreaterThan(-1);
    expect(testStep).toBeGreaterThan(syncStep);
    expect(source).toContain('phase: "release_validation"');
    expect(source).toContain("latestRuntimeSynced = latest");
    expect(source).toContain("if (latestRuntimeSynced && !existsSync(reportPath))");
    expect(source).toContain("writeRuntimeCompatibilityFailure(report)");
  });

  test("accepts reviewed paths and rejects omissions or development files", () => {
    const packageJson = { name: "zcode-app-cli", version: "3.3.5-1" };

    expect(() => validatePackResult(result(), packageJson)).not.toThrow();
    expect(() => validatePackResult(result(requiredPaths.slice(1).map(packFile)), packageJson)).toThrow(/missing/);
    expect(() => validatePackResult(result([...requiredPaths.map(packFile), packFile("scripts/private.ts")]), packageJson))
      .toThrow(/unreviewed/);
    expect(() => validatePackResult(
      result(requiredPaths.map((path) => ({ ...packFile(path), mode: 0o644 }))),
      packageJson
    )).toThrow(/not executable/);
  });

  test("rejects a compiled TUI that was not injected into vendor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-package-check-"));
    const lock = {
      schemaVersion: 1,
      appVersion: "3.3.5",
      platform: "linux",
      arch: "x64",
      url: "https://example.com/zcode.deb",
      sha512: Buffer.alloc(64, 3).toString("base64")
    };
    const packageJson = {
      name: "zcode-app-cli",
      version: "3.3.5-1",
      description: "Unofficial terminal client",
      keywords: ["cli", "node", "terminal", "tui", "zcode"],
      homepage: "https://github.com/kingsword09/zcode-cli#readme",
      bugs: { url: "https://github.com/kingsword09/zcode-cli/issues" },
      license: "MIT",
      author: "Kingsword kingsword09 <kingsword09@gmail.com>",
      repository: {
        type: "git",
        url: "git+https://github.com/kingsword09/zcode-cli.git"
      },
      bin: { zcode: "bin/zcode.js" },
      files: ["bin/zcode.js", "vendor", "setting.example.json", "provider.example.json", "docs/CONFIGURATION.md", "docs/CONFIGURATION.zh-CN.md", "docs/PROVIDER_CONFIG.md", "docs/PROVIDER_CONFIG.zh-CN.md", "zcode-runtime.lock.json", "README.md", "LICENSE"],
      publishConfig: { access: "public", provenance: true },
      dependencies: {
        "@earendil-works/pi-tui": "^0.80.6",
        "playwright-core": "1.59.1"
      }
    };
    const tuiPackage = {
      name: "@zcode/tui",
      version: "0.1.0",
      dependencies: { "@earendil-works/pi-tui": "^0.80.6" }
    };
    const files: Record<string, string> = {
      "docs/CONFIGURATION.md": "# Fixture documentation\n",
      "docs/CONFIGURATION.zh-CN.md": "# Fixture documentation\n",
      "docs/PROVIDER_CONFIG.md": "# Fixture documentation\n",
      "docs/PROVIDER_CONFIG.zh-CN.md": "# Fixture documentation\n",
      "LICENSE": "license",
      "README.md": "readme",
      "bin/zcode.js": "#!/usr/bin/env node\nimport { spawn } from \"node:child_process\";\n",
      "bin/zcode.ts": "export {};\n",
      "setting.example.json": "{}\n",
      "provider.example.json": "{}\n",
      "package.json": `${JSON.stringify(packageJson)}\n`,
      "src/app-server-client.ts": "export {};\n",
      "src/command.ts": "export {};\n",
      "src/darwin-oauth-callback.ts": "export {};\n",
      "src/launcher.ts": "export {};\n",
      "src/model-access.ts": "export {};\n",
      "src/plugin-cli.ts": "export {};\n",
      "src/plugin-protocol.ts": "export {};\n",
      "src/zai-oauth.ts": "export {};\n",
      "tsdown.config.ts": "export default [];\n",
      "packages/zcode-tui/dist/index.js": "export const value = 1;\n",
      "packages/zcode-tui/package.json": `${JSON.stringify(tuiPackage)}\n`,
      "vendor/extraction.json": `${JSON.stringify({
        appVersion: lock.appVersion,
        cliVersion: "0.15.2",
        source: lock.url,
        sha512: lock.sha512,
        runtimeCapabilities: {
          schemaVersion: 1,
          cli: { globalOptions: { help: { type: "boolean" } } }
        },
        runtimePatches: runtimePatchPlan.map((patch) => ({
          id: patch.id,
          requirement: patch.requirement,
          status: "already_present"
        }))
      })}\n`,
      "vendor/node_modules/@zcode/tui/dist/index.js": "export const value = 1;\n",
      "vendor/node_modules/@zcode/tui/package.json": `${JSON.stringify(tuiPackage)}\n`,
      "vendor/cli-config.cjs": "module.exports={};\n",
      "vendor/provider/zcode-builtin.json": "{}\n",
      "vendor/zcode.cjs": "console.log('runtime');\n",
      "zcode-runtime.lock.json": `${JSON.stringify(lock)}\n`
    };

    try {
      for (const [path, content] of Object.entries(files)) {
        const destination = join(directory, path);
        await mkdir(join(destination, ".."), { recursive: true });
        await writeFile(destination, content);
      }
      await chmod(join(directory, "bin", "zcode.js"), 0o755);
      await expect(validatePackageTree(directory)).resolves.toBeUndefined();
      await writeFile(join(directory, "vendor", "node_modules", "@zcode", "tui", "dist", "index.js"), "stale\n");
      await expect(validatePackageTree(directory)).rejects.toThrow(/stale/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
