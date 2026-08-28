#!/usr/bin/env bun

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = join(root, "test", "fixtures", "tui-fullscreen.ts");
const temporaryHome = await mkdtemp(join(tmpdir(), "zcode-tui-fullscreen-"));
const configDir = join(temporaryHome, ".zcode", "cli");
const configPath = join(configDir, "config.json");
const decoder = new TextDecoder();
let output = "";
const terminal = new Bun.Terminal({
  cols: 100,
  rows: 32,
  name: "xterm-256color",
  data(_terminal, data) {
    output += decoder.decode(data, { stream: true });
  }
});

// Pre-write config.json with ui.tuiMode=fullscreen to verify P1-1: the TUI
// reads the persisted mode on startup even when the vendor runtime does not
// forward an initialTuiMode option.
await mkdir(configDir, { recursive: true });
await writeFile(configPath, JSON.stringify({ ui: { tuiMode: "fullscreen" } }, null, 2) + "\n");

const child = Bun.spawn([process.execPath, fixture], {
  cwd: root,
  env: {
    ...process.env,
    CI: "1",
    HOME: temporaryHome,
    USERPROFILE: temporaryHome,
    TERM: "xterm-256color",
    TERM_PROGRAM: "iTerm.app",
    ZCODE_APP_CLI_EXECUTABLE: process.execPath,
    ZCODE_APP_CLI_ENTRY: fixture
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
    if (pattern.test(output.slice(start))) return;
    if (child.exitCode !== null) break;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.\n${plainText(output).slice(-4_000)}`);
}

async function waitForPlain(label: string, pattern: RegExp, start = 0, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pattern.test(plainText(output.slice(start)))) return;
    if (child.exitCode !== null) break;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.\n${plainText(output).slice(-4_000)}`);
}

const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);

let interactionError: unknown;
try {
  // P1-1: config-persisted fullscreen mode takes effect on startup.
  await waitFor("alternate screen enter (config-driven)", /\x1b\[\?1049h/);
  await waitForPlain("welcome banner", /ZCode/i);
  await waitForPlain("interactive editor", /alpha\/model/i);
  // The editor must be constructed against the config-selected fullscreen TUI,
  // so delayed autocomplete repaints without a follow-up key.
  const completionStart = output.length;
  terminal.write("inspect @ind");
  await waitForPlain("config-driven async completion", /src\/index\.ts/i, completionStart, 4_000);
  // P1-2: SIGTERM must trigger clean TUI teardown (exit alt screen, show cursor).
  child.kill("SIGTERM");
  await waitFor("alternate screen exit on SIGTERM", /\x1b\[\?1049l/);
  await waitFor("cursor restored on SIGTERM", /\x1b\[\?25h/);
} catch (error) {
  interactionError = error;
  child.kill("SIGKILL");
}

const code = await child.exited;
clearTimeout(timeout);
if (!terminal.closed) terminal.close();
await rm(temporaryHome, { recursive: true, force: true });
output += decoder.decode();

if (interactionError) throw interactionError;
// SIGTERM should result in a non-zero exit, but the TUI must have cleaned up.
if (!/\x1b\[\?1049h/.test(output)) {
  throw new Error(`Fullscreen TUI did not enter the alternate screen.\n${plainText(output).slice(-4_000)}`);
}
if (!/\x1b\[\?1049l/.test(output)) {
  throw new Error(`Fullscreen TUI did not exit the alternate screen on SIGTERM.\n${plainText(output).slice(-4_000)}`);
}
if (!/\x1b\[\?25h/.test(output)) {
  throw new Error(`Fullscreen TUI did not restore the cursor on SIGTERM.\n${plainText(output).slice(-4_000)}`);
}
if (code !== 143) {
  throw new Error(`Fullscreen TUI SIGTERM exit code was ${code}, expected 143.\n${plainText(output).slice(-4_000)}`);
}

console.log("Fullscreen TUI smoke test passed.");
