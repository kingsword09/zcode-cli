#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { formatVersionOutput, readDistributionVersion } from "../src/launcher.ts";
import { capabilitiesFromExtractionMetadata } from "../src/runtime-capabilities.ts";
import {
  extractRuntimeCapabilities,
  hasRuntimeCliHelpContract,
  hasRuntimeHttpNoContentGuard,
  patchRuntimeGoalFailurePause,
  patchRuntimeHttpNoContent,
  patchRuntimeLoginModelDefaults,
  parseRuntimePatchReports,
  runtimePatchPlan,
  supportsMultiMessageFileRewind
} from "./sync-runtime.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(root, "vendor", "zcode.cjs");
const tui = join(root, "vendor", "node_modules", "@zcode", "tui", "dist", "index.js");
const node = process.env.ZCODE_NODE || Bun.which("node");
const require = createRequire(import.meta.url);

if (!existsSync(runtime)) throw new Error("vendor/zcode.cjs is missing; run `bun run sync` first.");
if (!existsSync(tui)) throw new Error("The local @zcode/tui adapter is missing; run `bun run sync` first.");
if (!node) throw new Error("Node.js >=22.19 is required by the official ZCode runtime.");

const packageManifest = await Bun.file(join(root, "package.json")).json() as {
  dependencies?: Record<string, unknown>;
};
const extractionMetadata: unknown = await Bun.file(join(root, "vendor", "extraction.json")).json();
const metadataRecord = extractionMetadata && typeof extractionMetadata === "object"
  ? extractionMetadata as Record<string, unknown>
  : {};
const patchReports = new Map(
  (parseRuntimePatchReports(metadataRecord.runtimePatches) ?? []).map((report) => [report.id, report])
);
const patchEnabled = (id: string): boolean => {
  const status = patchReports.get(id)?.status;
  return status === "applied" || status === "already_present";
};
for (const patch of runtimePatchPlan) {
  const report = patchReports.get(patch.id);
  if (!report || report.requirement !== patch.requirement
    || (patch.requirement === "required" && !patchEnabled(patch.id))) {
    throw new Error(`Runtime patch report is missing or invalid for ${patch.id}.`);
  }
}
const playwrightManifest = await Bun.file(require.resolve("playwright-core/package.json")).json() as {
  version?: unknown;
};
if (packageManifest.dependencies?.["playwright-core"] !== "1.59.1"
  || playwrightManifest.version !== packageManifest.dependencies["playwright-core"]) {
  throw new Error("The runtime-compatible playwright-core dependency is missing or has the wrong version.");
}

const runtimeSource = await Bun.file(runtime).text();
const metadataCapabilities = capabilitiesFromExtractionMetadata(extractionMetadata);
if (!metadataCapabilities
  || !isDeepStrictEqual(metadataCapabilities, extractRuntimeCapabilities(runtimeSource))) {
  throw new Error("The extracted runtime capability manifest is missing or stale; run `bun run sync` again.");
}
if (patchRuntimeLoginModelDefaults(runtimeSource) !== runtimeSource
  || (patchEnabled("goal-failure-pause") && patchRuntimeGoalFailurePause(runtimeSource) !== runtimeSource)
  || patchRuntimeHttpNoContent(runtimeSource) !== runtimeSource
  || !hasRuntimeHttpNoContentGuard(runtimeSource)
  || (patchEnabled("cli-help-contract") && !hasRuntimeCliHelpContract(runtimeSource))
  || !runtimeSource.includes(".readRuntimeProjection=async()=>{let $zRuntimeProjectionBridge=await ")
  || !runtimeSource.includes('"plugin://"')
  || !runtimeSource.includes('return await import("playwright-core")')
  || !runtimeSource.includes('pluginsReferenceCatalog:"plugins/referenceCatalog"')
  || !runtimeSource.includes('pluginsMarketplaceAdd:"plugins/marketplace/add"')
  || !runtimeSource.includes('pluginsInstall:"plugins/install"')
  || (patchEnabled("oauth-http-errors")
    && runtimeSource.includes('"OAuth response is not valid JSON",{httpStatus:void 0}'))
  || !runtimeSource.includes('ZCODE_CLI_OAUTH_CALLBACK_STDIN==="1"')
  || !runtimeSource.includes(".loadSessionTranscript=async()=>await(await")
  || !runtimeSource.includes('"loadSessionContextMessages"')
  || !runtimeSource.includes(".readGoal=async()=>await(await")
  || !runtimeSource.includes(".readTodos=async()=>await(await")
  || !runtimeSource.includes(".readRuntimeProjection=async()=>")
  || !runtimeSource.includes(".readSessionUsage=async()=>await(await")
  || !runtimeSource.includes(".cancelBackgroundTask=async")
  || !runtimeSource.includes(".previewFileRewind=async e=>")
  || !runtimeSource.includes(".applyFileRewind=async e=>")
  || !runtimeSource.includes(".setMode=async")
  || !runtimeSource.includes(".listSkills=async()=>await")
  || !runtimeSource.includes(".subscribeSessionEvents=")
  || !runtimeSource.includes(".sendBackgroundTaskMessage=async")
  || !runtimeSource.includes("backgroundTaskDetails")
  || !runtimeSource.includes(".$zRestorePersistedBackgroundTasks=async $zApp=>")
  || !runtimeSource.includes(".$zRestorePersistedBackgroundTasks?.(")
  || !runtimeSource.includes("$zApp.loadSessionTranscript?.()")
  || !runtimeSource.includes('catch{$zApp.$zRestoredBackgroundTasksSession=void 0}')
  || !runtimeSource.includes('.$zRestoredBackgroundTasksLog=[]')
  || !runtimeSource.includes('restoredBackgroundTasks:Array.isArray(')
  || !runtimeSource.includes('childSessionId:"sess_subagent_"+$zAgentId')
  || !runtimeSource.includes('$zOutput.includes("Async agent launched successfully.")')
  || !runtimeSource.includes('.addAttachment?.("task_status"')
  || !runtimeSource.includes("error:typeof $zMetadata.error")
  || !runtimeSource.includes(".$zSendInputWithoutBackgroundRestore=")
  || !runtimeSource.includes("s[$zIndex]={...s[$zIndex]")
  || !runtimeSource.includes(".$zRestorePersistedBackgroundTasks?.(t)")
  || !runtimeSource.includes('error:o.status==="running"?null:')
  || !runtimeSource.includes('completedAt:o.status==="running"?null:')
  || (patchEnabled("agent-auto-background")
    && !runtimeSource.includes("autoBackgroundMs:this.config.subagents?.autoBackgroundMs??1e3,outputRootDir:"))
  || (patchEnabled("detached-agent-lifecycle")
    && runtimeSource.split("Detached background agent lifecycle failed").length < 3)
  || !runtimeSource.includes('if(e?.restart===!0&&o.status==="running")')
  || !runtimeSource.includes('e?.waitForIdle===!0&&t.runtime?.getActiveForegroundExecutionId')
  || (patchEnabled("terminal-tool-projection")
    && !runtimeSource.includes('status:"idle",currentTurnId:void 0,activeToolCalls:[],totalTokenCount:'))
  || (patchEnabled("terminal-tool-projection")
    && !runtimeSource.includes('status:"error",currentTurnId:void 0,activeToolCalls:[],lastError:'))
  || !/runtimeTaskRegistry\?\.all\?\.\(\)\?\?\{\}\)\.filter\(([A-Za-z_$][\w$]*)=>\1\.isBackgrounded===!0\)\.map\(/u.test(runtimeSource)
  || !supportsMultiMessageFileRewind(runtimeSource)
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
  || !/applyFileRewind:[A-Za-z_$][\w$]*\.applyFileRewind/u.test(runtimeSource)
  || !/setMode:[A-Za-z_$][\w$]*\.setMode/u.test(runtimeSource)
  || !/listSkills:[A-Za-z_$][\w$]*\.listSkills/u.test(runtimeSource)
  || !/listModelOptions:[A-Za-z_$][\w$]*\.listModelOptions/u.test(runtimeSource)
  || !/setTransientModel:[A-Za-z_$][\w$]*\.setTransientModel/u.test(runtimeSource)
  || !/subscribeSessionEvents:[A-Za-z_$][\w$]*\.subscribeSessionEvents/u.test(runtimeSource)
  || !/sendBackgroundTaskMessage:[A-Za-z_$][\w$]*\.sendBackgroundTaskMessage/u.test(runtimeSource)) {
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
