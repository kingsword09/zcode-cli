#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const runtime = join(root, "vendor", "zcode.cjs");
if (!existsSync(runtime)) throw new Error("vendor/zcode.cjs is missing; run `bun run sync:local` first.");

const decoder = new TextDecoder();
let output = "";
const temporaryHome = await mkdtemp(join(tmpdir(), "zcode-cli-smoke-"));
const smokeApiKey = "smoke-api-key-not-real";
const command = process.argv[2]
  ? [resolve(process.argv[2])]
  : [process.execPath, join(root, "bin", "zcode.ts")];
const terminal = new Bun.Terminal({
  cols: 100,
  rows: 32,
  name: "xterm-256color",
  data(_terminal, data) {
    output += decoder.decode(data, { stream: true });
  }
});

const child = Bun.spawn(command, {
  cwd: root,
  env: {
    ...process.env,
    CI: "1",
    HOME: temporaryHome,
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
    /(?:Configured Z\.AI Coding Plan|已配置 Z\.AI Coding Plan)[\s\S]*\n \[0s\]/i,
    apiKeySetupStart
  );
  await sendAndWait("/help\r", "help output", /Slash commands:|Usage:/i);
  await sendAndWait("/mode plan\r", "plan mode", /mode switched to plan|current mode: plan|default · plan/i);
  terminal.write("/exit\r");
} catch (error) {
  interactionError = error;
  child.kill("SIGKILL");
}

const code = await child.exited;
clearTimeout(timeout);
if (!terminal.closed) terminal.close();
const configPath = join(temporaryHome, ".zcode", "cli", "config.json");
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
if (!plain.includes("ZCode")) throw new Error(`TUI welcome screen was not rendered.\n${plain.slice(-4_000)}`);
if (!/custom provider/i.test(plain)) {
  throw new Error(`The custom-provider configuration hint was not rendered.\n${plain.slice(-4_000)}`);
}
if (!/Configured Z\.AI Coding Plan|已配置 Z\.AI Coding Plan/i.test(plain)) {
  throw new Error(`The masked API-key setup did not complete.\n${plain.slice(-4_000)}`);
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
if (!/mode switched to plan|current mode: plan|default · plan/i.test(plain)) {
  throw new Error(`The /mode command did not update the TUI.\n${plain.slice(-4_000)}`);
}

console.log("Bun.Terminal + pi-tui smoke test passed.");
