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
  env: {
    ...process.env,
    CI: "1",
    HOME: temporaryHome,
    USERPROFILE: temporaryHome,
    TERM: "xterm-256color",
    TERM_PROGRAM: "iTerm.app",
    ZCODE_APP_CLI_BUN: process.execPath,
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

async function waitFor(label: string, pattern: RegExp, start = 0, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pattern.test(plainText(output.slice(start)))) return;
    if (child.exitCode !== null) break;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.\n${plainText(output).slice(-6_000)}`);
}

async function sendAndWait(input: string, label: string, pattern: RegExp, timeoutMs?: number): Promise<number> {
  const start = output.length;
  terminal.write(input);
  await waitFor(label, pattern, start, timeoutMs);
  return start;
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
  await waitFor("restored startup transcript", /Restored startup response\./i);
  await sendAndWait("\x1b", "double-Esc rewind hint", /Esc again to rewind conversation/i);
  await sendAndWait("\x1b", "rewind target picker", /Rewind conversation[\s\S]*Restored later prompt/i);
  await sendAndWait("\x1b[B\r", "selected older rewind target", /Return to before: Restored startup prompt/i);
  await sendAndWait("\x1b", "rewind scope returned to targets", /Choose the user input to return to/i);
  await sendAndWait("\r", "latest rewind target scope", /Return to before: Restored later prompt/i);
  await sendAndWait("\r", "conversation and workspace rewind", /Conversation and workspace rewound[\s\S]*selected input was restored to the editor/i);
  await sendAndSettle("\x15");
  await sendAndWait("/settings\r", "settings picker", /ZCode settings/i);
  await sendAndWait("\x1b[B\r", "notification timing picker", /When to notify/i);
  await sendAndWait("\x1b[B\r", "saved setting returned to root", /When to notify: always saved · environment override remains active/i);
  const savedConfig = (await Bun.file(join(temporaryHome, ".zcode", "cli", "config.json")).json()) as {
    ui?: { notifications?: { condition?: string } };
  };
  if (savedConfig.ui?.notifications?.condition !== "always") {
    throw new Error("Settings picker did not persist the notification condition.");
  }
  await sendAndWait("\r", "reopened notification timing", /Select when completed and failed turns notify you\./i);
  await sendAndWait("\x1b", "child escape returned to settings", /No changes · Esc closes settings/i);
  await sendAndSettle("\x1b");
  await sendAndWait("/login\r", "login setup picker", /Set Up Coding Plan/i);
  await sendAndWait("\r", "masked API key prompt", /Enter Z\.AI Coding Plan API Key/i);
  await sendAndWait("\x1b", "return to login picker", /API key entry cancelled\.[\s\S]*Set Up Coding Plan/i);
  await sendAndWait("\r", "reopened API key prompt", /Enter Z\.AI Coding Plan API Key/i);
  await sendAndWait("feature-secret-api-key", "masked API key value", /\*{20,}/i);
  await sendAndWait("\r", "API key setup", /Configured Z\.AI Coding Plan\./i);
  const overrideLoginStart = await sendAndWait("/login\r", "suspended login command", /External login command completed\./i);
  await waitFor("refreshed login state", /Model access configured via[\s\S]*config\.json/i, overrideLoginStart);
  await sendAndWait("/disable-login-override\r", "disable login override", /Login override disabled\./i);
  await sendAndWait("/login\r", "reopened login setup picker", /Set Up Coding Plan/i);
  const defaultLoginStart = await sendAndWait("\x1b[B\r", "default suspended OAuth command", /External login command completed\./i);
  await waitFor("default OAuth login refresh", /Model access configured via[\s\S]*config\.json/i, defaultLoginStart);
  const directLoginStart = await sendAndWait(
    "/login zai-coding-plan\r",
    "direct suspended OAuth command",
    /External login command completed\./i
  );
  await waitFor("direct OAuth login refresh", /Model access configured via[\s\S]*config\.json/i, directLoginStart);
  await sendAndWait("/prepare-failing-login\r", "prepare OAuth failure", /Failing login prepared\./i);
  await sendAndWait("/login\r", "failure login setup picker", /Set Up Coding Plan/i);
  await sendAndWait("\x1b[B\r", "restored OAuth failure", /Login failed: OAuth HTTP error 404 \(empty or non-JSON response\)/i);
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
  await sendAndWait("inspect @ind", "workspace path suggestions", /index\.ts[\s\S]*src\/index\.ts/i);
  await sendAndWait("\r", "workspace path completion", /inspect @src\/index\.ts/i);
  await sendAndWait("\x1b[O\r", "feature turn", /Feature prompt complete\./i, 12_000);
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
  await sendAndWait("/resume\r", "resume picker", /Resume Session/i);
  await sendAndWait("\r", "selected session transcript", /Restored selected response\./i);
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

const turnNotifications = output.match(/\x1b\]9;ZCode ·/gu) ?? [];
if (turnNotifications.length !== 1 || !output.includes("\x1b]9;ZCode · Feature prompt complete.")) {
  throw new Error(`Expected one unfocused agent-turn notification, received ${turnNotifications.length}.`);
}

for (const [label, pattern] of [
  ["restored startup transcript", /Restored startup response\./i],
  ["restored selected transcript", /Restored selected response\./i],
  ["double-Esc rewind hint", /Esc again to rewind conversation/i],
  ["rewind target picker", /Rewind conversation[\s\S]*Restored later prompt/i],
  ["selected older rewind target", /Return to before: Restored startup prompt/i],
  ["conversation and workspace rewind", /Conversation and workspace rewound/i],
  ["settings picker", /ZCode settings/i],
  ["saved setting returned to root", /When to notify: always saved · environment override remains active/i],
  ["child escape returned to settings", /No changes · Esc closes settings/i],
  ["login setup picker", /Set Up Coding Plan/i],
  ["custom provider login entry", /Custom provider/i],
  ["API key prompt cancellation", /API key entry cancelled\./i],
  ["masked API key command", /\/login zai-coding-plan-api-key \[redacted\]/i],
  ["API key setup", /Configured Z\.AI Coding Plan\./i],
  ["suspended login command", /External login command completed\./i],
  ["refreshed login state", /Model access configured via[\s\S]*config\.json/i],
  ["default OAuth suspension", /Login override disabled\.[\s\S]*External login command completed\./i],
  ["OAuth HTTP diagnostic", /Login failed: OAuth HTTP error 404 \(empty or non-JSON response\)/i],
  ["resume picker", /Resume Session/i],
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
  ["workspace file reference", /[›↪]\s*inspect @src\/index\.ts/i],
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

if (/Wait for the active turn or press Ctrl\+C before running a slash command/i.test(plain)) {
  throw new Error(`Resume selection was blocked by the active submission.\n${plain.slice(-6_000)}`);
}

if (plain.includes("feature-secret-api-key") || plain.includes("override-fixture-key")) {
  throw new Error(`API key leaked into TUI output.\n${plain.slice(-6_000)}`);
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
