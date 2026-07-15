#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { nextBuildVersion } from "./release-version.ts";

const root = join(import.meta.dir, "..");
const runtime = join(root, "vendor", "zcode.cjs");
if (!existsSync(runtime)) throw new Error("vendor/zcode.cjs is missing; run `bun run sync:local` first.");
const packageVersion = String((await Bun.file(join(root, "package.json")).json() as { version?: unknown }).version ?? "");
const node = process.env.ZCODE_NODE || Bun.which("node");
if (!node) throw new Error("Node.js >=22.19 is required by the official ZCode runtime.");

const decoder = new TextDecoder();
let output = "";
const temporaryHome = await mkdtemp(join(tmpdir(), "zcode-cli-smoke-"));
const configPath = join(temporaryHome, ".zcode", "cli", "config.json");
const updateCachePath = join(temporaryHome, ".zcode", "cli", "version.json");
const availableVersion = nextBuildVersion(packageVersion);
const smokeApiKey = "smoke-api-key-not-real";
const command = process.argv[2]
  ? [resolve(process.argv[2])]
  : [node, join(root, "bin", "zcode.js")];
const terminal = new Bun.Terminal({
  cols: 100,
  rows: 32,
  name: "xterm-256color",
  data(_terminal, data) {
    output += decoder.decode(data, { stream: true });
  }
});

await mkdir(dirname(updateCachePath), { recursive: true });
await writeFile(updateCachePath, `${JSON.stringify({
  latestVersion: availableVersion,
  lastCheckedAt: new Date().toISOString()
})}\n`);

const child = Bun.spawn(command, {
  cwd: root,
  env: {
    ...process.env,
    CI: "0",
    HOME: temporaryHome,
    NO_UPDATE_NOTIFIER: "0",
    USERPROFILE: temporaryHome,
    ZCODE_DISABLE_UPDATE_CHECK: "0",
    TERM: "xterm-256color"
  },
  terminal
});

function plainText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

async function waitFor(label: string, pattern: RegExp, start = 0, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pattern.test(plainText(output.slice(start)))) return;
    if (child.exitCode !== null) break;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.\n${plainText(output).slice(-4_000)}`);
}

async function sendAndWait(input: string, label: string, pattern: RegExp): Promise<number> {
  const start = output.length;
  terminal.write(input);
  await waitFor(label, pattern, start);
  return start;
}

async function filesBelow(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

const timeout = setTimeout(() => {
  child.kill("SIGKILL");
}, 30_000);

let interactionError: unknown;
try {
  await waitFor("welcome screen", /ZCode/i);
  if (!await Bun.file(configPath).exists()) {
    throw new Error("The launcher did not create config.json before starting the TUI.");
  }
  const initialConfig = await Bun.file(configPath).json() as {
    model?: { main?: string };
    provider?: { zai?: { options?: { apiKey?: string } } };
  };
  if (initialConfig.model?.main !== "zai/glm-5.2"
    || initialConfig.provider?.zai?.options?.apiKey !== undefined) {
    throw new Error("The launcher created an invalid initial config.json.");
  }
  await sendAndWait("/login\r", "login setup picker", /Set Up Coding Plan|配置 Coding Plan/i);
  await sendAndWait("\x1b[B\x1b[B\r", "masked API key prompt", /Enter Z\.AI Coding Plan API Key|输入 Z\.AI Coding Plan API Key/i);
  await sendAndWait(smokeApiKey, "masked API key value", /\*{20,}/i);
  const apiKeySetupStart = await sendAndWait(
    "\r",
    "API key setup",
    /Configured Z\.AI Coding Plan|已配置 Z\.AI Coding Plan/i
  );
  await waitFor(
    "API key turn completion",
    /(?:Configured Z\.AI Coding Plan|已配置 Z\.AI Coding Plan)[\s\S]*◈ zai\/glm-5\.1/i,
    apiKeySetupStart
  );
  await sendAndWait("/help\r", "help output", /Slash commands:|Usage:/i);
  await sendAndWait("/mode plan\r", "plan mode", /mode switched to plan|current mode: plan|◈ default ─ ◉ plan/i);
  terminal.write("/exit\r");
} catch (error) {
  interactionError = error;
  child.kill("SIGKILL");
}

const code = await child.exited;
clearTimeout(timeout);
if (!terminal.closed) terminal.close();
const configured = await Bun.file(configPath).exists()
  ? await Bun.file(configPath).text()
  : "";
const leakedFiles: string[] = [];
for (const path of await filesBelow(temporaryHome)) {
  if (path === configPath) continue;
  const content = Buffer.from(await Bun.file(path).arrayBuffer());
  if (content.includes(smokeApiKey)) leakedFiles.push(path);
}
await rm(temporaryHome, { recursive: true, force: true });
output += decoder.decode();

if (interactionError) throw interactionError;

const plain = plainText(output);

if (process.env.ZCODE_TUI_SMOKE_DEBUG === "1") console.log(plain);

if (code !== 0) throw new Error(`TUI smoke test exited with ${code}.\n${plain.slice(-4_000)}`);
if (!/ZCODE/i.test(plain)) throw new Error(`TUI welcome screen was not rendered.\n${plain.slice(-4_000)}`);
if (!plain.includes(`ZCODE  v${packageVersion}`) || !/runtime v\d+/u.test(plain)) {
  throw new Error(`The TUI did not render the npm and runtime versions separately.\n${plain.slice(-4_000)}`);
}
if (!plain.includes(`Update available! ${packageVersion} → ${availableVersion}`)) {
  throw new Error(`The TUI did not render the cached update notice.\n${plain.slice(-4_000)}`);
}
if (!/custom provider/i.test(plain)) {
  throw new Error(`The custom-provider configuration hint was not rendered.\n${plain.slice(-4_000)}`);
}
if (!/Configured Z\.AI Coding Plan|已配置 Z\.AI Coding Plan/i.test(plain)) {
  throw new Error(`The masked API-key setup did not complete.\n${plain.slice(-4_000)}`);
}
if (/Model config is missing/i.test(plain)) {
  throw new Error(`The generated config did not satisfy the official runtime.\n${plain.slice(-4_000)}`);
}
if (plain.includes(smokeApiKey)) {
  throw new Error(`The API key leaked into terminal output.\n${plain.slice(-4_000)}`);
}
if (!configured.includes(smokeApiKey) || !configured.includes('"main": "zai/')) {
  throw new Error("The official runtime did not persist the Coding Plan configuration.");
}
if (leakedFiles.length > 0) {
  throw new Error(`The API key leaked outside config.json: ${leakedFiles.join(", ")}`);
}
if (!/Slash commands:|Usage:/i.test(plain)) {
  throw new Error(`The /help command did not render.\n${plain.slice(-4_000)}`);
}
if (!/mode switched to plan|current mode: plan|◈ default ─ ◉ plan/i.test(plain)) {
  throw new Error(`The /mode command did not update the TUI.\n${plain.slice(-4_000)}`);
}

console.log("zigpty + pi-tui smoke test passed.");
