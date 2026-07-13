#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = join(root, "test", "fixtures", "tui-features.ts");
const temporaryHome = await mkdtemp(join(tmpdir(), "zcode-tui-features-"));
const decoder = new TextDecoder();
let output = "";
const terminal = new Bun.Terminal({
  cols: 110,
  rows: 40,
  name: "xterm-256color",
  data(_terminal, data) {
    output += decoder.decode(data, { stream: true });
  }
});

const child = Bun.spawn([process.execPath, fixture], {
  cwd: root,
  env: { ...process.env, CI: "1", HOME: temporaryHome, TERM: "xterm-256color" },
  terminal
});

const actions = [
  [400, "/help\r"],
  [1_000, "/effort\r"],
  [1_500, "\r"],
  [2_100, "/model\r"],
  [2_600, "beta\r"],
  [3_300, "\x16"],
  [3_900, "inspect\r"],
  [5_000, "/mcp\r"],
  [5_500, "\r"],
  [6_300, "/workflows\r"],
  [6_900, "\r"],
  [7_500, "\x1b[B\r"],
  [8_200, "\x1b"],
  [8_800, "/exit\r"]
] as const;
const timers = actions.map(([delay, input]) => setTimeout(() => terminal.write(input), delay));
const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);

const code = await child.exited;
for (const timer of timers) clearTimeout(timer);
clearTimeout(timeout);
if (!terminal.closed) terminal.close();
await rm(temporaryHome, { recursive: true, force: true });
output += decoder.decode();

const plain = output
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1bP[^\x07]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/\r/g, "");

if (process.env.ZCODE_TUI_SMOKE_DEBUG === "1") console.log(plain);
if (code !== 0) throw new Error(`Feature TUI smoke exited with ${code}.\n${plain.slice(-6_000)}`);

for (const [label, pattern] of [
  ["long help output", /Use \/help <command> for details/i],
  ["model picker", /Select model/i],
  ["model switch", /Model switched to beta\/model/i],
  ["effort picker", /Select reasoning effort/i],
  ["effort switch", /Reasoning effort switched to low/i],
  ["image attachment", /1 image attached/i],
  ["tool card", /Read · complete/i],
  ["tool result", /source text/i],
  ["MCP picker", /MCP servers/i],
  ["MCP action", /MCP connected: docs/i],
  ["workflow picker", /Workflow runs/i],
  ["workflow detail", /Feature workflow/i],
  ["workflow stop", /Status: cancelled/i]
] as const) {
  if (!pattern.test(plain)) throw new Error(`Missing ${label} in feature TUI smoke.\n${plain.slice(-6_000)}`);
}

console.log("TUI feature smoke test passed.");
