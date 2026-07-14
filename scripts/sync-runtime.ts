#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cdnRoot = "https://cdn-zcode.z.ai/zcode/electron/releases";

export interface SyncOptions {
  platform: "darwin" | "linux" | "win32";
  arch: string;
  app?: string;
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
  source: string;
}

export function parseArgs(argv: string[]): SyncOptions {
  const result: SyncOptions = { platform: "linux", arch: "x64" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--app" && value) {
      result.app = value;
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
  return result;
}

export function manifestUrl(platform: SyncOptions["platform"], arch: string): string {
  if (platform === "darwin") return `${cdnRoot}/update/mac/${arch}/latest-mac.yml`;
  if (platform === "linux") return `${cdnRoot}/update/linux/${arch}/latest-linux.yml`;
  return `${cdnRoot}/update/win/${arch}/latest.yml`;
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

export function patchRuntimeTuiBridge(runtime: string): string {
  const alreadyPatched = runtime.includes(".loadSessionTranscript=async()=>await(await")
    && runtime.includes(".readGoal=async()=>await(await")
    && runtime.includes(".readTodos=async()=>await(await")
    && runtime.includes(".readRuntimeProjection=async()=>")
    && runtime.includes(".readSessionUsage=async()=>await(await")
    && runtime.includes(".cancelBackgroundTask=async")
    && /loadSessionTranscript:[A-Za-z_$][\w$]*\.loadSessionTranscript/u.test(runtime)
    && /readGoal:[A-Za-z_$][\w$]*\.readGoal/u.test(runtime)
    && /readTodos:[A-Za-z_$][\w$]*\.readTodos/u.test(runtime)
    && /readRuntimeProjection:[A-Za-z_$][\w$]*\.readRuntimeProjection/u.test(runtime)
    && /cancelBackgroundTask:[A-Za-z_$][\w$]*\.cancelBackgroundTask/u.test(runtime)
    && /readSessionUsage:[A-Za-z_$][\w$]*\.readSessionUsage/u.test(runtime);
  if (alreadyPatched) return runtime;

  let patched = runtime;
  if (!patched.includes("readSessionUsage:")) {
    const appPattern = /loadSessionTranscript:([A-Za-z_$][\w$]*)\(async\(\)=>await [A-Za-z_$][\w$]*\(\{sessionId:([A-Za-z_$][\w$]*)\.sessionId,sessionStore:\2\.sessionStore\}\),"loadSessionTranscript"\),readTodos:/u;
    const app = appPattern.exec(patched);
    if (!app) throw new Error("ZCode runtime is incompatible with the TUI bridge (session usage anchor missing).");
    const [appAssignment, helper, context] = app;
    patched = patched.replace(
      appAssignment,
      appAssignment.replace(
        ",readTodos:",
        `,readSessionUsage:${helper}(async()=>await ${context}.sessionStore.queryTaskUsage?.({sessionID:${context}.sessionId})??null,"readSessionUsage"),readTodos:`
      )
    );
  }

  const assignmentPattern = /([A-Za-z_$][\w$]*)\.recallPreviousInput=async ([A-Za-z_$][\w$]*)=>await\(await ([A-Za-z_$][\w$]*)\(\)\)\.recallPreviousInputHistory\?\.\(\2\)\?\?null/u;
  const assignment = assignmentPattern.exec(patched);
  if (!assignment) throw new Error("ZCode runtime is incompatible with the TUI bridge (adapter assignment anchor missing).");

  const [recallAssignment, bridge, , getApp] = assignment;
  const assignments: string[] = [];
  if (!patched.includes(".loadSessionTranscript=async()=>await(await")) {
    assignments.push(`${bridge}.loadSessionTranscript=async()=>await(await ${getApp}()).loadSessionTranscript?.()??[]`);
  }
  if (!patched.includes(".readGoal=async()=>await(await")) {
    assignments.push(`${bridge}.readGoal=async()=>await(await ${getApp}()).readTarget?.()??null`);
  }
  if (!patched.includes(".readTodos=async()=>await(await")) {
    assignments.push(`${bridge}.readTodos=async()=>await(await ${getApp}()).readTodos?.()??[]`);
  }
  if (!patched.includes(".readRuntimeProjection=async()=>")) {
    assignments.push(`${bridge}.readRuntimeProjection=async()=>{let e=await ${getApp}();return e.runtime?.getProjection?.()??null}`);
  }
  if (!patched.includes(".readSessionUsage=async()=>await(await")) {
    assignments.push(`${bridge}.readSessionUsage=async()=>await(await ${getApp}()).readSessionUsage?.()??null`);
  }
  if (!patched.includes(".cancelBackgroundTask=async")) {
    assignments.push(`${bridge}.cancelBackgroundTask=async e=>await(await ${getApp}()).cancelBackgroundTask?.(e)??null`);
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
  if (optionFields.length > 0) {
    patched = patched.replace(optionsAssignment, `${optionFields.join(",")},${optionsAssignment}`);
  }
  return patched;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow" });
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

async function installTuiBridge(nextVendor: string): Promise<void> {
  const runtimePath = join(nextVendor, "zcode.cjs");
  const runtime = await readFile(runtimePath, "utf8");
  await writeFile(runtimePath, patchRuntimeTuiBridge(runtime));
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

  const url = manifestUrl(options.platform, options.arch);
  const manifest = parse(await fetchText(url)) as UpdateManifest;
  const artifact = chooseArtifact(manifest, options.platform);
  const artifactUrl = `${url.slice(0, url.lastIndexOf("/") + 1)}${artifact.url}`;
  const archive = join(temporaryDirectory, basename(artifact.url));
  console.log(`Downloading ${artifactUrl}`);
  await download(artifactUrl, archive);
  const actualHash = await sha512Base64(archive);
  if (actualHash !== artifact.sha512) throw new Error("Downloaded installer failed SHA-512 verification.");
  const extracted = await extractWith7Zip(archive, join(temporaryDirectory, "extract"), options.platform);
  const runtime = await findFile(extracted, "zcode.cjs");
  if (!runtime || basename(dirname(runtime)) !== "glm") {
    throw new Error("Could not locate resources/glm/zcode.cjs.");
  }
  if (manifest.version === undefined) throw new Error("The update manifest does not contain a version.");
  return {
    appVersion: String(manifest.version),
    glm: dirname(runtime),
    source: artifactUrl
  };
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
      source: source.source,
      tui: {
        implementation: "@zcode/tui",
        foundation: "@earendil-works/pi-tui"
      }
    }, null, 2)}\n`);

    const packagePath = join(root, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
    packageJson.version = source.appVersion;
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    await rm(join(root, "vendor"), { recursive: true, force: true });
    await rename(nextVendor, join(root, "vendor"));
    console.log(`Prepared ${String(packageJson.name)}@${source.appVersion} with ${cliVersion}.`);
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
