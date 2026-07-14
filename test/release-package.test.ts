import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { validatePackageTree } from "../scripts/check-package.ts";
import {
  type PackFile,
  type PackResult,
  validatePackResult
} from "../scripts/pack-release.ts";

const requiredPaths = [
  "LICENSE",
  "README.md",
  "bin/zcode.ts",
  "config.example.json",
  "package.json",
  "src/darwin-oauth-callback.ts",
  "src/launcher.ts",
  "src/model-access.ts",
  "src/zai-oauth.ts",
  "vendor/extraction.json",
  "vendor/node_modules/@zcode/tui/dist/index.js",
  "vendor/node_modules/@zcode/tui/package.json",
  "vendor/zcode.cjs",
  "zcode-runtime.lock.json"
];

function packFile(path: string): PackFile {
  return { path, mode: path === "bin/zcode.ts" ? 0o755 : 0o644, size: 1 };
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
  test("defines one locked build, pack, and offline prepack path", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();

    expect(packageJson.scripts["release:prepare"]).toContain("--latest");
    expect(packageJson.scripts["release:build"]).toBe("bun scripts/build-release.ts");
    expect(packageJson.scripts["release:pack"]).toBe("bun scripts/pack-release.ts");
    expect(packageJson.scripts.prepack).toBe("bun scripts/check-package.ts --prepack");
    expect(packageJson.homepage).toBe("https://github.com/kingsword09/zcode-cli#readme");
    expect(packageJson.bugs.url).toBe("https://github.com/kingsword09/zcode-cli/issues");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/kingsword09/zcode-cli.git"
    });
    expect(packageJson.keywords).toEqual(expect.arrayContaining(["bun", "cli", "tui", "zcode"]));
  });

  test("accepts reviewed paths and rejects omissions or development files", () => {
    const packageJson = { name: "zcode-app-cli", version: "3.3.5-1" };

    expect(() => validatePackResult(result(), packageJson)).not.toThrow();
    expect(() => validatePackResult(result(requiredPaths.slice(1).map(packFile)), packageJson)).toThrow(/missing/);
    expect(() => validatePackResult(result([...requiredPaths.map(packFile), packFile("scripts/private.ts")]), packageJson))
      .toThrow(/unreviewed/);
    expect(() => validatePackResult(
      result(requiredPaths.map((path) => ({ ...packFile(path), mode: path === "bin/zcode.ts" ? 0o644 : 0o644 }))),
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
      keywords: ["bun", "cli", "tui", "zcode"],
      homepage: "https://github.com/kingsword09/zcode-cli#readme",
      bugs: { url: "https://github.com/kingsword09/zcode-cli/issues" },
      license: "MIT",
      author: "Kingsword kingsword09 <kingsword09@gmail.com>",
      repository: {
        type: "git",
        url: "git+https://github.com/kingsword09/zcode-cli.git"
      },
      bin: { zcode: "bin/zcode.ts" },
      files: ["bin", "src", "vendor", "config.example.json", "zcode-runtime.lock.json", "README.md", "LICENSE"],
      publishConfig: { access: "public", provenance: true },
      dependencies: { "@earendil-works/pi-tui": "^0.80.6" }
    };
    const tuiPackage = {
      name: "@zcode/tui",
      version: "0.1.0",
      dependencies: { "@earendil-works/pi-tui": "^0.80.6" }
    };
    const files: Record<string, string> = {
      "LICENSE": "license",
      "README.md": "readme",
      "bin/zcode.ts": "#!/usr/bin/env bun\n",
      "config.example.json": "{}\n",
      "package.json": `${JSON.stringify(packageJson)}\n`,
      "src/darwin-oauth-callback.ts": "export {};\n",
      "src/launcher.ts": "export {};\n",
      "src/model-access.ts": "export {};\n",
      "src/zai-oauth.ts": "export {};\n",
      "packages/zcode-tui/dist/index.js": "export const value = 1;\n",
      "packages/zcode-tui/package.json": `${JSON.stringify(tuiPackage)}\n`,
      "vendor/extraction.json": `${JSON.stringify({
        appVersion: lock.appVersion,
        cliVersion: "0.15.2",
        source: lock.url,
        sha512: lock.sha512
      })}\n`,
      "vendor/node_modules/@zcode/tui/dist/index.js": "export const value = 1;\n",
      "vendor/node_modules/@zcode/tui/package.json": `${JSON.stringify(tuiPackage)}\n`,
      "vendor/zcode.cjs": "console.log('runtime');\n",
      "zcode-runtime.lock.json": `${JSON.stringify(lock)}\n`
    };

    try {
      for (const [path, content] of Object.entries(files)) {
        const destination = join(directory, path);
        await mkdir(join(destination, ".."), { recursive: true });
        await writeFile(destination, content);
      }
      await chmod(join(directory, "bin", "zcode.ts"), 0o755);
      await expect(validatePackageTree(directory)).resolves.toBeUndefined();
      await writeFile(join(directory, "vendor", "node_modules", "@zcode", "tui", "dist", "index.js"), "stale\n");
      await expect(validatePackageTree(directory)).rejects.toThrow(/stale/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
