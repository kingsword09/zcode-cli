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
  throw new Error(`Timed out waiting for ${label}.\n${plainText(output).slice(-6_000)}`);
}

async function sendAndWait(input: string, label: string, pattern: RegExp, timeoutMs?: number): Promise<void> {
  const start = output.length;
  terminal.write(input);
  await waitFor(label, pattern, start, timeoutMs);
}

async function sendAndSettle(input: string): Promise<void> {
  const start = output.length;
  terminal.write(input);
  const startedAt = Date.now();
  while (output.length === start && Date.now() - startedAt < 2_000) await Bun.sleep(20);
  await Bun.sleep(25);
}

const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);

let interactionError: unknown;
try {
  await waitFor("welcome screen", /ZCode/i);
  await sendAndWait("/help\r", "long help", /Use \/help <command> for details/i);
  await sendAndWait("\x1b[Z", "plan shortcut", /alpha\/model · plan · low/i);
  await sendAndWait("\x0c", "autonomy shortcut", /alpha\/model · build · low/i);
  await sendAndWait("\x0e", "model shortcut", /beta\/model · build · low/i);
  await sendAndWait("\t", "effort shortcut", /beta\/model · build · high/i);
  await sendAndWait("/model\r", "model picker", /Select model/i);
  await sendAndWait("alpha\r", "model picker selection", /alpha\/model · build · high/i);
  await sendAndWait("/effort\r", "effort picker", /Select reasoning effort/i);
  await sendAndWait("\x1b[B\r", "effort picker selection", /alpha\/model · build · low/i);
  await sendAndWait("\x16", "clipboard image", /1 image attached/i);
  await sendAndWait("inspect\r", "feature turn", /Feature prompt complete\./i, 12_000);
  await waitFor("feature turn completion", /Feature background audit · turn complete/i, 0, 4_000);
  await sendAndWait("\x0f", "expanded Agent transcript", /Response:\s*Nested rendering inspected\./i);

  await sendAndWait("/diff\r", "diff source picker", /Select current workspace changes or a completed turn/i);
  await sendAndWait("\x1b[B\r", "turn diff file list", /Diff · Turn \d+/i);
  await sendAndWait("\r", "turn diff detail", /Page 1\/\d+/i);
  await sendAndSettle("\x1b");
  await sendAndSettle("\x1b");
  await sendAndSettle("\x1b");

  await sendAndWait("/context\r", "context details", /Estimated prompt composition by characters/i);
  await sendAndSettle("\r");
  await sendAndWait("/status\r", "status details", /ZCode Status/i);
  await sendAndSettle("\r");
  await sendAndWait("/transcript latest\r", "transcript navigation", /Transcript \d+\/\d+/i);
  await sendAndWait("\x1bp", "Alt+Up transcript navigation", /Transcript \d+\/\d+/i);
  await sendAndSettle("\x1b");
  await sendAndWait("/search inspect\r", "transcript search", /Search 1\/\d+: inspect/i);
  await sendAndWait("n", "next transcript search match", /Search 2\/\d+: inspect/i);
  await sendAndSettle("\x1b");
  await sendAndWait("/search Slash commands\r", "oversized transcript match", /Page 1\/\d+ · PageUp\/PageDown scroll/i);
  await sendAndWait("\x1b[6~", "transcript PageDown", /Page 2\/\d+ · PageUp\/PageDown scroll/i);
  await sendAndSettle("\x1b");

  await sendAndWait("/mcp\r", "MCP picker", /MCP servers/i);
  await sendAndWait("\r", "MCP action", /MCP connected: docs/i);
  await sendAndWait("/workflows\r", "workflow picker", /Workflow runs/i);
  await sendAndWait("\r", "workflow detail", /Workflow · run_feature/i);
  await sendAndWait("\x1b[B\r", "workflow stop", /Status: cancelled/i);
  await sendAndSettle("\x1b");
  await sendAndWait("/tasks\r", "background task picker", /Background tasks/i);
  await sendAndWait("\r", "background task detail", /Background task · bg_feature/i);
  await sendAndSettle("\r");
  await sendAndWait("/goal pause\r", "paused goal", /Goal paused \(\/goal resume\)/i);
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

const plain = plainText(output);

if (process.env.ZCODE_TUI_SMOKE_DEBUG === "1") console.log(plain);
if (code !== 0) throw new Error(`Feature TUI smoke exited with ${code}.\n${plain.slice(-6_000)}`);

for (const [label, pattern] of [
  ["long help output", /Use \/help <command> for details/i],
  ["turn timer tick", /\[1s\]/i],
  ["context remaining", /75% context left/i],
  ["session tokens", /18\.5K tokens/i],
    ["active goal footer", /Pursuing goal \(40K \/ 50K\)/i],
    ["persistent runtime activity", /Activity · 1 in background · 1 open task · \/tasks/i],
    ["background task summary", /Feature background audit · bg_feature/i],
    ["background task dialog", /Background task · bg_feature/i],
  ["paused goal footer", /Goal paused \(\/goal resume\)/i],
  ["model picker", /Select model/i],
  ["effort picker", /Select reasoning effort/i],
  ["image attachment", /1 image attached/i],
  ["completed thinking card", /◇ Thought/i],
  ["reasoning content", /Inspecting the repository before using tools\./i],
  ["updated plan", /● Updated Plan/i],
  ["plan summary", /2 completed · 1 in progress · 0 pending/i],
  ["active plan item", /□ Verify the TUI/i],
  ["pre-tool assistant commentary", /I will inspect the repository first\./i],
  ["tool execution", /✓ Read demo\.ts/i],
  ["tool result", /source text/i],
  ["file diff header", /✓ Edit demo\.ts \+1 -1/i],
  ["nested Agent tree", /child tool/i],
  ["expanded Agent response", /Response:\s*Nested rendering inspected\./i],
  ["diff browser", /Diff · Turn \d+/i],
  ["diff detail paging", /Page 1\/\d+/i],
  ["context detail", /Estimated prompt composition by characters/i],
  ["status detail", /ZCode Status/i],
  ["transcript navigation", /Transcript \d+\/\d+/i],
  ["transcript search navigation", /Search 2\/\d+: inspect/i],
  ["transcript page navigation", /Page 2\/\d+ · PageUp\/PageDown scroll/i],
  ["removed diff line", /│- const value = 1;/i],
  ["added diff line", /│\+ const value = 2;/i],
  ["final assistant response", /Feature prompt complete\./i],
  ["Mermaid diagram", /◇ Mermaid · flowchart/i],
  ["CJK Mermaid nodes", /用户输入[\s\S]*编辑器面板/i],
  ["MCP picker", /MCP servers/i],
  ["MCP action", /MCP connected: docs/i],
  ["workflow picker", /Workflow runs/i],
  ["workflow detail", /Feature workflow/i],
  ["workflow stop", /Status: cancelled/i]
] as const) {
  if (!pattern.test(plain)) throw new Error(`Missing ${label} in feature TUI smoke.\n${plain.slice(-6_000)}`);
}

if (!/Token usage: total=9,500 input=5,000 \(\+ 9,000 cached\) output=4,000 \(reasoning 500\)/i.test(plain)) {
  throw new Error(`Missing token usage exit summary.\n${plain.slice(-6_000)}`);
}

if (!/To continue this session, run zcode --resume feature-session/i.test(plain)) {
  throw new Error(`Missing session resume exit hint.\n${plain.slice(-6_000)}`);
}

if (/Shift\+Tab mode · Ctrl\+N model/i.test(plain)) {
  throw new Error(`Unexpected shortcut legend below the editor.\n${plain.slice(-6_000)}`);
}

if (/\b(?:ready|switching)\b/i.test(plain)) {
  throw new Error(`Unexpected transient state log in feature TUI smoke.\n${plain.slice(-6_000)}`);
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
