#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import {
  type RuntimeCapabilities,
  type RuntimeCliOptionCapability
} from "../src/runtime-capabilities.ts";
import { parseReleaseVersion, syncedReleaseVersion } from "./release-version.ts";

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

export type RuntimePatchRequirement = "required" | "optional";
export type RuntimePatchStatus = "applied" | "already_present" | "skipped" | "failed";

export interface RuntimePatchReport {
  id: string;
  requirement: RuntimePatchRequirement;
  status: RuntimePatchStatus;
  message?: string;
}

export interface RuntimePatchDefinition {
  id: string;
  requirement: RuntimePatchRequirement;
  apply: (runtime: string) => string;
  verify?: (runtime: string) => boolean;
}

export function parseRuntimePatchReports(value: unknown): RuntimePatchReport[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reports: RuntimePatchReport[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const report = item as Record<string, unknown>;
    if (typeof report.id !== "string" || !report.id || ids.has(report.id)) return undefined;
    if (report.requirement !== "required" && report.requirement !== "optional") return undefined;
    if (report.status !== "applied" && report.status !== "already_present"
      && report.status !== "skipped" && report.status !== "failed") return undefined;
    if (report.message !== undefined && typeof report.message !== "string") return undefined;
    ids.add(report.id);
    reports.push({
      id: report.id,
      requirement: report.requirement,
      status: report.status,
      ...(typeof report.message === "string" ? { message: report.message } : {})
    });
  }
  return reports;
}

export interface RuntimeCompatibilityFailure {
  schemaVersion: 1;
  appVersion?: string;
  generatedAt: string;
  phase: "release_validation" | "runtime_discovery" | "runtime_patch" | "runtime_sync";
  error: string;
  runtimePatches: readonly RuntimePatchReport[];
}

export class RuntimePatchError extends Error {
  readonly reports: RuntimePatchReport[];

  constructor(patch: RuntimePatchDefinition, cause: unknown, reports: RuntimePatchReport[]) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Required runtime patch ${patch.id} failed: ${detail}`, { cause });
    this.name = "RuntimePatchError";
    this.reports = reports;
  }
}

function markdownCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, " ");
}

export function formatRuntimeCompatibilityFailure(report: RuntimeCompatibilityFailure): string {
  const lines = [
    "## Upstream runtime compatibility failure",
    "",
    `- App version: \`${report.appVersion ?? "unknown"}\``,
    `- Phase: \`${report.phase}\``,
    `- Detected at: \`${report.generatedAt}\``,
    "",
    "```text",
    report.error.replace(/```/gu, "'''"),
    "```"
  ];
  if (report.runtimePatches.length > 0) {
    lines.push(
      "",
      "| Patch | Requirement | Status | Detail |",
      "| --- | --- | --- | --- |",
      ...report.runtimePatches.map((patch) => [
        markdownCell(patch.id),
        patch.requirement,
        patch.status,
        markdownCell(patch.message ?? "")
      ].join(" | ").replace(/^/u, "| ").replace(/$/u, " |"))
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function writeRuntimeCompatibilityFailure(
  report: RuntimeCompatibilityFailure,
  directory = join(root, ".release")
): Promise<{ jsonPath: string; markdownPath: string }> {
  const jsonPath = join(directory, "runtime-compatibility.json");
  const markdownPath = join(directory, "runtime-compatibility.md");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    writeFile(markdownPath, formatRuntimeCompatibilityFailure(report))
  ]);
  return { jsonPath, markdownPath };
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

export function extractRuntimeCapabilities(runtime: string): RuntimeCapabilities {
  const parserEnd = runtime.indexOf('strict:!0}),"parseGlobalArgs"');
  const parserStart = parserEnd < 0 ? -1 : runtime.lastIndexOf("options:{", parserEnd);
  if (parserStart < 0 || parserEnd < 0) {
    throw new Error("ZCode runtime is incompatible with CLI capability extraction (global parser anchor missing).");
  }

  const optionsSource = runtime.slice(parserStart + "options:{".length, parserEnd);
  const globalOptions: Record<string, RuntimeCliOptionCapability> = {};
  const optionPattern = /(?:^|,)(?:"([^"]+)"|([A-Za-z_$][\w$]*)):\{([^{}]*)\}/gu;
  for (const match of optionsSource.matchAll(optionPattern)) {
    const name = match[1] ?? match[2];
    const type = /(?:^|,)type:"(boolean|string)"(?:,|$)/u.exec(match[3]!)?.[1];
    if (!name || (type !== "boolean" && type !== "string")) continue;
    globalOptions[name] = {
      type,
      ...(/(?:^|,)multiple:!0(?:,|$)/u.test(match[3]!) ? { multiple: true } : {})
    };
  }
  if (!globalOptions.help || !globalOptions.version || !globalOptions.prompt) {
    throw new Error("ZCode runtime is incompatible with CLI capability extraction (global options incomplete).");
  }
  return { schemaVersion: 1, cli: { globalOptions } };
}

const legacyHeadlessOptions = [
  "settings",
  "permission-mode",
  "max-turns",
  "allowed-tools",
  "allow-main-worktree-yolo"
] as const;

function cliHelpOptionLine(option: string): RegExp {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^  --${escaped}(?:[ \\t]|$)[^\\n]*\\n`, "gmu");
}

export function hasRuntimeCliHelpContract(runtime: string): boolean {
  const supported = extractRuntimeCapabilities(runtime).cli.globalOptions;
  return legacyHeadlessOptions.every((option) => supported[option] || !cliHelpOptionLine(option).test(runtime));
}

/** Hide compatibility options that the strict global parser cannot enforce. */
export function patchRuntimeCliHelpContract(runtime: string): string {
  const supported = extractRuntimeCapabilities(runtime).cli.globalOptions;
  let patched = runtime;
  for (const option of legacyHeadlessOptions) {
    if (!supported[option]) patched = patched.replace(cliHelpOptionLine(option), "");
  }
  return patched;
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

export function patchRuntimeTuiBridge(runtime: string): string {
  const transcriptMessageIdPattern = /\.push\(\{content:[A-Za-z_$][\w$]*,messageId:[A-Za-z_$][\w$]*\.info\.id,role:"user"\}\)/u;
  const transcriptAgentMessageIdPattern = /messageId:[A-Za-z_$][\w$]*\.info\.id,role:"agent"/u;
  const activeTranscriptPattern = /sessionStore\.messages\(\{sessionID:([A-Za-z_$][\w$]*)\.sessionId\}\),[A-Za-z_$][\w$]*=await \1\.sessionStore\.getSession\(\1\.sessionId\);return/u;
  const activeTurnSteerPattern = /(\.steerTurn\(\{commandKind:([A-Za-z_$][\w$]*)\?\.commandKind,inputId:\2\?\.inputId,queryId:\2\?\.queryId,expectedTurnId:\2\?\.expectedTurnId,)(?:delivery:"guide",)?(?:pendingInputId:\2\?\.pendingInputId,)?input:/u;
  const activeTurnGuidePattern = /\.steerTurn\(\{commandKind:([A-Za-z_$][\w$]*)\?\.commandKind,inputId:\1\?\.inputId,queryId:\1\?\.queryId,expectedTurnId:\1\?\.expectedTurnId,delivery:"guide",pendingInputId:\1\?\.pendingInputId,input:/u;
  const nativeActiveTurnSteerPattern = /([A-Za-z_$][\w$]*)\?\.delivery==="steer_active_turn".{0,700}?\.steerTurn\(\{commandKind:\1\?\.commandKind,delivery:[^,}]+,expectedTurnId:\1\?\.expectedTurnId,input:[^,}]+,inputId:\1\?\.inputId,intent:.{1,160}?,queryId:\1\?\.queryId,/u;
  const nativePromptAdmissionPattern = /\.runtime\.admitPrompt\([^{}]{0,500}\{\.\.\.([A-Za-z_$][\w$]*),delivery:[A-Za-z_$][\w$]*,traceContext:\1\?\.traceContext/u;
  const legacyStartedTurnResultPattern = /return ([A-Za-z_$][\w$]*)\.kind!=="started_turn"\?\1:([A-Za-z_$][\w$]*)\(\1\.result,([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\)/u;
  const supportsActiveTurnSteer = (value: string): boolean => (
    activeTurnGuidePattern.test(value)
    || (nativeActiveTurnSteerPattern.test(value) && nativePromptAdmissionPattern.test(value))
  );
  const listSkillsBridgePattern = /\.listSkills=async\(\)=>await [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)/u;
  const listSkillsOptionPattern = /listSkills:[A-Za-z_$][\w$]*\.listSkills/u;
  const listModelOptionsOptionPattern = /listModelOptions:[A-Za-z_$][\w$]*\.listModelOptions/u;
  const sessionEventsBridgePattern = /\.subscribeSessionEvents=[A-Za-z_$][\w$]*=>/u;
  const sessionEventsOptionPattern = /subscribeSessionEvents:[A-Za-z_$][\w$]*\.subscribeSessionEvents/u;
  const taskMessageBridgePattern = /\.sendBackgroundTaskMessage=async [A-Za-z_$][\w$]*=>/u;
  const taskMessageOptionPattern = /sendBackgroundTaskMessage:[A-Za-z_$][\w$]*\.sendBackgroundTaskMessage/u;
  const taskMessageRestartMarker = "e?.restart===!0";
  const backgroundRestoreMarker = ".$zRestorePersistedBackgroundTasks=async $zApp=>";
  const backgroundTasksMergeMarker = "for(let $zDetail of r)";
  const backgroundRestoreSourceMarker = "$zApp.loadSessionTranscript?.()";
  const backgroundRestoreRetryMarker = "catch{$zApp.$zRestoredBackgroundTasksSession=void 0}";
  const backgroundRestoreLogMarker = ".$zRestoredBackgroundTasksLog=[]";
  const backgroundTasksRestoredFieldMarker = "restoredBackgroundTasks:Array.isArray(";
  const backgroundRestoreModelTextMarker = 'childSessionId:"sess_subagent_"+$zAgentId';
  const backgroundRestoreAsyncModelTextMarker = '$zOutput.includes("Async agent launched successfully.")';
  const backgroundRestoreReminderMarker = '.addAttachment?.("task_status"';
  const backgroundRestoreMetadataErrorMarker = "error:typeof $zMetadata.error";
  const backgroundRestoreBeforeSendMarker = ".$zSendInputWithoutBackgroundRestore=";
  const backgroundTasksReplaceMarker = "s[$zIndex]={...s[$zIndex]";
  const taskMessageRestoreMarker = ".$zRestorePersistedBackgroundTasks?.(t)";
  const interruptTurnMarker = ".interruptTurn=async e=>";
  const interruptWaitForIdleMarker = "e?.waitForIdle===!0";
  const queuedInputPromotionMarker = "r?.pendingInputReservationId??r?.queryId??";
  const projectionBridgeMarker = ".readRuntimeProjection=async()=>{let $zRuntimeProjectionBridge=await ";
  const modeBridgePattern = /\.setMode=async/u;
  const modeOptionPattern = /setMode:[A-Za-z_$][\w$]*\.setMode/u;
  const transientModelBridgePattern = /\.setTransientModel=async/u;
  const transientModelOptionPattern = /setTransientModel:[A-Za-z_$][\w$]*\.setTransientModel/u;
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
    && !legacyStartedTurnResultPattern.test(runtime)
    && supportsActiveTurnSteer(runtime)
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
    && listModelOptionsOptionPattern.test(runtime)
    && modeBridgePattern.test(runtime)
    && modeOptionPattern.test(runtime)
    && transientModelBridgePattern.test(runtime)
    && transientModelOptionPattern.test(runtime)
    && sessionEventsBridgePattern.test(runtime)
    && sessionEventsOptionPattern.test(runtime)
    && taskMessageBridgePattern.test(runtime)
    && taskMessageOptionPattern.test(runtime)
    && runtime.includes(taskMessageRestartMarker)
    && runtime.includes(projectionBridgeMarker)
    && runtime.includes(backgroundRestoreMarker)
    && runtime.includes(backgroundTasksMergeMarker)
    && runtime.includes(backgroundRestoreSourceMarker)
    && runtime.includes(backgroundRestoreRetryMarker)
    && runtime.includes(backgroundRestoreLogMarker)
    && runtime.includes(backgroundTasksRestoredFieldMarker)
    && runtime.includes(backgroundRestoreModelTextMarker)
    && runtime.includes(backgroundRestoreAsyncModelTextMarker)
    && runtime.includes(backgroundRestoreReminderMarker)
    && runtime.includes(backgroundRestoreMetadataErrorMarker)
    && runtime.includes(backgroundRestoreBeforeSendMarker)
    && runtime.includes(backgroundTasksReplaceMarker)
    && runtime.includes(taskMessageRestoreMarker)
    && runtime.includes(".loadSessionContextMessages=async()=>await(await")
    && /loadSessionContextMessages:[A-Za-z_$][\w$]*\.loadSessionContextMessages/u.test(runtime);
  if (alreadyPatched) return runtime;

  let patched = runtime;
  patched = patched.replace(
    legacyStartedTurnResultPattern,
    'return $1.kind!=="started_turn"?$1:$2(await($1.result??$1.completion),$3,$4($5))'
  );
  if (!supportsActiveTurnSteer(patched)) {
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
  // Persisted background-agent restore: after a CLI restart + session resume the
  // in-memory runtimeTaskRegistry is empty, so /tasks lists nothing and
  // sendBackgroundTaskMessage cannot find the task. The runtime already ships a
  // resume-from-child-session path (sendMessage on a stopped local_agent task),
  // so re-registering spawn records from the already active-branch-filtered
  // transcript is enough to make /tasks and /tasks resume work again.
  const backgroundRestoreAssignment = `${bridge}.$zRestorePersistedBackgroundTasks=async $zApp=>{let $zRuntime=$zApp?.runtime,$zRegistry=$zRuntime?.runtimeTaskRegistry;if(!$zRegistry?.register||typeof $zApp?.sessionId!="string"||$zApp.sessionId===$zApp.$zRestoredBackgroundTasksSession)return;$zApp.$zRestoredBackgroundTasksSession=$zApp.sessionId,$zApp.$zRestoredBackgroundTasksLog=[];try{let $zMessages=await $zApp.loadSessionTranscript?.()??[],$zRestored=[];for(let $zMessage of $zMessages){let $zParts=Array.isArray($zMessage?.parts)?$zMessage.parts:[];for(let $zPart of $zParts){if($zPart?.type!=="tool")continue;let $zToolName=typeof $zPart.toolName==="string"?$zPart.toolName:typeof $zPart.tool==="string"?$zPart.tool:"";$zToolName=$zToolName.trim().toLowerCase();if($zToolName!=="agent"&&$zToolName!=="subagent"&&$zToolName!=="task")continue;let $zInput=$zPart.input??$zPart.state?.input,$zOutput=typeof $zPart.output==="string"?$zPart.output:$zPart.state?.output;if(typeof $zOutput!=="string"||$zOutput.trim().length===0)continue;let $zSpawn;try{$zSpawn=JSON.parse($zOutput)}catch{}if(!$zSpawn||typeof $zSpawn!=="object"||Array.isArray($zSpawn)){let $zAgentId=/(?:^|\\n)agentId:\\s*([^\\s(]+)/u.exec($zOutput)?.[1],$zOutputFile=/(?:^|\\n)output_file:\\s*([^\\r\\n]+)/u.exec($zOutput)?.[1]?.trim();if(typeof $zAgentId!=="string"||$zAgentId.length===0)continue;$zSpawn={status:"async_launched",agentId:$zAgentId,agentType:typeof $zInput?.subagent_type==="string"&&$zInput.subagent_type.length>0?$zInput.subagent_type:typeof $zInput?.agentType==="string"&&$zInput.agentType.length>0?$zInput.agentType:void 0,childSessionId:"sess_subagent_"+$zAgentId,description:typeof $zInput?.description==="string"&&$zInput.description.length>0?$zInput.description:void 0,prompt:typeof $zInput?.prompt==="string"&&$zInput.prompt.length>0?$zInput.prompt:void 0,...$zOutputFile?{outputFile:$zOutputFile}:{}}}if(($zSpawn.status!=="async_launched"&&$zSpawn.status!=="backgrounded")||typeof $zSpawn.agentId!=="string"||$zSpawn.agentId.length===0)continue;let $zMetadata;if(typeof $zSpawn.outputFile==="string"&&$zSpawn.outputFile.length>0)try{let $zBuiltin=process.getBuiltinModule;if(typeof $zBuiltin==="function"){let $zFs=$zBuiltin.call(process,"node:fs"),$zPath=$zBuiltin.call(process,"node:path");$zMetadata=JSON.parse($zFs.readFileSync($zPath.join($zPath.dirname($zSpawn.outputFile),"metadata.json"),"utf8"))}}catch{}if($zMetadata&&typeof $zMetadata==="object"&&!Array.isArray($zMetadata)&&(typeof $zMetadata.agentId!=="string"||$zMetadata.agentId===$zSpawn.agentId)&&(typeof $zMetadata.parentSessionId!=="string"||$zMetadata.parentSessionId===$zApp.sessionId))$zSpawn={...$zSpawn,agentType:typeof $zMetadata.profileId==="string"&&$zMetadata.profileId.length>0?$zMetadata.profileId:$zSpawn.agentType,childSessionId:typeof $zMetadata.childSessionId==="string"&&$zMetadata.childSessionId.length>0?$zMetadata.childSessionId:$zSpawn.childSessionId,description:typeof $zMetadata.description==="string"&&$zMetadata.description.length>0?$zMetadata.description:$zSpawn.description,outputFile:typeof $zMetadata.outputFile==="string"&&$zMetadata.outputFile.length>0?$zMetadata.outputFile:$zSpawn.outputFile,prompt:typeof $zMetadata.prompt==="string"&&$zMetadata.prompt.length>0?$zMetadata.prompt:$zSpawn.prompt,error:typeof $zMetadata.error==="string"&&$zMetadata.error.length>0?$zMetadata.error:$zSpawn.error};if(typeof $zSpawn.childSessionId!=="string"||$zSpawn.childSessionId.length===0)$zSpawn.childSessionId="sess_subagent_"+$zSpawn.agentId;if($zRegistry.get?.($zSpawn.agentId))continue;let $zStatus="stopped";if($zMetadata?.status==="completed")$zStatus="completed";else if($zMetadata?.status==="failed")$zStatus="failed";let $zTask={taskId:$zSpawn.agentId,agentId:$zSpawn.agentId,agentType:typeof $zSpawn.agentType==="string"&&$zSpawn.agentType.length>0?$zSpawn.agentType:"general-purpose",childSessionId:$zSpawn.childSessionId,description:typeof $zSpawn.description==="string"&&$zSpawn.description.length>0?$zSpawn.description:void 0,error:typeof $zSpawn.error==="string"&&$zSpawn.error.length>0?$zSpawn.error:void 0,isBackgrounded:!0,outputFile:typeof $zSpawn.outputFile==="string"&&$zSpawn.outputFile.length>0?$zSpawn.outputFile:void 0,parentToolCallId:typeof $zPart.toolCallId==="string"&&$zPart.toolCallId.length>0?$zPart.toolCallId:typeof $zPart.callID==="string"&&$zPart.callID.length>0?$zPart.callID:void 0,parentSessionId:$zApp.sessionId,prompt:typeof $zSpawn.prompt==="string"&&$zSpawn.prompt.length>0?$zSpawn.prompt:void 0,startedAt:$zPart.state?.time?.start,status:$zStatus,taskType:"local_agent",type:"local_agent"};$zRegistry.register($zTask),$zRestored.push($zTask)}}if($zRestored.length>0){let $zTaskIds=$zRestored.slice(-32).map($zTask=>"- "+$zTask.taskId+" ("+$zTask.status+")").join("\\n").slice(0,4e3);$zRuntime?.messageHistory?.addAttachment?.("task_status","Background agent tasks from this resumed session have been restored and are available again.\\nEarlier TaskOutput errors saying \\"No task found\\" occurred before restoration and are stale.\\nUse TaskOutput to collect results or SendMessage to continue a task. Do not assume these tasks were lost.\\nRestored task IDs:\\n"+$zTaskIds),$zApp.$zRestoredBackgroundTasksLog=[...($zApp.$zRestoredBackgroundTasksLog??[]),...$zRestored].slice(-64)}}catch{$zApp.$zRestoredBackgroundTasksSession=void 0}}`;
  const guardedBackgroundRestoreAssignment = backgroundRestoreAssignment.replace(
    'if(!$zSpawn||typeof $zSpawn!=="object"||Array.isArray($zSpawn)){let $zAgentId=',
    'if(!$zSpawn||typeof $zSpawn!=="object"||Array.isArray($zSpawn)){if(!$zOutput.includes("Async agent launched successfully."))continue;let $zAgentId='
  );
  const projectionAssignment = `${bridge}.readRuntimeProjection=async()=>{let $zRuntimeProjectionBridge=await ${getApp}();await ${bridge}.$zRestorePersistedBackgroundTasks?.($zRuntimeProjectionBridge);let t=await $zRuntimeProjectionBridge.runtime?.getProjection?.();if(!t)return null;let r=Object.values($zRuntimeProjectionBridge.runtime?.runtimeTaskRegistry?.all?.()??{}).filter(o=>o.isBackgrounded===!0).map(o=>({taskId:o.taskId,taskKind:o.taskType??o.type,agentId:o.agentId,agentType:o.agentType,childSessionId:o.childSessionId,parentSessionId:o.parentSessionId,parentToolCallId:o.parentToolCallId,turnId:o.turnId,prompt:o.prompt,error:o.status==="running"?null:o.error instanceof Error?o.error.message:typeof o.error==="string"?o.error:void 0,outputPath:o.outputFile,status:o.status,description:o.description,startedAt:o.startedAt,completedAt:o.status==="running"?null:o.completedAt,cancelRequestedAt:o.status==="running"?null:o.cancelRequestedAt,blocked:o.status==="running"?null:o.blocked,blockedReason:o.status==="running"?null:o.blockedReason,cancellable:(o.taskType??o.type)==="local_agent"?o.status==="running":o.cancellable}));let s=Array.isArray(t.backgroundTasks)?t.backgroundTasks.slice():[];for(let $zDetail of r){let $zIndex=s.findIndex($zExisting=>$zExisting.taskId===$zDetail.taskId);if($zIndex<0)s.push($zDetail);else s[$zIndex]={...s[$zIndex],...Object.fromEntries(Object.entries($zDetail).filter(([,v])=>v!==void 0))}}return{...t,backgroundTasks:s,backgroundTaskDetails:r,restoredBackgroundTasks:Array.isArray($zRuntimeProjectionBridge.$zRestoredBackgroundTasksLog)?$zRuntimeProjectionBridge.$zRestoredBackgroundTasksLog:[]}}`;
  const taskMessageAssignment = `${bridge}.sendBackgroundTaskMessage=async e=>{let t=await ${getApp}();await ${bridge}.$zRestorePersistedBackgroundTasks?.(t);let r=t.runtime,o=r?.runtimeTaskRegistry?.get?.(e?.taskId);if(!o&&typeof t.sessionId==="string"){t.$zRestoredBackgroundTasksSession=void 0;await ${bridge}.$zRestorePersistedBackgroundTasks?.(t);o=r?.runtimeTaskRegistry?.get?.(e?.taskId)}if(!r?.subagentPort?.sendMessage)throw new Error("Background agent messaging is unavailable in this runtime.");if(!o||(o.type??o.taskType)!=="local_agent")throw new Error("The selected task is not a local agent.");if(typeof e?.message!=="string"||!e.message.trim())throw new Error("Enter a message for the background agent.");let n=e.message.trim().slice(0,2e4),i=(typeof e.summary==="string"?e.summary:n).replace(/\\s+/g," ").trim().slice(0,200);if(e?.restart===!0&&o.status==="running"){if(!r.subagentPort.stopTask)throw new Error("Background agent restart is unavailable in this runtime.");await r.subagentPort.stopTask(e.taskId),o=r.runtimeTaskRegistry?.get?.(e.taskId);if(!o)throw new Error("The background agent stopped but could not be restored.")}return await r.subagentPort.sendMessage({sessionId:o.parentSessionId??r.getSessionId?.(),turnId:o.turnId??"tui-task-message",parentToolCallId:o.parentToolCallId??"tui-task-message",to:o.agentId??e.taskId,summary:i,message:n,workingDirectory:o.workingDirectory??r.workingDirectory,workspaceRoot:o.workspaceRoot??r.workingDirectory,trace:o.traceContext??r.rootTraceContext})}`;
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
  if (!patched.includes(projectionBridgeMarker) || !patched.includes(backgroundRestoreMarker)
    || !patched.includes(backgroundTasksMergeMarker) || !patched.includes(backgroundTasksReplaceMarker)
    || !patched.includes(backgroundTasksRestoredFieldMarker)) {
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
  if (!patched.includes(backgroundRestoreMarker) || !patched.includes(backgroundRestoreSourceMarker)
    || !patched.includes(backgroundRestoreRetryMarker) || !patched.includes(backgroundRestoreLogMarker)
    || !patched.includes(backgroundRestoreModelTextMarker)
    || !patched.includes(backgroundRestoreAsyncModelTextMarker)
    || !patched.includes(backgroundRestoreReminderMarker)
    || !patched.includes(backgroundRestoreMetadataErrorMarker)) {
    const existingRestoreStart = patched.indexOf(`${bridge}.$zRestorePersistedBackgroundTasks=async $zApp=>`);
    if (existingRestoreStart >= 0) {
      const existingRestoreEnd = patched.indexOf(`,${bridge}.`, existingRestoreStart);
      if (existingRestoreEnd < 0) {
        throw new Error("ZCode runtime is incompatible with the TUI bridge (background restore boundary missing).");
      }
      patched = `${patched.slice(0, existingRestoreStart)}${guardedBackgroundRestoreAssignment}${patched.slice(existingRestoreEnd)}`;
    } else {
      assignments.push(guardedBackgroundRestoreAssignment);
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
  if (!modeBridgePattern.test(patched)) {
    assignments.push(`${bridge}.setMode=async e=>{let t=await ${getApp}();if(t.setMode)return await t.setMode(e);t.runtime?.updateConfig?.({mode:e});return{mode:t.getMode?.()??e}}`);
  }
  // Session-level (transient) model switch: the runtime's setModel persists
  // model.main to config.json by default; {transient:true} keeps it in-memory
  // so the /model quick picker does not rewrite saved defaults.
  if (!patched.includes(".setTransientModel=async")) {
    assignments.push(`${bridge}.setTransientModel=async e=>await(await ${getApp}()).setModel?.(e,{transient:!0})`);
  }
  if (!sessionEventsBridgePattern.test(patched)) {
    assignments.push(`${bridge}.subscribeSessionEvents=e=>{let t=!1,r;${getApp}().then(o=>{t||(r=o.runtime?.subscribeEvents?.({onSessionEvent:e}))});return()=>{t=!0,r?.()}}`);
  }
  if (!taskMessageBridgePattern.test(patched)) {
    assignments.push(taskMessageAssignment);
  } else if (!patched.includes(taskMessageRestartMarker) || !patched.includes(taskMessageRestoreMarker)) {
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
  if (!patched.includes(backgroundRestoreBeforeSendMarker)) {
    assignments.push(
      `${bridge}.$zSendInputWithoutBackgroundRestore=${bridge}.sendInput,${bridge}.sendInput=async(...$zArgs)=>{let $zApp=await ${getApp}();await ${bridge}.$zRestorePersistedBackgroundTasks?.($zApp);return await ${bridge}.$zSendInputWithoutBackgroundRestore.apply(${bridge},$zArgs)}`
    );
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
  if (!/listModelOptions:[A-Za-z_$][\w$]*\.listModelOptions/u.test(patched)) {
    optionFields.push(`listModelOptions:${submitBridge}.listModelOptions`);
  }
  if (!modeOptionPattern.test(patched)) {
    optionFields.push(`setMode:${submitBridge}.setMode`);
  }
  if (!/setTransientModel:[A-Za-z_$][\w$]*\.setTransientModel/u.test(patched)) {
    optionFields.push(`setTransientModel:${submitBridge}.setTransientModel`);
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

/** Avoid Undici rejecting bodies on the Fetch statuses that must be bodyless. */
export function hasRuntimeHttpNoContentGuard(runtime: string): boolean {
  return /([A-Za-z_$][\w$]*)\.statusCode===204\|\|\1\.statusCode===205\|\|\1\.statusCode===304\?void 0:/u
    .test(runtime);
}

export function patchRuntimeHttpNoContent(runtime: string): string {
  const responsePattern = /new Response\(([A-Za-z_$][\w$]*)\.Readable\.toWeb\(([A-Za-z_$][\w$]*)\),\{headers:([A-Za-z_$][\w$]*),status:\2\.statusCode\?\?502,statusText:\2\.statusMessage\}\)/gu;
  let changed = false;
  const patched = runtime.replace(
    responsePattern,
    (_match, readableNamespace: string, response: string, headers: string) => {
      changed = true;
      return `new Response(${response}.statusCode===204||${response}.statusCode===205||${response}.statusCode===304?void 0:${readableNamespace}.Readable.toWeb(${response}),{headers:${headers},status:${response}.statusCode??502,statusText:${response}.statusMessage})`;
    }
  );
  return changed ? patched : runtime;
}

function escapeRegExpName(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function countRegExpMatches(source: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return Array.from(source.matchAll(new RegExp(pattern.source, flags))).length;
}

/** Detect the local transport classifier while preserving the emitted-output retry boundary. */
export function hasRuntimeNetworkRetryGuard(runtime: string): boolean {
  return runtime.includes("var $zTransportCodes=[")
    && runtime.includes("function $zTransportCode(e){")
    && runtime.includes("function $zTransportChain(e,t){")
    && /if\(\$zTransportChain\(e,new WeakSet\)\)return!0;return [A-Za-z_$][\w$]*\(e\)\}/u.test(runtime)
    && /\|\|\$zTransportChain\([A-Za-z_$][\w$]*,new WeakSet\)\)return\{code:/u.test(runtime)
    && /\|\|\$zTransportChain\([A-Za-z_$][\w$]*,new WeakSet\)\)return!0;if\(t!==void 0\)return!1;/u.test(runtime)
    && /function [A-Za-z_$][\w$]*\(e\)\{return e\.emittedRetryBoundaryEvent\|\|e\.attempt>=e\.maxAttempts\|\|e\.failure\.reason===[A-Za-z_$][\w$]*\.Cancelled\?!1:/u.test(runtime);
}

/**
 * Recover transport failures whose deep `cause.code` is hidden by a wrapping
 * `model_request_failed` code. The emitted-output gate remains unchanged: once
 * content is visible, the turn-level stream recovery owns discard/anchor logic.
 */
export function patchRuntimeNetworkRetryClassification(runtime: string): string {
  if (hasRuntimeNetworkRetryGuard(runtime)) return runtime;
  if (runtime.includes("function $zTransportCode(e){")
    || runtime.includes("function $zTransportChain(e,t){")) {
    throw new Error("ZCode runtime contains a partial network retry patch.");
  }

  const whitelistPattern = /function ([A-Za-z_$][\w$]*)\(e\)\{let t=e\?\.toUpperCase\(\);return t==="ECONNRESET"\|\|t==="ECONNREFUSED"\|\|t==="EAI_AGAIN"\|\|t==="ENOTFOUND"\|\|t==="ENETUNREACH"\|\|t==="EHOSTUNREACH"\|\|t==="UND_ERR_SOCKET"\|\|t==="UND_ERR_CONNECT_TIMEOUT"\}/u;
  const extractorPattern = /function ([A-Za-z_$][\w$]*)\(e\)\{return ([A-Za-z_$][\w$]*)\(e,new WeakSet\)\}function \2\(e,t\)\{if\(([A-Za-z_$][\w$]*)\(e,t\)\)return;let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(e\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\4,"code"\);if\(\6\)return \6;let [A-Za-z_$][\w$]*=\4\.cause;if\([A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*!==e\)return \2\([A-Za-z_$][\w$]*,t\)\}/u;
  const classifierPattern = /function ([A-Za-z_$][\w$]*)\(e,t\)\{let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(e\),[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\(\2\),([A-Za-z_$][\w$]*)=EXTRACTOR\(\2\),/u;
  const streamGatePattern = /function ([A-Za-z_$][\w$]*)\(e\)\{return e\.emittedRetryBoundaryEvent\|\|e\.attempt>=e\.maxAttempts\|\|e\.failure\.reason===([A-Za-z_$][\w$]*)\.Cancelled\?!1:/u;

  const whitelistMatch = whitelistPattern.exec(runtime);
  const extractorMatch = extractorPattern.exec(runtime);
  if (!whitelistMatch || !extractorMatch) {
    throw new Error("ZCode runtime is incompatible with the network retry patch (error-code anchors missing).");
  }

  const whitelist = whitelistMatch[1]!;
  const extractor = extractorMatch[1]!;
  const seen = extractorMatch[3]!;
  const normalizer = extractorMatch[5]!;
  const stringGetter = extractorMatch[7]!;
  const classifierFullPattern = new RegExp(
    classifierPattern.source.replace("EXTRACTOR", escapeRegExpName(extractor)),
    "u"
  );
  const classifier = classifierFullPattern.exec(runtime);
  if (!classifier) {
    throw new Error("ZCode runtime is incompatible with the network retry patch (classifier anchor missing).");
  }
  const classifierError = classifier[2]!;
  const classifierCode = classifier[3]!;

  const networkBranchPattern = new RegExp(
    `if\\(${escapeRegExpName(whitelist)}\\(${escapeRegExpName(classifierCode)}\\)\\)return\\{code:([A-Za-z_$][\\w$]*)\\.ModelRequestFailed,message:"Network connection failed for the provider request\\."`,
    "u"
  );
  const networkBranch = networkBranchPattern.exec(runtime);
  const classifierEnd = runtime.indexOf("function ", classifier.index + classifier[0].length);
  if (!networkBranch || networkBranch.index < classifier.index
    || (classifierEnd >= 0 && networkBranch.index >= classifierEnd)) {
    throw new Error("ZCode runtime is incompatible with the network retry patch (network branch anchor missing).");
  }

  const retryDecisionPattern = new RegExp(
    `function ([A-Za-z_$][\\w$]*)\\(e,t\\)\\{if\\(t\\)\\{if\\(${escapeRegExpName(whitelist)}\\(t\\)\\|\\|([A-Za-z_$][\\w$]*)\\.has\\(t\\)\\)return!0;let ([A-Za-z_$][\\w$]*)=t\\.toLowerCase\\(\\);if\\(\\3==="network_error"\\|\\|\\3==="network_error_retryable"\\)return!0\\}return ([A-Za-z_$][\\w$]*)\\(e\\)\\}`,
    "u"
  );
  const retryDecision = retryDecisionPattern.exec(runtime);
  if (!retryDecision) {
    throw new Error("ZCode runtime is incompatible with the network retry patch (retry decision anchor missing).");
  }

  const staleStreamPattern = new RegExp(
    `function ([A-Za-z_$][\\w$]*)\\(e,t\\)\\{let ([A-Za-z_$][\\w$]*)=([A-Za-z_$][\\w$]*)\\(e\\);if\\(([A-Za-z_$][\\w$]*)\\(\\2\\)\\|\\|([A-Za-z_$][\\w$]*)\\(${escapeRegExpName(extractor)}\\(\\2\\)\\)\\)return!0;`,
    "u"
  );
  const staleStream = staleStreamPattern.exec(runtime);
  if (!staleStream) {
    throw new Error("ZCode runtime is incompatible with the network retry patch (stale stream anchor missing).");
  }

  for (const [pattern, label] of [
    [whitelistPattern, "network error-code whitelist"],
    [extractorPattern, "cause-chain error-code extractor"],
    [classifierFullPattern, "model request failure classifier"],
    [networkBranchPattern, "classifier network branch"],
    [retryDecisionPattern, "final retry decision"],
    [staleStreamPattern, "stale stream detector"],
    [streamGatePattern, "emitted-output stream gate"]
  ] as const) {
    if (countRegExpMatches(runtime, pattern) !== 1) {
      throw new Error(`ZCode runtime is incompatible with the network retry patch (${label} is not unique).`);
    }
  }

  const transportCodes = [
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "ENOTFOUND",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EPIPE",
    "CONNECTIONCLOSED",
    "ETIMEDOUT",
    "ETIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT"
  ];
  const transportText = JSON.stringify(transportCodes);
  const chainProbe = [
    `var $zTransportCodes=${transportText};`,
    "function $zTransportCode(e){let t=e?.trim().toUpperCase();return!!t&&$zTransportCodes.includes(t)}",
    "function $zTransportText(e){let t=e?.toUpperCase();return!!t&&$zTransportCodes.some(r=>t.includes(r))}",
    `function $zTransportChain(e,t){if(${seen}(e,t))return!1;let r=${normalizer}(e),n=${normalizer}(r.error),o=${normalizer}(r.context);if($zTransportCode(${stringGetter}(r,"code"))||$zTransportCode(${stringGetter}(r,"providerCode"))||$zTransportCode(${stringGetter}(n,"code"))||$zTransportCode(${stringGetter}(n,"providerCode"))||$zTransportCode(${stringGetter}(o,"code"))||$zTransportCode(${stringGetter}(o,"providerCode"))||$zTransportText(${stringGetter}(r,"message"))||$zTransportText(${stringGetter}(n,"message"))||$zTransportText(${stringGetter}(o,"message")))return!0;let i=r.cause;return i&&i!==e?$zTransportChain(i,t):!1}`
  ].join("");

  let patched = runtime.replace(
    retryDecisionPattern,
    (_match, decision: string, reasonSet: string, reason: string, fallback: string) => (
      `${chainProbe}function ${decision}(e,t){if(t){if(${whitelist}(t)||${reasonSet}.has(t))return!0;let ${reason}=t.toLowerCase();if(${reason}==="network_error"||${reason}==="network_error_retryable")return!0}if($zTransportChain(e,new WeakSet))return!0;return ${fallback}(e)}`
    )
  );
  patched = patched.replace(
    networkBranchPattern,
    (_match, codeEnum: string) => `if(${whitelist}(${classifierCode})||$zTransportChain(${classifierError},new WeakSet))return{code:${codeEnum}.ModelRequestFailed,message:"Network connection failed for the provider request."`
  );
  patched = patched.replace(
    staleStreamPattern,
    (_match, detector: string, error: string, unwrap: string, idle: string, staleCode: string) => (
      `function ${detector}(e,t){let ${error}=${unwrap}(e);if(${idle}(${error})||${staleCode}(${extractor}(${error}))||$zTransportChain(${error},new WeakSet))return!0;`
    )
  );

  if (!hasRuntimeNetworkRetryGuard(patched)) {
    throw new Error("ZCode runtime network retry patch failed postcondition verification.");
  }
  return patched;
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

const goalFailurePauseMarker = /finishTargetTurnAccounting\(\{[^{}]*?status:"paused",traceContext:/u;
const terminalProjectionMarkers = [
  'status:"idle",currentTurnId:void 0,activeToolCalls:[],totalTokenCount:',
  'status:"error",currentTurnId:void 0,activeToolCalls:[],lastError:'
] as const;

export const runtimePatchPlan: readonly RuntimePatchDefinition[] = [
  {
    id: "tui-bridge",
    requirement: "required",
    apply: patchRuntimeTuiBridge,
    verify: (runtime) => runtime.includes(".readRuntimeProjection=async()=>{let $zRuntimeProjectionBridge=await ")
      && runtime.includes(".loadSessionContextMessages=async()=>await(await")
  },
  {
    id: "goal-failure-pause",
    requirement: "optional",
    apply: patchRuntimeGoalFailurePause,
    verify: (runtime) => goalFailurePauseMarker.test(runtime)
  },
  {
    id: "terminal-tool-projection",
    requirement: "optional",
    apply: patchRuntimeTerminalToolProjection,
    verify: (runtime) => terminalProjectionMarkers.every((marker) => runtime.includes(marker))
  },
  {
    id: "detached-agent-lifecycle",
    requirement: "optional",
    apply: patchRuntimeDetachedAgentLifecycle,
    verify: (runtime) => runtime.includes("Detached background agent lifecycle failed")
  },
  {
    id: "agent-auto-background",
    requirement: "optional",
    apply: patchRuntimeAgentAutoBackground,
    verify: (runtime) => runtime.includes(
      "autoBackgroundMs:this.config.subagents?.autoBackgroundMs??1e3,outputRootDir:"
    )
  },
  {
    id: "http-no-content",
    requirement: "required",
    apply: patchRuntimeHttpNoContent,
    verify: hasRuntimeHttpNoContentGuard
  },
  {
    id: "network-retry-classification",
    requirement: "required",
    apply: patchRuntimeNetworkRetryClassification,
    verify: hasRuntimeNetworkRetryGuard
  },
  {
    id: "oauth-http-errors",
    requirement: "optional",
    apply: patchRuntimeOAuthHttpErrors,
    verify: (runtime) => !runtime.includes('"OAuth response is not valid JSON",{httpStatus:void 0}')
  },
  {
    id: "desktop-oauth",
    requirement: "required",
    apply: patchRuntimeZaiDesktopOAuth,
    verify: (runtime) => runtime.includes('ZCODE_CLI_OAUTH_CALLBACK_STDIN==="1"')
  },
  {
    id: "login-model-defaults",
    requirement: "required",
    apply: patchRuntimeLoginModelDefaults
  },
  {
    id: "cli-help-contract",
    requirement: "required",
    apply: patchRuntimeCliHelpContract,
    verify: hasRuntimeCliHelpContract
  }
];

export function applyRuntimePatchPlan(
  runtime: string,
  patches: readonly RuntimePatchDefinition[] = runtimePatchPlan
): { runtime: string; reports: RuntimePatchReport[] } {
  let patched = runtime;
  const reports: RuntimePatchReport[] = [];
  for (const patch of patches) {
    try {
      const next = patch.apply(patched);
      if (patch.apply(next) !== next) {
        throw new Error("patch is not idempotent");
      }
      if (patch.verify && !patch.verify(next)) {
        throw new Error("postcondition verification failed");
      }
      reports.push({
        id: patch.id,
        requirement: patch.requirement,
        status: next === patched ? "already_present" : "applied"
      });
      patched = next;
    } catch (error) {
      const report: RuntimePatchReport = {
        id: patch.id,
        requirement: patch.requirement,
        status: patch.requirement === "required" ? "failed" : "skipped",
        message: error instanceof Error ? error.message : String(error)
      };
      reports.push(report);
      if (patch.requirement === "required") {
        throw new RuntimePatchError(patch, error, reports);
      }
    }
  }
  return { runtime: patched, reports };
}

async function installTuiBridge(nextVendor: string): Promise<RuntimePatchReport[]> {
  const runtimePath = join(nextVendor, "zcode.cjs");
  const runtime = await readFile(runtimePath, "utf8");
  const result = applyRuntimePatchPlan(runtime);
  await writeFile(runtimePath, result.runtime);
  return result.reports;
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
  if (actualHash !== lock.sha512) {
    throw new Error(
      `Downloaded installer failed SHA-512 verification.\n`
      + `  manifest/lock: ${lock.sha512}\n`
      + `  actual file:   ${actualHash}\n`
      + `The published manifest may carry stale checksum metadata. `
      + `If the downloaded installer is trusted, update zcode-runtime.lock.json with the actual sha512 above and re-run.`
    );
  }
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
  const compatibilityJson = join(root, ".release", "runtime-compatibility.json");
  const compatibilityMarkdown = join(root, ".release", "runtime-compatibility.md");
  let source: RuntimeSource | undefined;
  let runtimePatches: RuntimePatchReport[] = [];
  await rm(compatibilityJson, { force: true });
  await rm(compatibilityMarkdown, { force: true });
  try {
    source = await resolveSource(options, temporaryDirectory);
    await rm(nextVendor, { recursive: true, force: true });
    await cp(source.glm, nextVendor, { recursive: true });
    runtimePatches = await installTuiBridge(nextVendor);
    await installLocalTui(nextVendor);
    const node = process.env.ZCODE_NODE || Bun.which("node");
    if (!node) throw new Error("Node.js >=22.19 is required to validate the official ZCode runtime.");
    const cliVersion = await run(node, [join(nextVendor, "zcode.cjs"), "--version"], { capture: true });
    const runtimeCapabilities = extractRuntimeCapabilities(
      await readFile(join(nextVendor, "zcode.cjs"), "utf8")
    );
    await writeFile(join(nextVendor, "extraction.json"), `${JSON.stringify({
      appVersion: source.appVersion,
      cliVersion,
      extractedAt: new Date().toISOString(),
      ...(source.lock ? { sha512: source.lock.sha512 } : {}),
      source: source.source,
      runtimeCapabilities,
      runtimePatches,
      tui: {
        implementation: "@zcode/tui",
        foundation: "@earendil-works/pi-tui"
      }
    }, null, 2)}\n`);

    const packagePath = join(root, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
    // `--app` (local development sync) must not bump package.json or the CI
    // lock file: the local macOS App may be newer than the Linux release the CI
    // gate pins, and dev drift would break the "pins the exact remote runtime"
    // test. Only the manifest/lock sync paths (`sync`, `sync:locked`) own the
    // committed version + lock — matching the CI release workflow contract.
    if (options.app) {
      const currentVersion = String(packageJson.version ?? "");
      if (parseReleaseVersion(currentVersion)?.appVersion !== source.appVersion) {
        console.log(
          `Local App ${source.appVersion} differs from package.json ${currentVersion}; run \`bun run sync\` to align the CI lock.`
        );
      }
    } else {
      const packageVersion = syncedReleaseVersion(source.appVersion, String(packageJson.version ?? ""));
      packageJson.version = packageVersion;
      await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      if (source.lock) {
        await writeFile(join(root, "zcode-runtime.lock.json"), `${JSON.stringify(source.lock, null, 2)}\n`);
      }
    }
    await rm(join(root, "vendor"), { recursive: true, force: true });
    await rename(nextVendor, join(root, "vendor"));
    console.log(`Prepared ${String(packageJson.name)}@${packageJson.version} with ${cliVersion}.`);
  } catch (error) {
    const report: RuntimeCompatibilityFailure = {
      schemaVersion: 1,
      ...(source ? { appVersion: source.appVersion } : {}),
      generatedAt: new Date().toISOString(),
      phase: !source
        ? "runtime_discovery"
        : error instanceof RuntimePatchError ? "runtime_patch" : "runtime_sync",
      error: error instanceof Error ? error.message : String(error),
      runtimePatches: error instanceof RuntimePatchError ? error.reports : runtimePatches
    };
    await writeRuntimeCompatibilityFailure(report, dirname(compatibilityJson));
    throw error;
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
