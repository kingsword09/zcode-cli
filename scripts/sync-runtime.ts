#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { syncedReleaseVersion } from "./release-version.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cdnRoot = "https://cdn-zcode.z.ai/zcode/electron/releases";
const updateServiceRoot = "https://zcode.z.ai";
const updateServiceManifestPath = "/api/v1/releases/electron/manifest";
const stableReleaseChannel = "1";
const updateManifestAccept = "application/x-yaml,text/yaml,text/plain,*/*";
export const defaultAgentAutoBackgroundMs = 1_000;

export interface SyncOptions {
  platform: "darwin" | "linux" | "win32";
  arch: string;
  app?: string;
  lock?: string;
  version?: string;
}

interface Artifact {
  url: string;
  sha512: string;
}

interface UpdateManifest {
  version?: string | number;
  files?: Artifact[];
}

interface RuntimeSource {
  appVersion: string;
  glm: string;
  lock?: RuntimeLock;
  source: string;
}

export interface RuntimeLock {
  schemaVersion: 1;
  appVersion: string;
  platform: SyncOptions["platform"];
  arch: string;
  url: string;
  sha512: string;
}

export interface RuntimeManifestResolution {
  lock: RuntimeLock;
  source: "service" | "static";
  url: string;
}

type ManifestFetcher = (url: string, init?: RequestInit) => Promise<string>;

export function parseArgs(argv: string[]): SyncOptions {
  const result: SyncOptions = { platform: "linux", arch: "x64" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--app" && value) {
      result.app = value;
      index += 1;
    } else if (key === "--lock" && value) {
      result.lock = value;
      index += 1;
    } else if (key === "--platform" && (value === "darwin" || value === "linux" || value === "win32")) {
      result.platform = value;
      index += 1;
    } else if (key === "--arch" && value) {
      result.arch = value;
      index += 1;
    } else if (key === "--version" && value) {
      result.version = value;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${key}`);
    }
  }
  if (result.app && result.lock) throw new Error("--app and --lock cannot be used together.");
  if (result.version && !result.app) throw new Error("--version can only be used with --app.");
  return result;
}

export function parseRuntimeLock(value: unknown): RuntimeLock {
  if (!value || typeof value !== "object") throw new Error("Runtime lock must be a JSON object.");
  const candidate = value as Partial<RuntimeLock>;
  if (candidate.schemaVersion !== 1) throw new Error("Unsupported runtime lock schema.");
  if (typeof candidate.appVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(candidate.appVersion)) {
    throw new Error("Runtime lock has an invalid App version.");
  }
  if (candidate.platform !== "darwin" && candidate.platform !== "linux" && candidate.platform !== "win32") {
    throw new Error("Runtime lock has an invalid platform.");
  }
  if (typeof candidate.arch !== "string" || !candidate.arch.trim()) {
    throw new Error("Runtime lock has an invalid architecture.");
  }
  if (typeof candidate.url !== "string") throw new Error("Runtime lock has no artifact URL.");
  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch (error) {
    throw new Error("Runtime lock has an invalid artifact URL.", { cause: error });
  }
  if (url.protocol !== "https:") throw new Error("Runtime lock artifact URL must use HTTPS.");
  if (typeof candidate.sha512 !== "string"
    || Buffer.from(candidate.sha512, "base64").length !== 64
    || Buffer.from(candidate.sha512, "base64").toString("base64") !== candidate.sha512) {
    throw new Error("Runtime lock has an invalid SHA-512 digest.");
  }
  return {
    schemaVersion: 1,
    appVersion: candidate.appVersion,
    platform: candidate.platform,
    arch: candidate.arch,
    url: url.href,
    sha512: candidate.sha512
  };
}

function compareAppVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function selectRuntimeLock(candidate: RuntimeLock, current?: RuntimeLock): RuntimeLock {
  if (
    current
    && current.platform === candidate.platform
    && current.arch === candidate.arch
    && compareAppVersions(current.appVersion, candidate.appVersion) > 0
  ) {
    return current;
  }
  return candidate;
}

export function manifestUrl(platform: SyncOptions["platform"], arch: string): string {
  if (platform === "darwin") return `${cdnRoot}/update/mac/${arch}/latest-mac.yml`;
  if (platform === "linux") return `${cdnRoot}/update/linux/${arch}/latest-linux.yml`;
  return `${cdnRoot}/update/win/${arch}/latest.yml`;
}

export function serviceReleasePlatform(platform: SyncOptions["platform"], arch: string): string {
  const releasePlatform = platform === "darwin"
    ? "darwin"
    : platform === "win32" ? "windows" : "linux";
  const releaseArch = arch === "arm64"
    ? "aarch64"
    : arch === "x64" ? "x86_64" : arch === "ia32" ? "x86" : arch;
  return `${releasePlatform}-${releaseArch}`;
}

export function serviceManifestUrl(platform: SyncOptions["platform"], arch: string): string {
  const url = new URL(updateServiceManifestPath, updateServiceRoot);
  url.searchParams.set("platform", serviceReleasePlatform(platform, arch));
  url.searchParams.set("channel", stableReleaseChannel);
  return url.href;
}

export function resolveArtifactUrl(manifestHref: string, artifactHref: string): string {
  return new URL(artifactHref, manifestHref).href;
}

export function chooseArtifact(manifest: UpdateManifest, platform: SyncOptions["platform"]): Artifact {
  const files = manifest.files ?? [];
  const extension = platform === "linux" ? ".deb" : platform === "darwin" ? ".zip" : ".exe";
  const artifact = files.find((file) => file.url.endsWith(extension));
  if (!artifact?.url || !artifact.sha512) {
    throw new Error(`No ${extension} artifact with sha512 was found in the update manifest.`);
  }
  return artifact;
}

function parseUpdateManifest(contents: string, url: string): UpdateManifest {
  const manifest: unknown = parse(contents);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`The update manifest at ${url} is not an object.`);
  }
  return manifest as UpdateManifest;
}

async function runtimeLockFromManifest(
  options: Pick<SyncOptions, "platform" | "arch">,
  url: string,
  artifactBaseUrl: string,
  fetcher: ManifestFetcher,
  init?: RequestInit
): Promise<RuntimeLock> {
  const manifest = parseUpdateManifest(await fetcher(url, init), url);
  const artifact = chooseArtifact(manifest, options.platform);
  if (manifest.version === undefined) throw new Error("The update manifest does not contain a version.");
  return parseRuntimeLock({
    schemaVersion: 1,
    appVersion: String(manifest.version),
    platform: options.platform,
    arch: options.arch,
    url: resolveArtifactUrl(artifactBaseUrl, artifact.url),
    sha512: artifact.sha512
  });
}

export async function resolveLatestRuntimeLock(
  options: Pick<SyncOptions, "platform" | "arch">,
  fetcher: ManifestFetcher = fetchText
): Promise<RuntimeManifestResolution> {
  const serviceUrl = serviceManifestUrl(options.platform, options.arch);
  const releasePlatform = serviceReleasePlatform(options.platform, options.arch);
  try {
    const lock = await runtimeLockFromManifest(
      options,
      serviceUrl,
      new URL("/", serviceUrl).href,
      fetcher,
      {
        headers: {
          Accept: updateManifestAccept,
          "X-Platform": releasePlatform,
          "X-Release-Channel": stableReleaseChannel
        }
      }
    );
    return { lock, source: "service", url: serviceUrl };
  } catch (error) {
    const fallbackUrl = manifestUrl(options.platform, options.arch);
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Stable update service manifest failed (${reason}); falling back to ${fallbackUrl}.`);
    const lock = await runtimeLockFromManifest(options, fallbackUrl, fallbackUrl, fetcher);
    return { lock, source: "static", url: fallbackUrl };
  }
}

export function supportsMultiMessageFileRewind(runtime: string): boolean {
  return /(?:Array\.isArray\([A-Za-z_$][\w$]*\.targetMessageIds\)|[A-Za-z_$][\w$]*\.targetMessageIds&&[A-Za-z_$][\w$]*\.targetMessageIds\.length>0)/u
    .test(runtime);
}

/** Keep short Agent calls inline, but detach long-running agents from the foreground turn. */
export function patchRuntimeAgentAutoBackground(runtime: string): string {
  const marker = "autoBackgroundMs:this.config.subagents?.autoBackgroundMs??1e3,outputRootDir:";
  if (runtime.includes(marker)) return runtime;
  const anchor = "autoBackgroundMs:this.config.subagents?.autoBackgroundMs,outputRootDir:";
  if (!runtime.includes(anchor)) {
    throw new Error("ZCode runtime is incompatible with the Agent auto-background patch.");
  }
  return runtime.replace(anchor, marker);
}

/** Keep a detached Agent lifecycle failure from terminating the entire CLI process. */
export function patchRuntimeDetachedAgentLifecycle(runtime: string): string {
  const marker = 'Detached background agent lifecycle failed';
  const detachedRunnerPattern = /(onSessionStartFailed:([A-Za-z_$][\w$]*)\.reject\},[A-Za-z_$][\w$]*\.dispose)\);try\{await \2\.promise\}/gu;
  const patched = runtime.replace(
    detachedRunnerPattern,
    '$1).catch(e=>{console.error("Detached background agent lifecycle failed",e??"unknown rejection")});try{await $2.promise}'
  );
  if (patched !== runtime) return patched;
  if (!runtime.includes(marker)) {
    throw new Error("ZCode runtime is incompatible with the detached Agent lifecycle patch.");
  }
  return runtime;
}

/** Clear tool projection entries when their owning turn reaches a terminal state. */
export function patchRuntimeTerminalToolProjection(runtime: string): string {
  const completedMarker = 'status:"idle",currentTurnId:void 0,activeToolCalls:[],totalTokenCount:';
  const failedMarker = 'status:"error",currentTurnId:void 0,activeToolCalls:[],lastError:';
  let patched = runtime;
  if (!patched.includes(completedMarker)) {
    const anchor = 'status:"idle",totalTokenCount:';
    if (!patched.includes(anchor)) {
      throw new Error("ZCode runtime is incompatible with the terminal tool projection patch.");
    }
    patched = patched.replace(anchor, completedMarker);
  }
  if (!patched.includes(failedMarker)) {
    const anchor = 'status:"error",lastError:';
    if (!patched.includes(anchor)) {
      throw new Error("ZCode runtime is incompatible with the terminal tool projection patch.");
    }
    patched = patched.replace(anchor, failedMarker);
  }
  return patched;
}

/** Pause an active goal when its continuation turn fails instead of leaving it active. */
export function patchRuntimeGoalFailurePause(runtime: string): string {
  const alreadyPatchedPattern = /finishTargetTurnAccounting\(\{[^{}]*?status:"paused",traceContext:/u;
  if (alreadyPatchedPattern.test(runtime)) return runtime;

  const failureStatusPattern = /(finishTargetTurnAccounting\(\{[^{}]*?status:)[A-Za-z_$][\w$]*\.type===[A-Za-z_$][\w$]*\.TurnCancelled\?"paused":void 0(,traceContext:)/u;
  if (!failureStatusPattern.test(runtime)) {
    throw new Error("ZCode runtime is incompatible with the goal failure pause patch.");
  }
  return runtime.replace(
    failureStatusPattern,
    '$1"paused"$2'
  );
}

/** Exclude foreground Agent calls from the TUI background task projection. */
export function patchRuntimeBackgroundTaskProjection(runtime: string): string {
  const filteredProjectionPattern = /runtimeTaskRegistry\?\.all\?\.\(\)\?\?\{\}\)\.filter\(([A-Za-z_$][\w$]*)=>\1\.isBackgrounded===!0\)\.map\(/u;
  if (filteredProjectionPattern.test(runtime)) return runtime;
  const projectionPattern = /Object\.values\(([A-Za-z_$][\w$]*)\.runtime\?\.runtimeTaskRegistry\?\.all\?\.\(\)\?\?\{\}\)\.map\(([A-Za-z_$][\w$]*)=>/u;
  const projection = projectionPattern.exec(runtime);
  if (!projection) {
    throw new Error("ZCode runtime is incompatible with the background task projection patch.");
  }
  return runtime.replace(
    projectionPattern,
    `Object.values($1.runtime?.runtimeTaskRegistry?.all?.()??{}).filter($2=>$2.isBackgrounded===!0).map($2=>`
  );
}

export function patchRuntimeTuiBridge(runtime: string): string {
  const transcriptMessageIdPattern = /\.push\(\{content:[A-Za-z_$][\w$]*,messageId:[A-Za-z_$][\w$]*\.info\.id,role:"user"\}\)/u;
  const transcriptAgentMessageIdPattern = /messageId:[A-Za-z_$][\w$]*\.info\.id,role:"agent"/u;
  const activeTranscriptPattern = /sessionStore\.messages\(\{sessionID:([A-Za-z_$][\w$]*)\.sessionId\}\),[A-Za-z_$][\w$]*=await \1\.sessionStore\.getSession\(\1\.sessionId\);return/u;
  const activeTurnSteerPattern = /(\.steerTurn\(\{commandKind:([A-Za-z_$][\w$]*)\?\.commandKind,inputId:\2\?\.inputId,queryId:\2\?\.queryId,expectedTurnId:\2\?\.expectedTurnId,)(?:delivery:"guide",)?(?:pendingInputId:\2\?\.pendingInputId,)?input:/u;
  const activeTurnGuidePattern = /\.steerTurn\(\{commandKind:([A-Za-z_$][\w$]*)\?\.commandKind,inputId:\1\?\.inputId,queryId:\1\?\.queryId,expectedTurnId:\1\?\.expectedTurnId,delivery:"guide",pendingInputId:\1\?\.pendingInputId,input:/u;
  const listSkillsBridgePattern = /\.listSkills=async\(\)=>await [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)/u;
  const listSkillsOptionPattern = /listSkills:[A-Za-z_$][\w$]*\.listSkills/u;
  const sessionEventsBridgePattern = /\.subscribeSessionEvents=[A-Za-z_$][\w$]*=>/u;
  const sessionEventsOptionPattern = /subscribeSessionEvents:[A-Za-z_$][\w$]*\.subscribeSessionEvents/u;
  const taskMessageBridgePattern = /\.sendBackgroundTaskMessage=async [A-Za-z_$][\w$]*=>/u;
  const taskMessageOptionPattern = /sendBackgroundTaskMessage:[A-Za-z_$][\w$]*\.sendBackgroundTaskMessage/u;
  const taskMessageRestartMarker = "e?.restart===!0";
  const interruptTurnMarker = ".interruptTurn=async e=>";
  const interruptWaitForIdleMarker = "e?.waitForIdle===!0";
  const queuedInputPromotionMarker = "r?.pendingInputReservationId??r?.queryId??";
  const alreadyPatched = runtime.includes(".loadSessionTranscript=async()=>await(await")
    && runtime.includes(".readGoal=async()=>await(await")
    && runtime.includes(".readTodos=async()=>await(await")
    && runtime.includes(".readRuntimeProjection=async()=>")
    && runtime.includes("backgroundTaskDetails")
    && runtime.includes(".readSessionUsage=async()=>await(await")
    && runtime.includes(".cancelBackgroundTask=async")
    && runtime.includes(".previewFileRewind=async e=>")
    && runtime.includes(".applyFileRewind=async e=>")
    && runtime.includes(interruptTurnMarker)
    && runtime.includes(interruptWaitForIdleMarker)
    && runtime.includes(".promoteQueuedInput=async(")
    && runtime.includes(queuedInputPromotionMarker)
    && activeTurnGuidePattern.test(runtime)
    && transcriptMessageIdPattern.test(runtime)
    && transcriptAgentMessageIdPattern.test(runtime)
    && supportsMultiMessageFileRewind(runtime)
    && activeTranscriptPattern.test(runtime)
    && /loadSessionTranscript:[A-Za-z_$][\w$]*\.loadSessionTranscript/u.test(runtime)
    && /readGoal:[A-Za-z_$][\w$]*\.readGoal/u.test(runtime)
    && /readTodos:[A-Za-z_$][\w$]*\.readTodos/u.test(runtime)
    && /readRuntimeProjection:[A-Za-z_$][\w$]*\.readRuntimeProjection/u.test(runtime)
    && /cancelBackgroundTask:[A-Za-z_$][\w$]*\.cancelBackgroundTask/u.test(runtime)
    && /previewFileRewind:[A-Za-z_$][\w$]*\.previewFileRewind/u.test(runtime)
    && /applyFileRewind:[A-Za-z_$][\w$]*\.applyFileRewind/u.test(runtime)
    && /interruptTurn:[A-Za-z_$][\w$]*\.interruptTurn/u.test(runtime)
    && /promoteQueuedInput:[A-Za-z_$][\w$]*\.promoteQueuedInput/u.test(runtime)
    && /readSessionUsage:[A-Za-z_$][\w$]*\.readSessionUsage/u.test(runtime)
    && listSkillsBridgePattern.test(runtime)
    && listSkillsOptionPattern.test(runtime)
    && sessionEventsBridgePattern.test(runtime)
    && sessionEventsOptionPattern.test(runtime)
    && taskMessageBridgePattern.test(runtime)
    && taskMessageOptionPattern.test(runtime)
    && runtime.includes(taskMessageRestartMarker)
    && runtime.includes("$ctxRuntimeUsage")
    && runtime.includes(".loadSessionContextMessages=async()=>await(await")
    && /loadSessionContextMessages:[A-Za-z_$][\w$]*\.loadSessionContextMessages/u.test(runtime);
  if (alreadyPatched) return runtime;

  let patched = runtime;
  if (!activeTurnGuidePattern.test(patched)) {
    if (!activeTurnSteerPattern.test(patched)) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (active-turn steer delivery anchor missing).");
    }
    patched = patched.replace(
      activeTurnSteerPattern,
      '$1delivery:"guide",pendingInputId:$2?.pendingInputId,input:'
    );
  }
  if (!activeTranscriptPattern.test(patched)) {
    const activeFilter = /function ([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{return [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,\{(?:branchCutAfterMessageId:[A-Za-z_$][\w$]*\.revert\?\.branchCutAfterMessageID,)?rewindCreatedMessageId:[A-Za-z_$][\w$]*\.revert\?\.createdMessageID,rewindKeptMessageIds:[A-Za-z_$][\w$]*\.revert\?\.keptMessageIDs,rewindTargetMessageId:[A-Za-z_$][\w$]*\.revert\?\.targetMessageID\}\)\}/u.exec(patched)?.[1];
    const transcriptLoaderPattern = /async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{if\(!\2\.sessionStore\)return\[\];let ([A-Za-z_$][\w$]*)=await \2\.sessionStore\.messages\(\{sessionID:\2\.sessionId\}\);return ([A-Za-z_$][\w$]*)\(\3\)\}/u;
    if (!activeFilter || !transcriptLoaderPattern.test(patched)) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (active transcript anchor missing).");
    }
    patched = patched.replace(
      transcriptLoaderPattern,
      `async function $1($2){if(!$2.sessionStore)return[];let $3=await $2.sessionStore.messages({sessionID:$2.sessionId}),r=await $2.sessionStore.getSession($2.sessionId);return $4(r?${activeFilter}($3,r):$3)}`
    );
  }
  if (!transcriptMessageIdPattern.test(patched)) {
    const userProjectionPattern = /(if\(([A-Za-z_$][\w$]*)\.info\.role==="user"\)\{.{0,400}?)([A-Za-z_$][\w$]*)\.push\(\{content:([A-Za-z_$][\w$]*),role:"user"\}\)(;continue\})/u;
    if (!userProjectionPattern.test(patched)) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (transcript message-id anchor missing).");
    }
    patched = patched.replace(
      userProjectionPattern,
      "$1$3.push({content:$4,messageId:$2.info.id,role:\"user\"})$5"
    );
  }
  if (!transcriptAgentMessageIdPattern.test(patched)) {
    const agentProjectionPattern = /([A-Za-z_$][\w$]*)\.push\(\{content:([A-Za-z_$][\w$]*),\.\.\.([A-Za-z_$][\w$]*)\.length>0\?\{parts:\3\}:\{\},role:"agent"\}\)/u;
    const agentProjection = agentProjectionPattern.exec(patched);
    const functionStart = agentProjection ? patched.lastIndexOf("function ", agentProjection.index) : -1;
    const messageRecord = functionStart >= 0 && agentProjection
      ? /for\(let ([A-Za-z_$][\w$]*) of [A-Za-z_$][\w$]*\)\{/u.exec(
          patched.slice(functionStart, agentProjection.index)
        )?.[1]
      : undefined;
    if (!agentProjection || !messageRecord) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (assistant message-id anchor missing).");
    }
    patched = patched.replace(
      agentProjectionPattern,
      `$1.push({content:$2,...$3.length>0?{parts:$3}:{},messageId:${messageRecord}.info.id,role:"agent"})`
    );
  }
  if (!supportsMultiMessageFileRewind(patched)) {
    const fileRewindTargetPattern = /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(\3\.targetMessageId\)return ([A-Za-z_$][\w$]*)\(\2,\[\3\.targetMessageId\]\);/u;
    if (!fileRewindTargetPattern.test(patched)) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (multi-message file rewind anchor missing).");
    }
    patched = patched.replace(
      fileRewindTargetPattern,
      "function $1($2,$3){if(Array.isArray($3.targetMessageIds)&&$3.targetMessageIds.length>0)return $4($2,$3.targetMessageIds);if($3.targetMessageId)return $4($2,[$3.targetMessageId]);"
    );
  }
  if (!patched.includes('"loadSessionContextMessages"') || !patched.includes('"readSessionUsage"')) {
    const appPattern = /loadSessionTranscript:([A-Za-z_$][\w$]*)\(async\(\)=>await ([A-Za-z_$][\w$]*)\(\{sessionId:([A-Za-z_$][\w$]*)\.sessionId,sessionStore:\3\.sessionStore\}\),"loadSessionTranscript"\)/u;
    const app = appPattern.exec(patched);
    if (!app) throw new Error("ZCode runtime is incompatible with the TUI bridge (session context anchor missing).");
    const [appAssignment, helper, , context] = app;
    const appMethods = [
      !patched.includes('"loadSessionContextMessages"')
        ? `loadSessionContextMessages:${helper}(async()=>await ${context}.sessionStore.messages({sessionID:${context}.sessionId}),"loadSessionContextMessages")`
        : undefined,
      !patched.includes('"readSessionUsage"')
        ? `readSessionUsage:${helper}(async()=>await ${context}.sessionStore.queryTaskUsage?.({sessionID:${context}.sessionId})??null,"readSessionUsage")`
        : undefined
    ].filter(Boolean);
    patched = patched.replace(appAssignment, `${appAssignment},${appMethods.join(",")}`);
  }

  const assignmentPattern = /([A-Za-z_$][\w$]*)\.recallPreviousInput=async ([A-Za-z_$][\w$]*)=>await\(await ([A-Za-z_$][\w$]*)\(\)\)\.recallPreviousInputHistory\?\.\(\2\)\?\?null/u;
  const assignment = assignmentPattern.exec(patched);
  if (!assignment) throw new Error("ZCode runtime is incompatible with the TUI bridge (adapter assignment anchor missing).");

  const [recallAssignment, bridge, , getApp] = assignment;
  const assignments: string[] = [];
  const projectionAssignment = `${bridge}.readRuntimeProjection=async()=>{let e=await ${getApp}(),t=await e.runtime?.getProjection?.();if(!t)return null;let r=Object.values(e.runtime?.runtimeTaskRegistry?.all?.()??{}).filter(o=>o.isBackgrounded===!0).map(o=>({taskId:o.taskId,taskKind:o.taskType??o.type,agentId:o.agentId,agentType:o.agentType,childSessionId:o.childSessionId,parentSessionId:o.parentSessionId,parentToolCallId:o.parentToolCallId,turnId:o.turnId,prompt:o.prompt,error:o.error instanceof Error?o.error.message:typeof o.error==="string"?o.error:void 0,outputPath:o.outputFile,status:o.status,description:o.description,startedAt:o.startedAt,completedAt:o.completedAt}));let $ctxRuntimeUsage=t.contextUsage;try{let o=await e.loadSessionContextMessages?.()??[],n=mda(o);if(n)$ctxRuntimeUsage={...$ctxRuntimeUsage,used:$ctxRuntimeUsage?.used??(t.contextUsed>0?t.contextUsed:n.inputTokens??0),size:$ctxRuntimeUsage?.size??t.contextWindow,cache:{...$ctxRuntimeUsage?.cache,...n}}}catch{}return{...t,...$ctxRuntimeUsage?{contextUsage:$ctxRuntimeUsage}:{},backgroundTaskDetails:r}}`;
  const taskMessageAssignment = `${bridge}.sendBackgroundTaskMessage=async e=>{let t=await ${getApp}(),r=t.runtime,o=r?.runtimeTaskRegistry?.get?.(e?.taskId);if(!r?.subagentPort?.sendMessage)throw new Error("Background agent messaging is unavailable in this runtime.");if(!o||(o.type??o.taskType)!=="local_agent")throw new Error("The selected task is not a local agent.");if(typeof e?.message!=="string"||!e.message.trim())throw new Error("Enter a message for the background agent.");let n=e.message.trim().slice(0,2e4),i=(typeof e.summary==="string"?e.summary:n).replace(/\\s+/g," ").trim().slice(0,200);if(e?.restart===!0&&o.status==="running"){if(!r.subagentPort.stopTask)throw new Error("Background agent restart is unavailable in this runtime.");await r.subagentPort.stopTask(e.taskId),o=r.runtimeTaskRegistry?.get?.(e.taskId);if(!o)throw new Error("The background agent stopped but could not be restored.")}return await r.subagentPort.sendMessage({sessionId:o.parentSessionId??r.getSessionId?.(),turnId:o.turnId??"tui-task-message",parentToolCallId:o.parentToolCallId??"tui-task-message",to:o.agentId??e.taskId,summary:i,message:n,workingDirectory:o.workingDirectory??r.workingDirectory,workspaceRoot:o.workspaceRoot??r.workingDirectory,trace:o.traceContext??r.rootTraceContext})}`;
  if (!listSkillsBridgePattern.test(patched)) {
    const listSkillsFactory = /listSkills:[A-Za-z_$][\w$]*\(\(\)=>([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),"listSkills"\)/u
      .exec(patched);
    if (!listSkillsFactory) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (skill-list adapter anchor missing).");
    }
    assignments.push(`${bridge}.listSkills=async()=>await ${listSkillsFactory[1]}(${listSkillsFactory[2]})`);
  }
  const interruptAssignment = `${bridge}.interruptTurn=async e=>{let t=await ${getApp}(),r=e?.reservationId??"tui-steer-interrupt",o=(Array.isArray(e?.pendingInputIds)?e.pendingInputIds:[]).filter(Boolean),n=[],i=async()=>{for(let a of n)await t.releaseQueueItemReservation?.(a,r);n=[]};try{if(t.reserveQueueItem&&t.releaseQueueItemReservation)for(let a of o)if(await t.reserveQueueItem(a,r))n.push(a);else{await i();break}let a=t.runtime?.stopActiveForegroundExecution?.({preserveQueueAutoDrainOnCancel:o.length>0&&n.length===o.length,reason:e?.reason??"TUI steer interrupt"})??{kind:"unsupported"};if(a.kind==="stopped"&&e?.waitForIdle===!0&&t.runtime?.getActiveForegroundExecutionId){let u=Date.now()+5e3;for(;t.runtime.getActiveForegroundExecutionId()!==void 0;){if(Date.now()>=u)throw new Error("Timed out waiting for background result processing to stop.");await new Promise(l=>setTimeout(l,25))}}return a.kind!=="stopped"&&await i(),a}catch(a){await i();throw a}}`;
  const promotionAssignment = `${bridge}.promoteQueuedInput=async(e,t,r)=>{let o=await ${getApp}(),n=r?.pendingInputReservationId??r?.queryId??r?.inputId??"tui-promotion",i=(Array.isArray(t)?t:[t]).filter(Boolean);if(i.length===0||!o.reserveQueueItem||!o.markQueueItemPromoting||!o.releaseQueueItemReservation||!o.removeQueueItem)return ${bridge}.sendInput(e,{...r,delivery:"start_turn"});let a=[],u=!1;try{for(let l of i){if(await o.markQueueItemPromoting(l,n)){a.push(l);continue}if(!await o.reserveQueueItem(l,n))throw new Error("TUI queued input is already reserved: "+l);a.push(l);if(!await o.markQueueItemPromoting(l,n))throw new Error("TUI queued input promotion failed: "+l)}let c=await ${bridge}.sendInput(e,{...r,delivery:"start_turn"});if(c?.kind==="rejected")return c;u=!0;for(let l of a)if(!await o.removeQueueItem(l,{reason:"promoted",reservationId:n}))throw new Error("TUI queued input promotion commit failed: "+l);return c}finally{if(!u)for(let l of a)await o.releaseQueueItemReservation(l,n)}}`;
  if (!patched.includes(".loadSessionTranscript=async()=>await(await")) {
    assignments.push(`${bridge}.loadSessionTranscript=async()=>await(await ${getApp}()).loadSessionTranscript?.()??[]`);
  }
  if (!patched.includes(".loadSessionContextMessages=async()=>await(await")) {
    assignments.push(`${bridge}.loadSessionContextMessages=async()=>await(await ${getApp}()).loadSessionContextMessages?.()??[]`);
  }
  if (!patched.includes(".readGoal=async()=>await(await")) {
    assignments.push(`${bridge}.readGoal=async()=>await(await ${getApp}()).readTarget?.()??null`);
  }
  if (!patched.includes(".readTodos=async()=>await(await")) {
    assignments.push(`${bridge}.readTodos=async()=>await(await ${getApp}()).readTodos?.()??[]`);
  }
  if (!patched.includes("$ctxRuntimeUsage")) {
    const existingProjectionStart = `${bridge}.readRuntimeProjection=async()=>`;
    const existingProjectionIndex = patched.indexOf(existingProjectionStart);
    if (existingProjectionIndex >= 0) {
      const existingProjectionEnd = patched.indexOf(`,${bridge}.`, existingProjectionIndex + existingProjectionStart.length);
      if (existingProjectionEnd < 0) {
        throw new Error("ZCode runtime is incompatible with the TUI bridge (projection boundary missing).");
      }
      patched = `${patched.slice(0, existingProjectionIndex)}${projectionAssignment}${patched.slice(existingProjectionEnd)}`;
    } else {
      assignments.push(projectionAssignment);
    }
  }
  if (!patched.includes(".readSessionUsage=async()=>await(await")) {
    assignments.push(`${bridge}.readSessionUsage=async()=>await(await ${getApp}()).readSessionUsage?.()??null`);
  }
  if (!patched.includes(".cancelBackgroundTask=async")) {
    assignments.push(`${bridge}.cancelBackgroundTask=async e=>await(await ${getApp}()).cancelBackgroundTask?.(e)??null`);
  }
  if (!patched.includes(".previewFileRewind=async e=>")) {
    assignments.push(`${bridge}.previewFileRewind=async e=>{let t=await ${getApp}();return await t.runtime?.previewWorkspaceFileRewind?.({targetMessageIds:e})??null}`);
  }
  if (!patched.includes(".applyFileRewind=async e=>")) {
    assignments.push(`${bridge}.applyFileRewind=async e=>{let t=await ${getApp}();return await t.runtime?.applyWorkspaceFileRewind?.({targetMessageIds:e})??null}`);
  }
  if (!sessionEventsBridgePattern.test(patched)) {
    assignments.push(`${bridge}.subscribeSessionEvents=e=>{let t=!1,r;${getApp}().then(o=>{t||(r=o.runtime?.subscribeEvents?.({onSessionEvent:e}))});return()=>{t=!0,r?.()}}`);
  }
  if (!taskMessageBridgePattern.test(patched)) {
    assignments.push(taskMessageAssignment);
  } else if (!patched.includes(taskMessageRestartMarker)) {
    const existingTaskMessageStart = patched.indexOf(`${bridge}.sendBackgroundTaskMessage=async e=>`);
    const existingTaskMessageEnd = existingTaskMessageStart < 0
      ? -1
      : patched.indexOf(`,${bridge}.`, existingTaskMessageStart);
    if (existingTaskMessageStart < 0 || existingTaskMessageEnd < 0) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (task-message boundary missing).");
    }
    patched = `${patched.slice(0, existingTaskMessageStart)}${taskMessageAssignment}${patched.slice(existingTaskMessageEnd)}`;
  }
  if (!patched.includes(interruptTurnMarker)) {
    assignments.push(interruptAssignment);
  } else if (!patched.includes(interruptWaitForIdleMarker)) {
    const existingInterruptStart = patched.indexOf(`${bridge}.interruptTurn=async e=>`);
    const existingInterruptEnd = existingInterruptStart < 0
      ? -1
      : patched.indexOf(`,${bridge}.`, existingInterruptStart);
    if (existingInterruptStart < 0 || existingInterruptEnd < 0) {
      throw new Error("ZCode runtime is incompatible with the TUI bridge (interrupt boundary missing).");
    }
    patched = `${patched.slice(0, existingInterruptStart)}${interruptAssignment}${patched.slice(existingInterruptEnd)}`;
  }
  if (!patched.includes(queuedInputPromotionMarker)) {
    const existingPromotionStart = patched.indexOf(`${bridge}.promoteQueuedInput=async(`);
    if (existingPromotionStart >= 0) {
      const existingPromotionEnd = patched.indexOf(`,${bridge}.recallPreviousInput=`, existingPromotionStart);
      if (existingPromotionEnd < 0) {
        throw new Error("ZCode runtime is incompatible with the TUI bridge (queued-input promotion boundary missing).");
      }
      patched = `${patched.slice(0, existingPromotionStart)}${promotionAssignment}${patched.slice(existingPromotionEnd)}`;
    } else {
      assignments.push(promotionAssignment);
    }
  }
  if (assignments.length > 0) {
    patched = patched.replace(recallAssignment, `${assignments.join(",")},${recallAssignment}`);
  }

  const optionsPattern = /recallPreviousInput:([A-Za-z_$][\w$]*)\.recallPreviousInput,sendInput:\1\.sendInput/u;
  const options = optionsPattern.exec(patched);
  if (!options) throw new Error("ZCode runtime is incompatible with the TUI bridge (runTui options anchor missing).");
  const [optionsAssignment, submitBridge] = options;
  const optionFields: string[] = [];
  if (!/loadSessionTranscript:[A-Za-z_$][\w$]*\.loadSessionTranscript/u.test(patched)) {
    optionFields.push(`loadSessionTranscript:${submitBridge}.loadSessionTranscript`);
  }
  if (!/loadSessionContextMessages:[A-Za-z_$][\w$]*\.loadSessionContextMessages/u.test(patched)) {
    optionFields.push(`loadSessionContextMessages:${submitBridge}.loadSessionContextMessages`);
  }
  if (!/readGoal:[A-Za-z_$][\w$]*\.readGoal/u.test(patched)) {
    optionFields.push(`readGoal:${submitBridge}.readGoal`);
  }
  if (!/readTodos:[A-Za-z_$][\w$]*\.readTodos/u.test(patched)) {
    optionFields.push(`readTodos:${submitBridge}.readTodos`);
  }
  if (!/readRuntimeProjection:[A-Za-z_$][\w$]*\.readRuntimeProjection/u.test(patched)) {
    optionFields.push(`readRuntimeProjection:${submitBridge}.readRuntimeProjection`);
  }
  if (!/readSessionUsage:[A-Za-z_$][\w$]*\.readSessionUsage/u.test(patched)) {
    optionFields.push(`readSessionUsage:${submitBridge}.readSessionUsage`);
  }
  if (!/cancelBackgroundTask:[A-Za-z_$][\w$]*\.cancelBackgroundTask/u.test(patched)) {
    optionFields.push(`cancelBackgroundTask:${submitBridge}.cancelBackgroundTask`);
  }
  if (!/previewFileRewind:[A-Za-z_$][\w$]*\.previewFileRewind/u.test(patched)) {
    optionFields.push(`previewFileRewind:${submitBridge}.previewFileRewind`);
  }
  if (!/applyFileRewind:[A-Za-z_$][\w$]*\.applyFileRewind/u.test(patched)) {
    optionFields.push(`applyFileRewind:${submitBridge}.applyFileRewind`);
  }
  if (!/interruptTurn:[A-Za-z_$][\w$]*\.interruptTurn/u.test(patched)) {
    optionFields.push(`interruptTurn:${submitBridge}.interruptTurn`);
  }
  if (!/promoteQueuedInput:[A-Za-z_$][\w$]*\.promoteQueuedInput/u.test(patched)) {
    optionFields.push(`promoteQueuedInput:${submitBridge}.promoteQueuedInput`);
  }
  if (!listSkillsOptionPattern.test(patched)) {
    optionFields.push(`listSkills:${submitBridge}.listSkills`);
  }
  if (!sessionEventsOptionPattern.test(patched)) {
    optionFields.push(`subscribeSessionEvents:${submitBridge}.subscribeSessionEvents`);
  }
  if (!taskMessageOptionPattern.test(patched)) {
    optionFields.push(`sendBackgroundTaskMessage:${submitBridge}.sendBackgroundTaskMessage`);
  }
  if (optionFields.length > 0) {
    patched = patched.replace(optionsAssignment, `${optionFields.join(",")},${optionsAssignment}`);
  }
  return patched;
}

export function patchRuntimeOAuthHttpErrors(runtime: string): string {
  if (runtime.includes("empty or non-JSON response")) return runtime;
  if (!runtime.includes('"OAuth response is not valid JSON",{httpStatus:void 0}')) return runtime;

  const parserPattern = /function ([A-Za-z_$][\w$]*)\(e\)\{try\{return JSON\.parse\(e\)\}catch\{throw new ([A-Za-z_$][\w$]*)\("OAuth response is not valid JSON",\{httpStatus:void 0\}\)\}\}/u;
  const parser = parserPattern.exec(runtime);
  if (!parser) {
    throw new Error("ZCode runtime is incompatible with the OAuth HTTP error patch (parser anchor missing).");
  }
  const [, parserName, errorName] = parser;
  const decoderPattern = new RegExp(
    `([A-Za-z_$][\\w$]*)=new TextDecoder\\(\\)\\.decode\\(([A-Za-z_$][\\w$]*)\\.body\\),([A-Za-z_$][\\w$]*)=${parserName}\\(\\1\\)`,
    "u"
  );
  const decoder = decoderPattern.exec(runtime);
  if (!decoder) {
    throw new Error("ZCode runtime is incompatible with the OAuth HTTP error patch (status anchor missing).");
  }
  const [, bodyName, responseName, parsedName] = decoder;
  const withStatus = runtime.replace(
    decoder[0],
    `${bodyName}=new TextDecoder().decode(${responseName}.body),${parsedName}=${parserName}(${bodyName},${responseName}.status)`
  );
  return withStatus.replace(
    parser[0],
    `function ${parserName}(e,t){try{return JSON.parse(e)}catch{let r=typeof t=="number"&&(t<200||t>=300)?\`OAuth HTTP error \${t} (empty or non-JSON response)\`:"OAuth response is not valid JSON";throw new ${errorName}(r,{httpStatus:t})}}`
  );
}

export function patchRuntimeZaiDesktopOAuth(runtime: string): string {
  if (runtime.includes('ZCODE_CLI_OAUTH_CALLBACK_STDIN==="1"')) return runtime;

  const credentialMarker = ".saveZaiLoginCredentials({accessToken:";
  const markerIndex = runtime.indexOf(credentialMarker);
  if (markerIndex < 0) {
    throw new Error("ZCode runtime is incompatible with the Desktop OAuth patch (credential anchor missing).");
  }
  const functionStart = runtime.lastIndexOf("async function ", markerIndex);
  const nextFunction = runtime.indexOf("async function ", markerIndex + credentialMarker.length);
  if (functionStart < 0 || nextFunction < 0) {
    throw new Error("ZCode runtime is incompatible with the Desktop OAuth patch (function anchor missing).");
  }
  const originalFunction = runtime.slice(functionStart, nextFunction);
  const prefix = /^async function ([A-Za-z_$][\w$]*)\(e=\{\}\)\{/u.exec(originalFunction);
  const abortHelper = /;([A-Za-z_$][\w$]*)\(e\.abortSignal\);let/u.exec(originalFunction)?.[1];
  const credentialStore = /e\.credentialStore\?\?([A-Za-z_$][\w$]*)\(\{env:[A-Za-z_$][\w$]*\}\)/u.exec(originalFunction)?.[1];
  const loginError = /new ([A-Za-z_$][\w$]*)\("credential_write_failed"/u.exec(originalFunction)?.[1];
  const apiKeyResolver = /await ([A-Za-z_$][\w$]*)\(\{accessToken:[^,]+,env:[^,]+,httpClient:e\.httpClient,providerId:"zai"/u.exec(originalFunction)?.[1];
  const configWriter = /await ([A-Za-z_$][\w$]*)\(\{apiKey:[^,]+,filePath:e\.userConfigPath,providerId:"zai"\}\)/u.exec(originalFunction)?.[1];
  const httpClientFactory = /e\.httpClient\?\?([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\),[A-Za-z_$][\w$]*=e\.state\?\?/u.exec(runtime)?.[1];
  if (!prefix || !abortHelper || !credentialStore || !loginError
    || !apiKeyResolver || !configWriter || !httpClientFactory) {
    throw new Error("ZCode runtime is incompatible with the Desktop OAuth patch (dependency anchor missing).");
  }

  const branch = [
    'if((e.env??process.env).ZCODE_CLI_OAUTH_CALLBACK_STDIN==="1"){',
    "let $zEnv=e.env??process.env;",
    `${abortHelper}(e.abortSignal);`,
    `let $zStore=e.credentialStore??${credentialStore}({env:$zEnv}),$zHttp=e.httpClient??${httpClientFactory}($zEnv),$zPayload;`,
    `try{$zPayload=JSON.parse(require("node:fs").readFileSync(0,"utf8"))}catch($zError){throw new ${loginError}("invalid_callback","Unable to read the Z.AI OAuth callback.",{cause:$zError})}`,
    `if(!$zPayload||typeof $zPayload.callbackUrl!=="string"||typeof $zPayload.state!=="string")throw new ${loginError}("invalid_callback","The Z.AI OAuth callback payload is invalid.");`,
    "let $zUrl;",
    `try{$zUrl=new URL($zPayload.callbackUrl)}catch($zError){throw new ${loginError}("invalid_callback","The Z.AI OAuth callback URL is invalid.",{cause:$zError})}`,
    `if($zUrl.protocol!=="zcode:"||$zUrl.hostname!=="zai-auth"||$zUrl.pathname.replace(/\\/+$/u,"")!=="/callback")throw new ${loginError}("invalid_callback","The Z.AI OAuth callback target is invalid.");`,
    "let $zCode=$zUrl.searchParams.get(\"code\")??$zUrl.searchParams.get(\"authCode\"),$zState=$zUrl.searchParams.get(\"state\");",
    `if(!$zCode||!$zState||$zState!==$zPayload.state)throw new ${loginError}("invalid_callback","The Z.AI OAuth callback state is invalid or expired.");`,
    "let $zResponse=await $zHttp.request({maxResponseBytes:65536,body:new TextEncoder().encode(JSON.stringify({provider:\"zai\",code:$zCode,redirect_uri:\"zcode://zai-auth/callback\",state:$zState})),headers:{\"Content-Type\":\"application/json\"},method:\"POST\",trace:e.trace,url:\"https://zcode.z.ai/api/v1/oauth/token\"},e.abortSignal),$zText=new TextDecoder().decode($zResponse.body),$zEnvelope;",
    `try{$zEnvelope=JSON.parse($zText)}catch($zError){throw new ${loginError}("token_exchange_failed",$zResponse.status<200||$zResponse.status>=300?"OAuth HTTP error "+$zResponse.status+" (empty or non-JSON response)":"OAuth response is not valid JSON",{cause:$zError})}`,
    "let $zMessage=typeof $zEnvelope?.msg===\"string\"&&$zEnvelope.msg.trim()?$zEnvelope.msg.trim():void 0;",
    `if($zResponse.status<200||$zResponse.status>=300)throw new ${loginError}("token_exchange_failed",$zMessage??"OAuth HTTP error "+$zResponse.status);`,
    `if($zEnvelope?.code!==0)throw new ${loginError}("token_exchange_failed",$zMessage??"Z.AI token exchange failed.");`,
    "let $zData=$zEnvelope.data,$zAccessToken=$zData?.zai?.access_token,$zJwtToken=$zData?.token,$zUser=$zData?.user;",
    `if(typeof $zAccessToken!=="string"||typeof $zJwtToken!=="string"||!$zUser||typeof $zUser!=="object")throw new ${loginError}("token_exchange_failed","Z.AI token response is missing credentials or user data.");`,
    `${abortHelper}(e.abortSignal);`,
    `try{await $zStore.saveZaiLoginCredentials({accessToken:$zAccessToken,jwtToken:$zJwtToken,user:$zUser})}catch($zError){throw new ${loginError}("credential_write_failed","Login succeeded but writing credentials failed.",{cause:$zError})}`,
    `let $zApiKey=await ${apiKeyResolver}({accessToken:$zAccessToken,env:$zEnv,httpClient:$zHttp,providerId:"zai",resolver:e.apiKeyResolver}),$zConfig;`,
    `try{$zConfig=await ${configWriter}({apiKey:$zApiKey,filePath:e.userConfigPath,providerId:"zai"})}catch($zError){throw new ${loginError}("config_update_failed","Login succeeded but updating ZCode config failed.",{cause:$zError})}`,
    'return{configPath:$zConfig.path,credentialsPath:$zStore.filePath,model:$zConfig.mainModel,providerId:"zai",user:$zUser}',
    "}"
  ].join("");
  const insertionPoint = functionStart + prefix[0].length;
  return `${runtime.slice(0, insertionPoint)}${branch}${runtime.slice(insertionPoint)}`;
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, { ...init, redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return response.text();
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  const writer = Bun.file(destination).writer({ highWaterMark: 1024 * 1024 });
  try {
    for await (const chunk of response.body) {
      await writer.write(chunk);
    }
  } finally {
    await writer.end();
  }
}

async function sha512Base64(path: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("base64");
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; capture?: boolean } = {}
): Promise<string> {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    stdin: "inherit",
    stdout: options.capture ? "pipe" : "inherit",
    stderr: "inherit"
  });
  const stdoutPromise = options.capture
    ? new Response(child.stdout as ReadableStream<Uint8Array>).text()
    : Promise.resolve("");
  const [code, stdout] = await Promise.all([child.exited, stdoutPromise]);
  if (code !== 0) throw new Error(`${command} exited with status ${code}`);
  return stdout.trim();
}

async function installLocalTui(nextVendor: string): Promise<void> {
  const source = join(root, "packages", "zcode-tui");
  const entry = join(source, "dist", "index.js");
  if (!existsSync(entry)) {
    throw new Error("Local @zcode/tui is not built; run `bun run build:tui` first.");
  }
  const target = join(nextVendor, "node_modules", "@zcode", "tui");
  await mkdir(target, { recursive: true });
  await cp(join(source, "package.json"), join(target, "package.json"));
  await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
}

/** Align Coding Plan defaults without depending on platform-specific minifier names. */
export function patchRuntimeLoginModelDefaults(runtime: string): string {
  const presetPattern = /([A-Za-z_$][\w$]*)="zai\/glm-(?:5\.1|5\.2)",([A-Za-z_$][\w$]*)="zai\/glm-(?:4\.7|5-turbo)",([A-Za-z_$][\w$]*)="bigmodel\/glm-(?:5\.1|5\.2)",([A-Za-z_$][\w$]*)="bigmodel\/glm-4\.7"/u;
  const modelIdPattern = /([A-Za-z_$][\w$]*)="glm-(?:5\.1|5\.2)",([A-Za-z_$][\w$]*)="glm-(?:4\.7|5-turbo)"/u;
  const modelEntriesPattern = /models:\{\.\.\.([A-Za-z_$][\w$]*),\[([A-Za-z_$][\w$]*)\]:\{\.\.\.([A-Za-z_$][\w$]*),name:"GLM-5\.(?:1|2)"\},\[([A-Za-z_$][\w$]*)\]:\{\.\.\.([A-Za-z_$][\w$]*),name:"GLM-(?:4\.7|5-Turbo)"\}(?:,\["glm-5-turbo"\]:\{\.\.\.\1\["glm-5-turbo"\],name:"GLM-5-Turbo"\})?\}/u;
  const legacyLiteSelectionPattern = /([A-Za-z_$][\w$]*)=typeof ([A-Za-z_$][\w$]*)\.lite=="string"\?\2\.lite:([A-Za-z_$][\w$]*)\.liteModel/u;
  const scopedLiteSelectionPattern = /([A-Za-z_$][\w$]*)=typeof ([A-Za-z_$][\w$]*)\.lite=="string"&&\2\.lite\.startsWith\(([A-Za-z_$][\w$]*)\.mainModel\.slice\(0,\3\.mainModel\.indexOf\("\/"\)\+1\)\)\?\2\.lite:\3\.liteModel/u;

  const preset = presetPattern.exec(runtime);
  const modelIds = modelIdPattern.exec(runtime);
  const modelEntries = modelEntriesPattern.exec(runtime);
  if (!preset || !modelIds || !modelEntries
    || modelIds[1] !== modelEntries[2]
    || modelIds[2] !== modelEntries[4]) {
    throw new Error("ZCode runtime is incompatible with the login model defaults patch (model preset/catalog anchors missing).");
  }

  let patched = runtime
    .replace(
      preset[0],
      `${preset[1]}="zai/glm-5.2",${preset[2]}="zai/glm-5-turbo",${preset[3]}="bigmodel/glm-5.2",${preset[4]}="bigmodel/glm-4.7"`
    )
    .replace(modelIds[0], `${modelIds[1]}="glm-5.2",${modelIds[2]}="glm-4.7"`)
    .replace(
      modelEntries[0],
      `models:{...${modelEntries[1]},[${modelEntries[2]}]:{...${modelEntries[3]},name:"GLM-5.2"},[${modelEntries[4]}]:{...${modelEntries[5]},name:"GLM-4.7"},["glm-5-turbo"]:{...${modelEntries[1]}["glm-5-turbo"],name:"GLM-5-Turbo"}}`
    );

  const legacyLiteSelection = legacyLiteSelectionPattern.exec(patched);
  if (legacyLiteSelection) {
    const [, selection, model, selectedPreset] = legacyLiteSelection;
    patched = patched.replace(
      legacyLiteSelection[0],
      `${selection}=typeof ${model}.lite=="string"&&${model}.lite.startsWith(${selectedPreset}.mainModel.slice(0,${selectedPreset}.mainModel.indexOf("/")+1))?${model}.lite:${selectedPreset}.liteModel`
    );
  } else if (!scopedLiteSelectionPattern.test(patched)) {
    throw new Error("ZCode runtime is incompatible with the login model defaults patch (lite model anchor missing).");
  }
  return patched;
}

export function patchRuntimeContextCacheFromParts(runtime: string): string {
  const aggregateAnchor =
    'function mda(e){let t=0,r=0,o=0,n=0,i=0,a=0,u=0;for(let l of e){if(l.info.role!=="assistant"||l.info.summary)continue;let c=zRe(l.info.tokens.input)??0,d=zRe(l.info.tokens.cache.read)??0,p=zRe(l.info.tokens.cache.write)??0;c<=0&&d<=0&&p<=0||';
  const projectionAnchor =
    "function LRe(e){let t=dda(e.messages,e.projection.contextWindow);return ada(cda(e.projection,t?.used===e.projection.contextUsed?t.cache:void 0)??t,sda(e.persistedContextUsageBreakdownEvents??[]))}";
  let patched = runtime;
  if (!patched.includes("$ctxPartTokens")) {
    const anchorIndex = patched.indexOf(aggregateAnchor);
    if (anchorIndex < 0) {
      throw new Error("ZCode runtime is incompatible with the context-cache patch (aggregator anchor missing).");
    }
    const fallbackHelper = [
      "let $ctxPartTokens=function(l){",
      'let f=Array.isArray(l.parts)?l.parts.filter(function(x){return x&&x.type==="step-finish"&&x.tokens}):[];',
      "for(let k=f.length-1;k>=0;k-=1){",
      "let g=f[k].tokens||{},h=zRe(g.input)??0,y=zRe(g.cache&&g.cache.read)??0,w=zRe(g.cache&&g.cache.write)??0;",
      "if(h>0||y>0||w>0)return{input:h,cache:{read:y,write:w}};}",
      "return null};",
      "let $ctxMsgTokens=function(l){let q=l.info.tokens;return q&&typeof q==\"object\"?{input:zRe(q.input)??0,cache:{read:zRe(q.cache&&q.cache.read)??0,write:zRe(q.cache&&q.cache.write)??0}}:{input:0,cache:{read:0,write:0}}};"
    ].join("");
    const replacement = `function mda(e){${fallbackHelper}let t=0,r=0,o=0,n=0,i=0,a=0,u=0;for(let l of e){if(l.info.role!=="assistant"||l.info.summary)continue;let v=$ctxPartTokens(l),m=$ctxMsgTokens(l);let c=m.input,d=m.cache.read,p=m.cache.write;if((c<=0&&d<=0&&p<=0)&&v){c=v.input;d=v.cache.read;p=v.cache.write}c<=0&&d<=0&&p<=0||`;
    patched = patched.slice(0, anchorIndex) + replacement + patched.slice(anchorIndex + aggregateAnchor.length);
  }
  if (!patched.includes("$ctxCache")) {
    if (!patched.includes(projectionAnchor)) {
      throw new Error("ZCode runtime is incompatible with the context-cache patch (projection anchor missing).");
    }
    patched = patched.replace(
      projectionAnchor,
      "function LRe(e){let t=dda(e.messages,e.projection.contextWindow),$ctxCache=t?.cache??mda(e.messages);return ada(cda(e.projection,$ctxCache)??t,sda(e.persistedContextUsageBreakdownEvents??[]))}"
    );
  }
  return patched;
}

async function installTuiBridge(nextVendor: string): Promise<void> {
  const runtimePath = join(nextVendor, "zcode.cjs");
  const runtime = await readFile(runtimePath, "utf8");
  await writeFile(
    runtimePath,
    patchRuntimeContextCacheFromParts(
      patchRuntimeLoginModelDefaults(
        patchRuntimeZaiDesktopOAuth(
          patchRuntimeOAuthHttpErrors(
            patchRuntimeAgentAutoBackground(
              patchRuntimeDetachedAgentLifecycle(
                patchRuntimeTerminalToolProjection(
                  patchRuntimeGoalFailurePause(
                    patchRuntimeBackgroundTaskProjection(patchRuntimeTuiBridge(runtime))
                  )
                )
              )
            )
          )
        )
      )
    )
  );
}

async function findFile(directory: string, name: string): Promise<string | null> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const match = await findFile(path, name);
      if (match) return match;
    }
  }
  return null;
}

async function extractWith7Zip(
  archive: string,
  output: string,
  platform: SyncOptions["platform"]
): Promise<string> {
  const first = join(output, "stage-1");
  await mkdir(first, { recursive: true });
  await run("7z", ["x", archive, `-o${first}`, "-y"]);

  if (platform === "linux") {
    const compressedTar = await findFile(first, "data.tar.xz");
    if (!compressedTar) throw new Error("Linux package does not contain data.tar.xz.");
    const second = join(output, "stage-2");
    const third = join(output, "root");
    await mkdir(second, { recursive: true });
    await mkdir(third, { recursive: true });
    await run("7z", ["x", compressedTar, `-o${second}`, "-y"]);
    const tar = await findFile(second, "data.tar");
    if (!tar) throw new Error("Could not unpack data.tar.xz.");
    await run("7z", ["x", tar, `-o${third}`, "-y"]);
    return third;
  }

  if (platform === "win32") {
    const appArchive = await findFile(first, "app-64.7z");
    if (!appArchive) throw new Error("Windows installer does not contain app-64.7z.");
    const second = join(output, "root");
    await mkdir(second, { recursive: true });
    await run("7z", ["x", appArchive, `-o${second}`, "-y"]);
    return second;
  }

  return first;
}

async function getLocalAppVersion(app: string): Promise<string> {
  if (process.platform !== "darwin") throw new Error("--app version discovery currently requires macOS.");
  return run(
    "plutil",
    ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(app, "Contents", "Info.plist")],
    { capture: true }
  );
}

async function resolveLockedSource(lock: RuntimeLock, temporaryDirectory: string): Promise<RuntimeSource> {
  const archiveName = basename(new URL(lock.url).pathname) || "zcode-installer";
  const archive = join(temporaryDirectory, archiveName);
  console.log(`Downloading ${lock.url}`);
  await download(lock.url, archive);
  const actualHash = await sha512Base64(archive);
  if (actualHash !== lock.sha512) throw new Error("Downloaded installer failed locked SHA-512 verification.");
  const extracted = await extractWith7Zip(archive, join(temporaryDirectory, "extract"), lock.platform);
  const runtime = await findFile(extracted, "zcode.cjs");
  if (!runtime || basename(dirname(runtime)) !== "glm") {
    throw new Error("Could not locate resources/glm/zcode.cjs.");
  }
  return {
    appVersion: lock.appVersion,
    glm: dirname(runtime),
    lock,
    source: lock.url
  };
}

async function resolveSource(options: SyncOptions, temporaryDirectory: string): Promise<RuntimeSource> {
  if (options.app) {
    const app = resolve(options.app);
    const glm = join(app, "Contents", "Resources", "glm");
    if (!existsSync(join(glm, "zcode.cjs"))) throw new Error(`No ZCode runtime found in ${app}`);
    return {
      appVersion: options.version ?? await getLocalAppVersion(app),
      glm,
      source: app
    };
  }

  if (options.lock) {
    const lockPath = resolve(root, options.lock);
    const lock = parseRuntimeLock(JSON.parse(await readFile(lockPath, "utf8")));
    return resolveLockedSource(lock, temporaryDirectory);
  }

  const resolved = await resolveLatestRuntimeLock(options);
  const candidate = resolved.lock;
  console.log(
    `Resolved stable ZCode App ${candidate.appVersion} from the ${resolved.source} manifest ${resolved.url}.`
  );
  const currentLockPath = join(root, "zcode-runtime.lock.json");
  const current = existsSync(currentLockPath)
    ? parseRuntimeLock(JSON.parse(await readFile(currentLockPath, "utf8")))
    : undefined;
  const lock = selectRuntimeLock(candidate, current);
  if (lock === current) {
    console.log(
      `Keeping locked runtime ${current.appVersion}; the ${options.platform}-${options.arch} manifest reports older ${candidate.appVersion}.`
    );
  }
  return resolveLockedSource(lock, temporaryDirectory);
}

async function sync(options: SyncOptions): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "zcode-cli-sync-"));
  const nextVendor = join(root, ".vendor-next");
  try {
    const source = await resolveSource(options, temporaryDirectory);
    await rm(nextVendor, { recursive: true, force: true });
    await cp(source.glm, nextVendor, { recursive: true });
    await installTuiBridge(nextVendor);
    await installLocalTui(nextVendor);
    const node = process.env.ZCODE_NODE || Bun.which("node");
    if (!node) throw new Error("Node.js >=22.19 is required to validate the official ZCode runtime.");
    const cliVersion = await run(node, [join(nextVendor, "zcode.cjs"), "--version"], { capture: true });
    await writeFile(join(nextVendor, "extraction.json"), `${JSON.stringify({
      appVersion: source.appVersion,
      cliVersion,
      extractedAt: new Date().toISOString(),
      ...(source.lock ? { sha512: source.lock.sha512 } : {}),
      source: source.source,
      tui: {
        implementation: "@zcode/tui",
        foundation: "@earendil-works/pi-tui"
      }
    }, null, 2)}\n`);

    const packagePath = join(root, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
    const packageVersion = syncedReleaseVersion(source.appVersion, String(packageJson.version ?? ""));
    packageJson.version = packageVersion;
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    if (source.lock) {
      await writeFile(join(root, "zcode-runtime.lock.json"), `${JSON.stringify(source.lock, null, 2)}\n`);
    }
    await rm(join(root, "vendor"), { recursive: true, force: true });
    await rename(nextVendor, join(root, "vendor"));
    console.log(`Prepared ${String(packageJson.name)}@${packageVersion} with ${cliVersion}.`);
  } finally {
    await rm(nextVendor, { recursive: true, force: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await sync(parseArgs(process.argv.slice(2)));
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
