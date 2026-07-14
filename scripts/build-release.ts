#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

await run(["run", "typecheck"]);
await run(["test"]);
await run(["run", latest ? "sync" : "sync:locked"]);
await run(["run", "check"]);
await run(["run", "check:tui"]);
await run(["scripts/check-package.ts"]);

console.log(`Release build passed using the ${latest ? "latest upstream" : "locked"} runtime.`);
