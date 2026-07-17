#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { formatVersionOutput, readDistributionVersion } from "../src/launcher.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(root, "vendor", "zcode.cjs");
const tui = join(root, "vendor", "node_modules", "@zcode", "tui", "dist", "index.js");
const node = process.env.ZCODE_NODE || Bun.which("node");

if (!existsSync(runtime)) throw new Error("vendor/zcode.cjs is missing; run `bun run sync` first.");
if (!existsSync(tui)) throw new Error("The local @zcode/tui adapter is missing; run `bun run sync` first.");
if (!node) throw new Error("Node.js >=22.19 is required by the official ZCode runtime.");

const runtimeSource = await Bun.file(runtime).text();
if (runtimeSource.includes('"OAuth response is not valid JSON",{httpStatus:void 0}')
  || !runtimeSource.includes('ZCODE_CLI_OAUTH_CALLBACK_STDIN==="1"')
  || !runtimeSource.includes(".loadSessionTranscript=async()=>await(await")
  || !runtimeSource.includes(".readGoal=async()=>await(await")
  || !runtimeSource.includes(".readTodos=async()=>await(await")
  || !runtimeSource.includes(".readRuntimeProjection=async()=>")
  || !runtimeSource.includes(".readSessionUsage=async()=>await(await")
  || !runtimeSource.includes(".cancelBackgroundTask=async")
  || !runtimeSource.includes(".previewFileRewind=async e=>")
  || !runtimeSource.includes(".applyFileRewind=async e=>")
  || !/Array\.isArray\([A-Za-z_$][\w$]*\.targetMessageIds\)/u.test(runtimeSource)
  || !/messageId:[A-Za-z_$][\w$]*\.info\.id,role:"user"/u.test(runtimeSource)
  || !/messageId:[A-Za-z_$][\w$]*\.info\.id,role:"agent"/u.test(runtimeSource)
  || !/sessionStore\.messages\(\{sessionID:([A-Za-z_$][\w$]*)\.sessionId\}\),[A-Za-z_$][\w$]*=await \1\.sessionStore\.getSession\(\1\.sessionId\);return/u.test(runtimeSource)
  || !/loadSessionTranscript:[A-Za-z_$][\w$]*\.loadSessionTranscript/u.test(runtimeSource)
  || !/readGoal:[A-Za-z_$][\w$]*\.readGoal/u.test(runtimeSource)
  || !/readTodos:[A-Za-z_$][\w$]*\.readTodos/u.test(runtimeSource)
  || !/readRuntimeProjection:[A-Za-z_$][\w$]*\.readRuntimeProjection/u.test(runtimeSource)
  || !/readSessionUsage:[A-Za-z_$][\w$]*\.readSessionUsage/u.test(runtimeSource)
  || !/cancelBackgroundTask:[A-Za-z_$][\w$]*\.cancelBackgroundTask/u.test(runtimeSource)
  || !/previewFileRewind:[A-Za-z_$][\w$]*\.previewFileRewind/u.test(runtimeSource)
  || !/applyFileRewind:[A-Za-z_$][\w$]*\.applyFileRewind/u.test(runtimeSource)) {
  throw new Error("The runtime compatibility patches are missing; run `bun run sync` again.");
}

async function execute(
  command: string,
  args: string[],
  input = ""
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([command, ...args], {
    cwd: root,
    env: process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });
  child.stdin.write(input);
  child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return { code, stdout, stderr };
}

const nodeVersion = await execute(node, ["--version"]);
const versionMatch = /^v(\d+)\.(\d+)\./.exec(nodeVersion.stdout.trim());
if (!versionMatch || Number(versionMatch[1]) < 22 || (Number(versionMatch[1]) === 22 && Number(versionMatch[2]) < 19)) {
  throw new Error(`Node.js >=22.19 is required; found ${nodeVersion.stdout.trim() || "unknown"}.`);
}

const version = await execute(node, [runtime, "--version"]);
if (version.code !== 0 || !/^\d+\.\d+\.\d+/.test(version.stdout.trim())) {
  throw new Error(`Version check failed: ${version.stderr || version.stdout}`);
}

const request = JSON.stringify({ id: 1, method: "session/list", params: {} });
const protocol = await execute(node, [runtime, "app-server"], `${request}\n`);
if (protocol.code !== 0) throw new Error(`app-server check failed: ${protocol.stderr}`);
const response = JSON.parse(protocol.stdout.trim().split("\n")[0]) as {
  id?: number;
  result?: { sessions?: unknown[] };
};
if (response.id !== 1 || !Array.isArray(response.result?.sessions)) {
  throw new Error(`Unexpected app-server response: ${protocol.stdout}`);
}

const tuiImport = await execute(node, [
  "--input-type=module",
  "--eval",
  `const module = await import(${JSON.stringify(pathToFileURL(tui).href)}); if (typeof module.runTui !== "function") process.exit(2);`
]);
if (tuiImport.code !== 0) throw new Error(`TUI import failed: ${tuiImport.stderr}`);

const launcher = await execute(node, [join(root, "bin", "zcode.js"), "--version"]);
const distributionVersion = readDistributionVersion();
const expectedLauncherVersion = distributionVersion
  ? formatVersionOutput(distributionVersion, version.stdout.trim())
  : undefined;
if (launcher.code !== 0 || !expectedLauncherVersion || launcher.stdout.trim() !== expectedLauncherVersion) {
  throw new Error(`Node.js launcher check failed: ${launcher.stderr || launcher.stdout}`);
}

console.log(
  `Runtime checks passed for ${expectedLauncherVersion.replace("\n", " / ")} with Node ${nodeVersion.stdout.trim()} and pi-tui.`
);
