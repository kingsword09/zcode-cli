import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

import { validatePackageTree } from "../scripts/check-package.ts";
import { attributionFiles, pluginLicenseFiles, publishedFiles } from "../scripts/package-contents.ts";
import { markRuntimeModified, runtimeModificationNotice } from "../scripts/runtime-attribution.ts";
import { runtimePatchPlan } from "../scripts/sync-runtime.ts";
import {
  type PackFile,
  type PackResult,
  parsePackResult,
  validatePackResult
} from "../scripts/pack-release.ts";

const requiredPaths = [
  "LICENSE",
  "LICENSES/Apache-2.0.txt",
  "LICENSES/README.md",
  "LICENSES/ZCode-NOTICE.md",
  "LICENSES/ZCode-THIRD-PARTY-NOTICES.md",
  "README.md",
  "bin/zcode.js",
  "setting.example.json",
  "provider.example.json",
  "docs/CONFIGURATION.md",
  "docs/CONFIGURATION.zh-CN.md",
  "docs/PROVIDER_CONFIG.md",
  "docs/PROVIDER_CONFIG.zh-CN.md",
  "docs/THIRD_PARTY_CONTENT.md",
  "package.json",
  "vendor/extraction.json",
  "vendor/node_modules/@zcode/tui/dist/index.js",
  "vendor/node_modules/@zcode/tui/package.json",
  "vendor/zcode.cjs",
  "vendor/cli-config.cjs",
  "vendor/provider/zcode-builtin.json",
  "vendor/packages/documents-plugin/skills/docx/LICENSE.txt",
  "vendor/packages/pdf-plugin/skills/pdf/LICENSE.txt",
  "vendor/packages/presentations-plugin/skills/pptx/LICENSE.txt",
  "vendor/packages/spreadsheets-plugin/skills/xlsx/LICENSE.txt",
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
  test("requires upstream notices and original plugin licenses in the tarball", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(manifest.files).toEqual(publishedFiles);
    for (const path of [...attributionFiles, ...pluginLicenseFiles]) {
      expect(() => validatePackResult(result(requiredPaths.filter(file => file !== path).map(packFile)), {
        name: "zcode-app-cli", version: "3.3.5-1"
      })).toThrow(`missing: ${path}`);
    }
  });

  test("marks modified runtime bundles without removing the shebang or upstream text", () => {
    const body = '"use strict";\n// Original upstream copyright\nreturn 42;\n';
    for (const shebang of ["", "#!/usr/bin/env node\n"]) {
      const marked = markRuntimeModified(shebang + body);
      expect(marked).toBe(shebang + runtimeModificationNotice + body);
      expect(new Function(marked.slice(shebang.length))()).toBe(42);
      expect(markRuntimeModified(marked)).toBe(marked);
    }
  });

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
    expect(packageJson.scripts["test:all"]).toContain("test:node");
    expect(packageJson.scripts["test:node"]).toBe("node --test test/node/*.test.cjs");
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

  test("pins one Bun toolchain and tests the validated artifact with real Node versions", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(packageJson.packageManager).toBe("bun@1.4.1");
    expect(packageJson.devDependencies["bun-types"]).toBe("1.4.1");
    for (const name of ["ci", "prepare-release", "publish"]) {
      const workflow = parse(await Bun.file(new URL(`../.github/workflows/${name}.yml`, import.meta.url)).text());
      for (const job of Object.values(workflow.jobs) as { steps?: { uses?: string; with?: Record<string, unknown> }[] }[]) {
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith("oven-sh/setup-bun@")) expect(step.with?.["bun-version"]).toBe("1.4.1");
        }
      }
      if (name === "ci") {
        const matrix = workflow.jobs["node-runtime"];
        expect(matrix.needs).toBe("validate");
        expect(matrix.strategy.matrix.node).toEqual(["22.19.0", "24", "26"]);
        expect(matrix.strategy.matrix.include).toContainEqual({ os: "macos-latest", node: "24" });
        expect(matrix.steps.some((step: { run?: string }) => step.run === "bun run test:node")).toBe(true);
        expect(matrix.steps.some((step: { uses?: string }) => step.uses?.startsWith("actions/download-artifact@"))).toBe(true);
      }
    }
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

  test("rejects a missing runtime notice or a compiled TUI that was not injected into vendor", async () => {
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
      files: publishedFiles,
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
      ...Object.fromEntries(pluginLicenseFiles.map(path => [path, "original plugin license\n"])),
      "docs/CONFIGURATION.md": "# Fixture documentation\n",
      "docs/CONFIGURATION.zh-CN.md": "# Fixture documentation\n",
      "docs/PROVIDER_CONFIG.md": "# Fixture documentation\n",
      "docs/PROVIDER_CONFIG.zh-CN.md": "# Fixture documentation\n",
      "docs/THIRD_PARTY_CONTENT.md": "# Fixture documentation\n",
      "LICENSES/Apache-2.0.txt": "license\n",
      "LICENSES/README.md": "notice provenance\n",
      "LICENSES/ZCode-NOTICE.md": "upstream notice\n",
      "LICENSES/ZCode-THIRD-PARTY-NOTICES.md": "dependency notices\n",
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
      await expect(validatePackageTree(directory)).rejects.toThrow(/modification notice/);
      await writeFile(join(directory, "vendor", "zcode.cjs"), markRuntimeModified(files["vendor/zcode.cjs"]!));
      await expect(validatePackageTree(directory)).resolves.toBeUndefined();
      for (const path of pluginLicenseFiles) {
        await rm(join(directory, path));
        await expect(validatePackageTree(directory)).rejects.toThrow(`Release file is missing: ${path}`);
        await writeFile(join(directory, path), files[path]!);
      }
      await writeFile(join(directory, "vendor", "node_modules", "@zcode", "tui", "dist", "index.js"), "stale\n");
      await expect(validatePackageTree(directory)).rejects.toThrow(/stale/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([false, true])("writes release.json only after installation checks pass (valid plugins: %p)", async (validPlugins) => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-release-finalize-"));
    try {
      for (const path of requiredPaths) {
        await mkdir(join(directory, path, ".."), { recursive: true });
        await writeFile(join(directory, path), "fixture\n");
      }
      await writeFile(join(directory, "package.json"), JSON.stringify({
        name: "zcode-app-cli", version: "3.3.5-1", type: "module",
        files: publishedFiles, bin: { zcode: "bin/zcode.js" }
      }));
      await writeFile(join(directory, "vendor/extraction.json"), JSON.stringify({ cliVersion: "0.15.2" }));
      await writeFile(join(directory, "vendor/zcode.cjs"), runtimeModificationNotice);
      const plugins = validPlugins
        ? ["browser-use", "documents", "pdf", "presentations", "spreadsheets"].map(name => ({ name, enabled: true }))
        : [];
      await writeFile(join(directory, "bin/zcode.js"), [
        "#!/usr/bin/env node",
        `console.log(process.argv.includes("--version") ? "zcode-app-cli 3.3.5-1\\nzcode-runtime 0.15.2" : ${JSON.stringify(JSON.stringify(plugins))});`,
        ""
      ].join("\n"));
      await chmod(join(directory, "bin/zcode.js"), 0o755);
      const moduleUrl = new URL("../scripts/pack-release.ts", import.meta.url).href;
      const packageDirectory = validPlugins ? directory : relative(process.cwd(), directory);
      const child = Bun.spawn([process.execPath, "--eval",
        `import { packRelease } from ${JSON.stringify(moduleUrl)}; await packRelease(${JSON.stringify(packageDirectory)});`
      ], {
        env: { ...process.env, GITHUB_OUTPUT: undefined },
        stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL"
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ]);
      const manifestPath = join(directory, ".release/release.json");
      if (validPlugins) {
        expect(code, stderr || stdout).toBe(0);
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        expect(manifest).toMatchObject({ name: "zcode-app-cli", version: "3.3.5-1" });
        expect(await Bun.file(join(directory, manifest.tarball)).exists()).toBe(true);
      } else {
        expect(code).not.toBe(0);
        expect(stderr).toContain("Installed package cannot initialize its built-in plugin: browser-use");
        expect(await Bun.file(manifestPath).exists()).toBe(false);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 35_000);
});
