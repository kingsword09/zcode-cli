#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatVersionOutput } from "../src/launcher.ts";
import { runtimeModificationNotice } from "./runtime-attribution.ts";
import { pluginLicenseFiles } from "./package-contents.ts";
import { runPackageCommand } from "./package-command.ts";
import { runtimeTestEnv } from "./runtime-test-env.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function smokePackagedCli(tarball: string): Promise<void> {
  const absoluteTarball = isAbsolute(tarball) ? tarball : resolve(root, tarball);
  if (!existsSync(absoluteTarball)) throw new Error(`Release tarball does not exist: ${absoluteTarball}`);
  const npm = Bun.which("npm");
  if (!npm) throw new Error("npm is required to install-test the release tarball.");

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "zcode-cli-package-"));
  try {
    const install = await runPackageCommand(npm, [
      "install",
      "--no-audit",
      "--no-fund",
      "--prefix",
      temporaryDirectory,
      absoluteTarball
    ], { cwd: root, label: "npm install", timeoutMs: 180_000 });
    if (install.code !== 0) throw new Error(`npm install smoke test failed with status ${install.code}`);

    const packageRoot = join(temporaryDirectory, "node_modules", "zcode-app-cli");
    for (const path of pluginLicenseFiles) {
      if (!existsSync(join(packageRoot, path))) throw new Error(`Installed package is missing: ${path}`);
    }
    const env = runtimeTestEnv(join(temporaryDirectory, "home"), packageRoot);
    const packageManifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8")
    ) as { version?: string };
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
    const version = await runPackageCommand(command, commandArgs, {
      cwd: temporaryDirectory, env, label: "Installed zcode --version", timeoutMs: 15_000
    });
    const expectedVersion = packageManifest.version && extraction.cliVersion
      ? formatVersionOutput(packageManifest.version, extraction.cliVersion)
      : undefined;
    if (version.code !== 0 || !expectedVersion || version.stdout.trim() !== expectedVersion) {
      throw new Error(`Installed zcode --version failed: ${version.stdout.trim() || `status ${version.code}`}`);
    }
    const runtime = await readFile(join(packageRoot, "vendor", "zcode.cjs"), "utf8");
    if (!runtime.includes(runtimeModificationNotice)) throw new Error("Installed runtime has no modification notice.");

    const pluginArgs = process.platform === "win32"
      ? ["/d", "/s", "/c", `\"${bin}\" plugins list --json`]
      : ["plugins", "list", "--json"];
    const pluginResult = await runPackageCommand(command, pluginArgs, {
      cwd: temporaryDirectory, env, label: "Installed plugin initialization", timeoutMs: 30_000
    });
    const plugins: unknown = pluginResult.code === 0 ? JSON.parse(pluginResult.stdout) : undefined;
    if (!Array.isArray(plugins)) {
      throw new Error("Installed package cannot initialize its included built-in plugins.");
    }
    for (const name of ["browser-use", "documents", "pdf", "presentations", "spreadsheets"]) {
      if (!plugins.some(plugin => plugin.name === name && plugin.enabled)) {
        throw new Error(`Installed package cannot initialize its built-in plugin: ${name}`);
      }
    }
    console.log(`Installed-package smoke test passed for ${expectedVersion.replace("\n", " / ")}.`);
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
