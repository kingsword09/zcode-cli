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
  [1_000, "\x1b[Z"],
  [1_300, "\x0c"],
  [1_700, "\x0e"],
  [2_400, "\t"],
  [3_100, "/model\r"],
  [3_600, "alpha\r"],
  [4_200, "/effort\r"],
  [4_700, "\x1b[B\r"],
  [5_400, "\x16"],
  [6_000, "inspect\r"],
  [7_400, "/mcp\r"],
  [7_900, "\r"],
  [8_700, "/workflows\r"],
  [9_300, "\r"],
  [9_900, "\x1b[B\r"],
  [10_600, "\x1b"],
  [11_200, "/goal pause\r"],
  [11_800, "/exit\r"]
] as const;
const timers = actions.map(([delay, input]) => setTimeout(() => terminal.write(input), delay));
const timeout = setTimeout(() => child.kill("SIGKILL"), 18_000);

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
  ["turn timer tick", /\[1s\]/i],
  ["context remaining", /75% context left/i],
  ["session tokens", /18\.5K tokens/i],
  ["active goal footer", /Pursuing goal \(40K \/ 50K\)/i],
  ["paused goal footer", /Goal paused \(\/goal resume\)/i],
  ["model picker", /Select model/i],
  ["effort picker", /Select reasoning effort/i],
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

if (/Shift\+Tab mode · Ctrl\+N model/i.test(plain)) {
  throw new Error(`Unexpected shortcut legend below the editor.\n${plain.slice(-6_000)}`);
}

let stateOffset = 0;
for (const [label, pattern] of [
  ["mode shortcut", /alpha\/model · plan · low/i],
  ["autonomy shortcut", /alpha\/model · build · low/i],
  ["model shortcut", /beta\/model · build · low/i],
  ["effort shortcut", /beta\/model · build · high/i],
  ["model picker switch", /alpha\/model · build · high/i],
  ["effort picker switch", /alpha\/model · build · low/i]
] as const) {
  const match = pattern.exec(plain.slice(stateOffset));
  if (!match) throw new Error(`Missing ordered ${label} state in feature TUI smoke.\n${plain.slice(-6_000)}`);
  stateOffset += (match.index ?? 0) + match[0].length;
}

for (const [label, pattern] of [
  ["mode transcript", /Mode: plan/i],
  ["autonomy transcript", /Autonomy level:/i],
  ["model command transcript", /[›↪]\s*\/model\s+(?:alpha|beta)\/model/i],
  ["model response transcript", /Model switched to/i],
  ["effort command transcript", /[›↪]\s*\/effort\s+(?:low|high)/i],
  ["effort response transcript", /Reasoning effort switched to/i]
] as const) {
  if (pattern.test(plain)) throw new Error(`Unexpected ${label} in feature TUI smoke.\n${plain.slice(-6_000)}`);
}

console.log("TUI feature smoke test passed.");
