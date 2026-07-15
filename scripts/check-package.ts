#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseVersion } from "./release-version.ts";
import { parseRuntimeLock } from "./sync-runtime.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publishedFiles = [
  "bin/zcode.js",
  "vendor",
  "config.example.json",
  "zcode-runtime.lock.json",
  "README.md",
  "LICENSE"
];

interface PackageManifest {
  author?: unknown;
  bugs?: Record<string, unknown>;
  description?: unknown;
  homepage?: unknown;
  keywords?: unknown;
  license?: unknown;
  name?: unknown;
  repository?: Record<string, unknown>;
  version?: unknown;
  bin?: Record<string, unknown>;
  files?: unknown;
  publishConfig?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
}

interface TuiManifest {
  name?: unknown;
  version?: unknown;
  dependencies?: Record<string, unknown>;
}

interface ExtractionMetadata {
  appVersion?: unknown;
  cliVersion?: unknown;
  source?: unknown;
  sha512?: unknown;
}

async function sha512(path: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("base64");
}

async function run(command: string, args: string[]): Promise<void> {
  const child = Bun.spawn([command, ...args], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command} exited with status ${code}`);
}

function sameStringArray(left: unknown, right: string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export async function validatePackageTree(base = root): Promise<void> {
  const required = [
    "LICENSE",
    "README.md",
    "bin/zcode.js",
    "bin/zcode.ts",
    "config.example.json",
    "package.json",
    "src/command.ts",
    "src/darwin-oauth-callback.ts",
    "src/launcher.ts",
    "src/model-access.ts",
    "src/zai-oauth.ts",
    "tsdown.config.ts",
    "vendor/extraction.json",
    "vendor/node_modules/@zcode/tui/dist/index.js",
    "vendor/node_modules/@zcode/tui/package.json",
    "vendor/zcode.cjs",
    "zcode-runtime.lock.json"
  ];
  for (const path of required) {
    if (!existsSync(join(base, path))) throw new Error(`Release file is missing: ${path}`);
  }

  const packageJson = JSON.parse(await readFile(join(base, "package.json"), "utf8")) as PackageManifest;
  const release = parseReleaseVersion(String(packageJson.version ?? ""));
  if (!release) throw new Error("package.json version must use <app-version>-<build>.");
  if (typeof packageJson.description !== "string" || !packageJson.description.trim()) {
    throw new Error("The npm package description is missing.");
  }
  const keywords = Array.isArray(packageJson.keywords) ? packageJson.keywords : [];
  if (!keywords.every((keyword) => typeof keyword === "string")
    || !["cli", "node", "terminal", "tui", "zcode"].every((keyword) => keywords.includes(keyword))) {
    throw new Error("The npm package keywords are incomplete.");
  }
  if (packageJson.homepage !== "https://github.com/kingsword09/zcode-cli#readme"
    || packageJson.bugs?.url !== "https://github.com/kingsword09/zcode-cli/issues"
    || packageJson.repository?.type !== "git"
    || packageJson.repository?.url !== "git+https://github.com/kingsword09/zcode-cli.git") {
    throw new Error("The npm package repository metadata is inconsistent.");
  }
  if (packageJson.license !== "MIT" || typeof packageJson.author !== "string" || !packageJson.author.trim()) {
    throw new Error("The npm package license or author metadata is missing.");
  }
  if (packageJson.bin?.zcode !== "bin/zcode.js") throw new Error("The zcode npm bin entry is invalid.");
  if (!sameStringArray(packageJson.files, publishedFiles)) {
    throw new Error("The package.json files allowlist does not match the reviewed release contents.");
  }
  if (packageJson.publishConfig?.access !== "public" || packageJson.publishConfig?.provenance !== true) {
    throw new Error("npm public access and provenance must remain enabled.");
  }
  if (packageJson.dependencies?.zigpty !== undefined || packageJson.dependencies?.bun !== undefined) {
    throw new Error("The published package must not depend on a second PTY runtime or Bun.");
  }

  const lock = parseRuntimeLock(JSON.parse(await readFile(join(base, "zcode-runtime.lock.json"), "utf8")));
  const extraction = JSON.parse(
    await readFile(join(base, "vendor/extraction.json"), "utf8")
  ) as ExtractionMetadata;
  if (release.appVersion !== lock.appVersion) throw new Error("Package and runtime lock App versions differ.");
  if (extraction.appVersion !== lock.appVersion
    || extraction.source !== lock.url
    || extraction.sha512 !== lock.sha512) {
    throw new Error("Extracted runtime provenance does not match zcode-runtime.lock.json.");
  }
  if (typeof extraction.cliVersion !== "string" || !/^\d+\.\d+\.\d+/u.test(extraction.cliVersion)) {
    throw new Error("Extracted runtime has no valid CLI version.");
  }

  const sourceTui = join(base, "packages", "zcode-tui", "dist", "index.js");
  const packagedTui = join(base, "vendor", "node_modules", "@zcode", "tui", "dist", "index.js");
  if (!existsSync(sourceTui)) throw new Error("Local @zcode/tui is not built.");
  if (await sha512(sourceTui) !== await sha512(packagedTui)) {
    throw new Error("Packaged @zcode/tui is stale; run `bun run release:build` before packing.");
  }

  const sourceTuiPackage = JSON.parse(
    await readFile(join(base, "packages", "zcode-tui", "package.json"), "utf8")
  ) as TuiManifest;
  const packagedTuiPackage = JSON.parse(
    await readFile(join(base, "vendor", "node_modules", "@zcode", "tui", "package.json"), "utf8")
  ) as TuiManifest;
  if (sourceTuiPackage.name !== "@zcode/tui"
    || packagedTuiPackage.name !== sourceTuiPackage.name
    || packagedTuiPackage.version !== sourceTuiPackage.version
    || packageJson.dependencies?.["@earendil-works/pi-tui"]
      !== sourceTuiPackage.dependencies?.["@earendil-works/pi-tui"]) {
    throw new Error("Packaged @zcode/tui metadata or pi-tui dependency is inconsistent.");
  }

  const nodeLauncher = await stat(join(base, "bin", "zcode.js"));
  const nodeLauncherSource = await readFile(join(base, "bin", "zcode.js"), "utf8");
  if (!nodeLauncherSource.startsWith("#!/usr/bin/env node\n")) {
    throw new Error("The public zcode launcher has no Node.js shebang.");
  }
  if (nodeLauncherSource.includes("Bun.")
    || nodeLauncherSource.includes('from "zigpty"')
    || !nodeLauncherSource.includes('from "node:child_process"')) {
    throw new Error("The published launcher does not use the reviewed inherited-stdio Node.js runtime path.");
  }
  if (process.platform !== "win32" && (nodeLauncher.mode & 0o111) === 0) {
    throw new Error("The public zcode launcher is not executable.");
  }

  console.log(`Package tree checks passed for ${String(packageJson.name)}@${String(packageJson.version)}.`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--prepack")) throw new Error(`Unknown argument: ${args.join(" ")}`);
    if (args.includes("--prepack")) {
      await run(process.execPath, ["run", "build"]);
      await run(process.execPath, ["scripts/check-runtime.ts"]);
    }
    await validatePackageTree();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
