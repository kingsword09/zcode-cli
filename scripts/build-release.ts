#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type RuntimeCompatibilityFailure,
  parseRuntimePatchReports,
  writeRuntimeCompatibilityFailure
} from "./sync-runtime.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`bun ${args.join(" ")} exited with status ${code}`);
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--latest")) throw new Error(`Unknown argument: ${args.join(" ")}`);
const latest = args.includes("--latest");
let latestRuntimeSynced = false;

try {
  await run(["run", "typecheck"]);
  await run(["run", latest ? "sync" : "sync:locked"]);
  latestRuntimeSynced = latest;
  await run(["test"]);
  await run(["run", "check"]);
  await run(["run", "check:tui"]);
  await run(["scripts/check-package.ts"]);
} catch (error) {
  const reportPath = resolve(root, ".release", "runtime-compatibility.json");
  if (latestRuntimeSynced && !existsSync(reportPath)) {
    let appVersion: string | undefined;
    let runtimePatches: RuntimeCompatibilityFailure["runtimePatches"] = [];
    try {
      const extraction: unknown = await Bun.file(resolve(root, "vendor", "extraction.json")).json();
      if (extraction && typeof extraction === "object") {
        const record = extraction as Record<string, unknown>;
        appVersion = typeof record.appVersion === "string" ? record.appVersion : undefined;
        runtimePatches = parseRuntimePatchReports(record.runtimePatches) ?? [];
      }
    } catch {}
    const report: RuntimeCompatibilityFailure = {
      schemaVersion: 1,
      ...(appVersion ? { appVersion } : {}),
      generatedAt: new Date().toISOString(),
      phase: "release_validation",
      error: error instanceof Error ? error.message : String(error),
      runtimePatches
    };
    await writeRuntimeCompatibilityFailure(report);
  }
  throw error;
}

console.log(`Release build passed using the ${latest ? "latest upstream" : "locked"} runtime.`);
