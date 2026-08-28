#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = join(root, "test", "fixtures", "tui-features.ts");
const temporaryHome = await mkdtemp(join(tmpdir(), "zcode-tui-switch-"));
const decoder = new TextDecoder();
const terminalRows = 40;
let output = "";
const terminal = new Bun.Terminal({
  cols: 110,
  rows: terminalRows,
  name: "xterm-256color",
  data(_terminal, data) {
    output += decoder.decode(data, { stream: true });
  }
});

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
    ZCODE_APP_CLI_ENTRY: fixture,
    ZCODE_TUI_NOTIFICATION_METHOD: "osc9",
    ZCODE_TUI_NOTIFICATION_CONDITION: "unfocused"
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

function screenRows(): string[] {
  const rows: string[] = [];
  const writes = output.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;1H\x1b\[2K|$)/g);
  for (const match of writes) rows[Number(match[1]) - 1] = plainText(match[2] ?? "").trimEnd();
  return rows;
}

async function waitFor(
  label: string,
  pattern: RegExp,
  start = 0,
  timeoutMs = 8_000,
  raw = false
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const text = raw ? output.slice(start) : plainText(output.slice(start));
    if (pattern.test(text)) return;
    if (child.exitCode !== null) break;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.\n${plainText(output).slice(-6_000)}`);
}

async function sendAndWait(input: string, label: string, pattern: RegExp, timeoutMs?: number): Promise<number> {
  const start = output.length;
  terminal.write(input);
  await waitFor(label, pattern, start, timeoutMs);
  await Bun.sleep(25);
  return start;
}

const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);

let interactionError: unknown;
try {
  await waitFor("welcome screen", /ZCode/i);
  await waitFor("interactive editor", /alpha\/model/i);
  await sendAndWait("/settings\r", "settings picker", /ZCode settings/i);
  // Navigate to Display mode (4th item).
  await sendAndWait("\x1b[B\x1b[B\x1b[B\r", "display mode picker", /Switch between regular and fullscreen/i);
  // Select Fullscreen (second item, move down from Regular).
  await sendAndWait("\x1b[B\r", "display mode applied", /Switched to fullscreen mode|Display mode: fullscreen/i, 10_000);
  // The switch must enter the alternate screen.
  await waitFor("alternate screen enter on switch", /\x1b\[\?1049h/, 0, 8_000, true);
  await Bun.sleep(75);
  const settingsRows = screenRows();
  const settingsTitleRow = settingsRows.findIndex((row) => row.includes("ZCode settings"));
  const settingsRuleRow = settingsRows.findLastIndex(
    (row, index) => index < settingsTitleRow && /^─{20,}$/u.test(row)
  );
  if (settingsTitleRow < Math.floor(terminalRows / 2) || settingsRuleRow !== settingsTitleRow - 1) {
    throw new Error(`Fullscreen settings did not render as a separated bottom pane.\n${settingsRows.join("\n")}`);
  }
  if (settingsRows.slice(settingsRuleRow).some((row) => /Restored (?:startup|later)/u.test(row))) {
    throw new Error(`Fullscreen settings mixed with transcript content.\n${settingsRows.join("\n")}`);
  }
  await sendAndWait("\x1b", "close fullscreen settings", /alpha\/model/i);
  // The settings loop redraws its root menu once after the mode switch. A
  // second escape closes that menu before exercising the rebuilt editor.
  terminal.write("\x1b");
  await Bun.sleep(75);
  const restoredRows = screenRows();
  if (!restoredRows.some((row) => row.includes("◆ ZCODE"))) {
    throw new Error(`Restored fullscreen session did not render the context rail.\n${restoredRows.join("\n")}`);
  }
  if (restoredRows.some((row) => row.includes("Ask a task about this workspace"))) {
    throw new Error(`Restored fullscreen session rendered the empty-session welcome unexpectedly.\n${restoredRows.join("\n")}`);
  }
  // The rebuilt editor must own the new TUI and preserve ordinary navigation.
  await sendAndWait("abc", "fullscreen editor input", /abc/);
  terminal.write("\x1b[H");
  await Bun.sleep(50);
  await sendAndWait("X", "fullscreen editor Home insertion", /Xabc/);
  terminal.write("\x15");
  await Bun.sleep(50);
  // Async completion must repaint without requiring a follow-up key.
  const completionStart = output.length;
  terminal.write("inspect @ind");
  await waitFor("fullscreen async completion", /src\/index\.ts/i, completionStart, 4_000);
  // Ctrl+C first clears the draft; the second exits an idle TUI.
  terminal.write("\x03");
  await Bun.sleep(50);
  terminal.write("\x15");
  await Bun.sleep(50);
  await sendAndWait("/settings\r", "settings after fullscreen switch", /ZCode settings/i);
  await sendAndWait("\x1b[B\x1b[B\x1b[B\r", "display mode picker after fullscreen", /Switch between regular and fullscreen/i);
  const regularStart = await sendAndWait("\x1b[A\r", "display mode returned to regular", /Display mode: regular/i, 10_000);
  await waitFor("alternate screen exit on switch back", /\x1b\[\?1049l/, regularStart, 8_000, true);
  await sendAndWait("\x1b", "close regular settings", /alpha\/model/i);
  await sendAndWait("return", "regular editor after switch back", /return/);
  terminal.write("\x03");
  await Bun.sleep(50);
  const resetStart = await sendAndWait(
    "/cls\r",
    "regular welcome after transcript reset",
    /Ask a task about this workspace/i
  );
  const resetOutput = plainText(output.slice(resetStart));
  if (!resetOutput.includes("╭─ ◆ ZCODE") || !resetOutput.includes("╰─ /help commands · /status details")) {
    throw new Error(`Regular /cls did not remount the framed session intro.\n${resetOutput.slice(-4_000)}`);
  }
  terminal.write("\x03");
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
if (!/\x1b\[\?1049h/.test(output)) {
  throw new Error(`Runtime switch to fullscreen did not enter the alternate screen.\n${plainText(output).slice(-6_000)}`);
}
if (!/\x1b\[\?1049l/.test(output)) {
  throw new Error(`Runtime switch smoke did not restore the main screen on exit.\n${plainText(output).slice(-6_000)}`);
}
if (code !== 0) {
  throw new Error(`Runtime switch smoke exited with status ${code}.\n${plainText(output).slice(-6_000)}`);
}

console.log("Fullscreen runtime-switch smoke test passed.");
