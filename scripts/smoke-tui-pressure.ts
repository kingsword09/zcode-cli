#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = join(root, "test", "fixtures", "tui-pressure.ts");
const temporaryHome = await mkdtemp(join(tmpdir(), "zcode-tui-pressure-"));
const decoder = new TextDecoder();
const recoveredSteerTexts = [
  "Esc 后立即提交第一条 steer。",
  "合并第二条 steer 并继续当前上下文。"
] as const;
let output = "";
let cancelTurnStart = 0;
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
  await waitFor(
    "committed steer while the turn is still active",
    /› 长任务期间继续检查输入响应。/u,
    steerTurnStart,
    6_000
  );
  terminal.write("\x1b");
  await waitFor(
    "late Esc guard",
    /Message received; Esc was ignored\. Press Esc again to interrupt\./i,
    steerTurnStart,
    2_000
  );
  await waitFor("completed pressure turn", /Pressure turn complete\./i, steerTurnStart, 6_000);

  cancelTurnStart = output.length;
  terminal.write("cancel stress\r");
  await waitFor("cancellable pressure output", /Bash cancel-pressure/i, cancelTurnStart);
  terminal.write(`${recoveredSteerTexts[0]}\r`);
  await waitFor(
    "first hanging steer",
    /Steering current turn · 1 waiting[\s\S]*Esc 后立即提交第一条 steer。/u,
    cancelTurnStart,
    2_000
  );
  terminal.write(`${recoveredSteerTexts[1]}\r`);
  await waitFor(
    "all hanging steers",
    /Steering current turn · 2 waiting[\s\S]*Esc 后立即提交第一条 steer。[\s\S]*合并第二条 steer 并继续当前上下文。/u,
    cancelTurnStart,
    2_000
  );
  terminal.write("\x1b");
  await waitFor(
    "immediate steer submission",
    /Model interrupted to submit steer instructions\./i,
    cancelTurnStart,
    2_000
  );
  await waitFor(
    "preserved interrupted context",
    /Context established before steer interrupt\./i,
    cancelTurnStart,
    2_000
  );
  await waitFor(
    "recovered steer transcript message",
    /› Esc 后立即提交第一条 steer。[\s\S]*合并第二条 steer 并继续当前上下文。/u,
    cancelTurnStart,
    2_000
  );
  await waitFor(
    "steer continuation",
    /Interrupted model step continued with steer instructions\./i,
    cancelTurnStart,
    2_000
  );
  const foregroundCancelStart = output.length;
  terminal.write("cancel stress\r");
  await waitFor("foreground Esc cancellation turn", /Bash cancel-pressure/i, foregroundCancelStart);
  terminal.write("\x1b");
  await waitFor("foreground Esc cancellation", /Turn cancelled\./i, foregroundCancelStart, 2_000);
  const cancellationSettled = output.length;
  await Bun.sleep(1_200);
  if (/[🕐-🕛] [1-9]\d*s/u.test(plainText(output.slice(cancellationSettled)))) {
    throw new Error("Turn timer kept advancing after foreground Esc cancellation.");
  }
  if (child.exitCode !== null) throw new Error("Esc exited ZCode while cancelling a foreground turn.");
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
const plain = plainText(output);
if (/Recovered steer started as a normal turn\./i.test(plain)) {
  throw new Error(`Steer recovery regressed to a normal turn.\n${plain.slice(-5_000)}`);
}
if (/(?:Steer was|\d+ steers were) not consumed \(turn cancelled\); queued for the next turn\./i.test(plain)) {
  throw new Error(`Immediate steer submission was mislabeled as a queued next turn.\n${plain.slice(-5_000)}`);
}
if (/Model request failed/i.test(plain.slice(cancelTurnStart))) {
  throw new Error(`A semantic steer interrupt was rendered as a model failure.\n${plain.slice(-5_000)}`);
}
for (const [label, pattern] of [
  ["bounded active tool input", /input characters omitted from active tool stream/i],
  ["bounded active tool output", /output characters omitted from active tool stream/i],
  ["quiet cancelled tool", /■ Bash cancel-pressure · cancelled/i]
] as const) {
  if (!pattern.test(plain)) throw new Error(`Missing ${label}.\n${plain.slice(-5_000)}`);
}
if (/TOOL_CANCELLED|internal vendor stack|Bash cancel-pressure · failed/i.test(plain)) {
  throw new Error(`Cancelled tool leaked failure internals.\n${plain.slice(-5_000)}`);
}

console.log("TUI output-pressure steering, Esc recovery, and cancellation smoke test passed.");
