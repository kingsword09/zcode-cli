#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = join(root, "test", "fixtures", "tui-pressure.ts");
const temporaryHome = await mkdtemp(join(tmpdir(), "zcode-tui-pressure-"));
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
const child = Bun.spawn([process.execPath, fixture], {
  cwd: root,
  env: {
    ...process.env,
    CI: "1",
    HOME: temporaryHome,
    USERPROFILE: temporaryHome,
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

async function waitFor(label: string, pattern: RegExp, start = 0, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pattern.test(plainText(output.slice(start)))) return;
    if (child.exitCode !== null) break;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}.\n${plainText(output).slice(-5_000)}`);
}

const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
let interactionError: unknown;
try {
  await waitFor("pressure editor", /pressure\/model[\s\S]*build/i);
  const steerTurnStart = output.length;
  terminal.write("stress\r");
  await waitFor("streaming pressure output", /Bash steer-pressure/i, steerTurnStart);
  const steerStartedAt = Date.now();
  terminal.write("长任务期间继续检查输入响应。\r");
  await waitFor(
    "responsive steering input",
    /Steering current turn · 1 waiting[\s\S]*↪ 长任务期间继续检查输入响应。/u,
    steerTurnStart,
    2_000
  );
  const steerLatencyMs = Date.now() - steerStartedAt;
  if (steerLatencyMs >= 2_000) throw new Error(`Steering input took ${steerLatencyMs}ms under output pressure.`);
  await waitFor("completed pressure turn", /Pressure turn complete\./i, steerTurnStart, 6_000);

  const cancelTurnStart = output.length;
  terminal.write("cancel stress\r");
  await waitFor("cancellable pressure output", /Bash cancel-pressure/i, cancelTurnStart);
  terminal.write("\x03");
  await waitFor("responsive cancellation", /Turn cancelled\./i, cancelTurnStart, 2_000);
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
if (code !== 0) {
  throw new Error(`Pressure TUI exited with ${code}.\n${plainText(output).slice(-5_000)}`);
}

console.log("TUI output-pressure input and cancellation smoke test passed.");
