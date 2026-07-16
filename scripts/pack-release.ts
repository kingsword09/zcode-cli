#!/usr/bin/env bun

import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { smokePackagedCli } from "./smoke-package.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, ".release");

export interface PackFile {
  path: string;
  mode: number;
  size: number;
}

export interface PackResult {
  name: string;
  version: string;
  filename: string;
  size: number;
  unpackedSize: number;
  integrity: string;
  shasum: string;
  files: PackFile[];
}

interface PackageIdentity {
  name?: unknown;
  version?: unknown;
}

const requiredFiles = [
  "LICENSE",
  "README.md",
  "bin/zcode.js",
  "config.example.json",
  "package.json",
  "vendor/extraction.json",
  "vendor/node_modules/@zcode/tui/dist/index.js",
  "vendor/node_modules/@zcode/tui/package.json",
  "vendor/zcode.cjs",
  "zcode-runtime.lock.json"
];
const allowedRoots = new Set([
  "LICENSE",
  "README.md",
  "bin/zcode.js",
  "config.example.json",
  "package.json",
  "zcode-runtime.lock.json"
]);
const allowedPrefixes = ["vendor/"];

export function parsePackResult(stdout: string): PackResult {
  const trimmed = stdout.trim();
  const start = Math.max(trimmed.lastIndexOf("\n["), trimmed.lastIndexOf("\n{")) + 1;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start));
    const results = Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === "object"
        ? Object.values(parsed)
        : [];
    if (results.length === 1) return results[0] as PackResult;
  } catch {}
  throw new Error("npm pack did not return one JSON package result.");
}

export function validatePackResult(result: PackResult, packageJson: PackageIdentity): void {
  if (result.name !== packageJson.name || result.version !== packageJson.version) {
    throw new Error("npm pack name or version differs from package.json.");
  }
  const paths = new Set(result.files.map((file) => file.path));
  for (const required of requiredFiles) {
    if (!paths.has(required)) throw new Error(`npm tarball is missing: ${required}`);
  }
  for (const path of paths) {
    if (!allowedRoots.has(path) && !allowedPrefixes.some((prefix) => path.startsWith(prefix))) {
      throw new Error(`npm tarball contains an unreviewed path: ${path}`);
    }
  }
  const bin = result.files.find((file) => file.path === "bin/zcode.js");
  if (!bin || (bin.mode & 0o111) === 0) throw new Error("npm tarball zcode bin is not executable.");
}

export async function packRelease(): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const npm = Bun.which("npm");
  if (!npm) throw new Error("npm is required to create the release tarball.");
  const child = Bun.spawn([npm, "pack", "--json", "--pack-destination", destination], {
    cwd: root,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit"
  });
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text()
  ]);
  if (code !== 0) throw new Error(`npm pack exited with status ${code}`);

  const result = parsePackResult(stdout);
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as PackageIdentity;
  validatePackResult(result, packageJson);
  const tarball = join(destination, result.filename);
  const release = {
    name: result.name,
    version: result.version,
    tarball: relative(root, tarball).split("\\").join("/"),
    size: result.size,
    unpackedSize: result.unpackedSize,
    integrity: result.integrity,
    shasum: result.shasum,
    files: result.files.length
  };
  await writeFile(join(destination, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  await smokePackagedCli(tarball);

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `tarball=${release.tarball}\n`);
  }
  console.log(
    `Packed ${release.name}@${release.version} to ${release.tarball} `
    + `(${release.files} files, ${release.size} bytes).`
  );
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await packRelease();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
