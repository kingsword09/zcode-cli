#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function execute(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit"
  });
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text()
  ]);
  return { code, stdout };
}

export async function smokePackagedCli(tarball: string): Promise<void> {
  const absoluteTarball = isAbsolute(tarball) ? tarball : resolve(root, tarball);
  if (!existsSync(absoluteTarball)) throw new Error(`Release tarball does not exist: ${absoluteTarball}`);
  const npm = Bun.which("npm");
  if (!npm) throw new Error("npm is required to install-test the release tarball.");

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "zcode-cli-package-"));
  try {
    const install = await execute(npm, [
      "install",
      "--no-audit",
      "--no-fund",
      "--prefix",
      temporaryDirectory,
      absoluteTarball
    ], root);
    if (install.code !== 0) throw new Error(`npm install smoke test failed with status ${install.code}`);

    const packageRoot = join(temporaryDirectory, "node_modules", "zcode-app-cli");
    const extraction = JSON.parse(
      await readFile(join(packageRoot, "vendor", "extraction.json"), "utf8")
    ) as { cliVersion?: string };
    const bin = process.platform === "win32"
      ? join(temporaryDirectory, "node_modules", ".bin", "zcode.cmd")
      : join(temporaryDirectory, "node_modules", ".bin", "zcode");
    const command = process.platform === "win32" ? "cmd.exe" : bin;
    const commandArgs = process.platform === "win32"
      ? ["/d", "/s", "/c", `\"${bin}\" --version`]
      : ["--version"];
    const version = await execute(command, commandArgs, temporaryDirectory);
    if (version.code !== 0 || version.stdout.trim() !== extraction.cliVersion) {
      throw new Error(`Installed zcode --version failed: ${version.stdout.trim() || `status ${version.code}`}`);
    }
    console.log(`Installed-package smoke test passed for ZCode CLI ${version.stdout.trim()}.`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    let tarball: string | undefined = process.argv.at(2);
    if (!tarball) {
      const release = JSON.parse(await readFile(join(root, ".release", "release.json"), "utf8")) as {
        tarball?: string;
      };
      tarball = release.tarball;
    }
    if (!tarball) throw new Error("No release tarball was provided.");
    await smokePackagedCli(tarball);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
