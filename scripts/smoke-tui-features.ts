#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = join(root, "test", "fixtures", "tui-features.ts");
const temporaryHome = await mkdtemp(join(tmpdir(), "zcode-tui-features-"));
const decoder = new TextDecoder();
const renderSettleMilliseconds = 25;
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

async function waitFor(label: string, pattern: RegExp, start = 0, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pattern.test(plainText(output.slice(start)))) return;
    if (child.exitCode !== null) break;
    await Bun.sleep(renderSettleMilliseconds);
  }
  throw new Error(`Timed out waiting for ${label}.\n${plainText(output).slice(-6_000)}`);
}

async function sendAndWait(input: string, label: string, pattern: RegExp, timeoutMs?: number): Promise<number> {
  const start = output.length;
  terminal.write(input);
  await waitFor(label, pattern, start, timeoutMs);
  await Bun.sleep(renderSettleMilliseconds);
  return start;
}

async function sendAndSettle(input: string): Promise<void> {
  const start = output.length;
  terminal.write(input);
  const startedAt = Date.now();
  while (output.length === start && Date.now() - startedAt < 2_000) await Bun.sleep(20);
  await Bun.sleep(renderSettleMilliseconds);
}

const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);

let interactionError: unknown;
try {
  await waitFor("welcome screen", /ZCode/i);
  await waitFor("restored startup transcript", /Restored startup response\./i);
  await waitFor("interactive editor", /◈ alpha\/model ─ ◉ build/i);
  await sendAndWait("\x1b", "double-Esc rewind hint", /Esc again to rewind conversation/i);
  await sendAndWait("\x1b", "rewind target picker", /Rewind conversation[\s\S]*Restored later prompt/i);
  await sendAndWait("\x1b[B\r", "selected older rewind target", /Return to before: Restored startup prompt/i);
  await sendAndWait("\x1b", "rewind scope returned to targets", /Choose the user input to return to/i);
  await sendAndWait("\r", "latest rewind target scope", /Return to before: Restored later prompt/i);
  await sendAndWait("\r", "conversation and workspace rewind", /Conversation and workspace rewound[\s\S]*selected input was restored to the editor/i);
  await sendAndSettle("\x15");
  await sendAndWait("/settings\r", "settings picker", /ZCode settings/i);
  await sendAndWait("\x1b[B\x1b[B\r", "notification timing picker", /When to notify/i);
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
  await sendAndWait("\x1b[Z", "edit mode shortcut", /◈ alpha\/model ─ ◉ edit ─ ⚡ low/i);
  await Bun.sleep(1_100);
  await sendAndWait("\x1b[Z", "yolo mode shortcut", /◈ alpha\/model ─ ◉ yolo ─ ⚡ low/i);
  await sendAndWait("\x1b[Z", "plan mode shortcut", /◈ alpha\/model ─ ◉ plan ─ ⚡ low/i);
  await sendAndWait("\x0e", "model shortcut", /◈ beta\/model ─ ◉ plan ─ ⚡ low/i);
  await sendAndWait("\t", "effort shortcut", /◈ beta\/model ─ ◉ plan ─ ⚡ high/i);
  // /model — flat quick-switch picker (session-level, not persistent)
  await sendAndWait("/model\r", "model picker", /Select model/i);
  await sendAndWait("alpha\r", "model picker selection", /◈ alpha\/model ─ ◉ plan ─ ⚡ high/i);
  // /settings → Model providers — three-level cascade (provider → main → lite)
  // Use sendAndSettle + a settle delay to flush any buffered key sequences
  // from prior test steps before driving the Model providers cascade.
  await sendAndSettle("/settings\r");
  await waitFor("settings menu (re-opened)", /Model providers\s+(?:Session:|Saved:)/i);
  await Bun.sleep(renderSettleMilliseconds * 2);
  await sendAndWait("\r", "model providers entry", /Configure the main and lite/i);
  await sendAndWait("\r", "provider selected (alpha)", /Select main model/i);
  // Esc at lite → back to main picker (not provider)
  await sendAndWait("\r", "lite model picker with Same as main default", /Select lite model[\s\S]*Same as main/i);
  await sendAndWait("\x1b", "lite Esc back to main", /Select main model/i);
  // Esc at main → back to provider picker
  await sendAndWait("\x1b", "main Esc back to provider", /Configure the main and lite/i);
  // Re-enter and complete the full cascade
  await sendAndWait("\r", "provider selected (re-enter)", /Select main model/i);
  await sendAndWait("\r", "lite model picker (re-enter)", /Select lite model/i);
  // Press Enter directly — should confirm "Same as main" (the default)
  await sendAndWait("\r", "model cascade confirm (Same as main default)", /Model config saved/i);
  // The cascade returns to the settings menu — Esc to close it and return
  // to the editor before continuing with /effort.
  await sendAndSettle("\x1b");
  await sendAndWait("/effort\r", "effort picker", /Select reasoning effort/i);
  await sendAndWait("\x1b[B\r", "effort picker selection", /◈ alpha\/model ─ ◉ plan ─ ⚡ low/i);
  await sendAndWait("\x1b[Z", "build mode shortcut", /◈ alpha\/model ─ ◉ build ─ ⚡ low/i);
  await sendAndWait(
    "review long plan\r",
    "plan approval choices",
    /Ready to implement\?[\s\S]*Plan 1–\d+ of \d+[\s\S]*Approve and continue/i
  );
  await sendAndWait(
    "\x0f",
    "expanded plan review",
    /Ready to implement\? · Plan[\s\S]*Ctrl\+O or Esc return/i
  );
  await sendAndWait(
    "\x1b[6~",
    "scrolled plan review",
    /Plan (?:[2-9]|[1-9]\d+)–\d+ of \d+/i
  );
  await sendAndWait("\x1b", "returned to plan choices", /Approve and continue/i);
  await sendAndWait("\r", "approved reviewed plan", /Plan approval fixture complete: allow\./i);
  await sendAndWait("review plan feedback\r", "plan feedback choices", /Ready to implement\?/i);
  await sendAndWait("\x1b[B\r", "implementation instructions prompt", /What should ZCode keep in mind while implementing\?/i);
  await sendAndWait(
    "Preserve the verified terminal layout.\r",
    "queued plan feedback",
    /Plan approval fixture complete: deny · plan_approval_feedback\./i
  );
  await sendAndWait("\x16", "first clipboard image", /Images[\s\S]*\[Image #1\]/i);
  await sendAndWait("\x16", "second clipboard image", /Images[\s\S]*\[Image #1\][\s\S]*\[Image #2\]/i);
  await sendAndWait("/attachments\r", "attachment command selection", /Images[\s\S]*› \[Image #2\]/i);
  await sendAndWait("\x1b", "attachment command return", /Images · \[Image #1\] · \[Image #2\][\s\S]*↑ manage/i);
  await sendAndWait("inspect @ind", "workspace path suggestions", /index\.ts[\s\S]*src\/index\.ts/i);
  await sendAndWait("\r", "workspace path completion", /inspect @src\/index\.ts/i);
  await sendAndWait("$au", "skill suggestions", /audit[\s\S]*Review technical quality\./i);
  await sendAndWait("\r", "skill completion", /inspect @src\/index\.ts \$audit/i);
  await sendAndSettle("\x01");
  await sendAndWait(
    "\x1b[A",
    "attachment selection",
    /Images[\s\S]*› \[Image #2\][\s\S]*Backspace\/Delete remove/i
  );
  await sendAndWait("\x1b[D", "previous attachment", /Images[\s\S]*› \[Image #1\]/i);
  await sendAndWait("\x1b[3~", "removed attachment", /Images › \[Image #1\]/i);
  await sendAndWait("\x1b[B", "returned from attachments", /Images · \[Image #1\][\s\S]*↑ manage/i);
  await sendAndSettle("\x05");
  const featureTurnStart = await sendAndWait(
    "\r",
    "submitted image turn",
    /›\s*inspect @src\/index\.ts \$audit\s+\[1 image\][\s\S]*◇ Thought/i,
    4_000
  );
  const activeTurnProjection = plainText(output.slice(featureTurnStart));
  if (/Images\s+·\s+\[Image #1\]/i.test(activeTurnProjection)) {
    throw new Error("Submitted images remained in the pending attachment row during the active turn.");
  }
  await waitFor(
    "model stream stalled status",
    /Model stream stalled\s+·\s+idle 60s/i,
    featureTurnStart
  );
  await waitFor(
    "model retry status",
    /Retrying model request\s+·\s+1\/5\s+·\s+in 1s/i,
    featureTurnStart
  );
  await waitFor(
    "advancing turn timer",
    /[🕐-🕛] [1-9]\d*s/u,
    featureTurnStart,
    4_000
  );
  await sendAndWait(
    "Keep the final response concise.\r",
    "pending active-turn steer",
    /Steering current turn · 1 waiting[\s\S]*↪ Keep the final response concise\.[\s\S]*waiting for the next model step/i
  );
  await sendAndWait(
    "Edit this rejected steer.\r",
    "rejected steer fallback",
    /Steer was not accepted \(turn not steerable\); queued for the next turn\.[\s\S]*Queued next turn · 1 input[\s\S]*Edit this rejected steer\./i
  );
  await sendAndWait(
    "\x1b[1;2D",
    "restored rejected steer with Shift+Left",
    /Edit this rejected steer\.[\s\S]*◈ alpha\/model/i
  );
  await sendAndSettle("\x15");
  await sendAndWait(
    "Revise this queued follow-up.",
    "editable follow-up draft",
    /Revise this queued follow-up\./i
  );
  await sendAndWait(
    "\t",
    "queued follow-up",
    /Queued next turn · 1 input[\s\S]*↳ Revise this queued follow-up\.[\s\S]*Alt\+Up/i
  );
  await sendAndWait(
    "\x1bp",
    "restored queued follow-up",
    /Revise this queued follow-up\.[\s\S]*◈ alpha\/model/i
  );
  await sendAndSettle("\x15");
  await sendAndWait(
    "Run this after the active turn.\t",
    "automatic next-turn follow-up",
    /Queued next turn · 1 input[\s\S]*Run this after the active turn\./i
  );
  await waitFor("feature turn", /Feature prompt complete\./i, featureTurnStart, 12_000);
  await waitFor(
    "compact background agent reply",
    /Background agent replied[\s\S]*agent_feature · \/tasks/i,
    featureTurnStart,
    4_000
  );
  await waitFor(
    "compact background task failure",
    /Background task needs attention[\s\S]*agent_feature · \/tasks/i,
    featureTurnStart,
    4_000
  );
  terminal.write("\x1b");
  await Bun.sleep(75);
  if (child.exitCode !== null) throw new Error("Esc exited ZCode during a background handoff.");
  await waitFor(
    "compact handoff failure",
    /Background result processing failed[\s\S]*agent_feature · \/tasks/i,
    featureTurnStart,
    4_000
  );
  await waitFor("queued follow-up turn", /Queued follow-up started after the active turn\./i, featureTurnStart, 4_000);
  await waitFor("feature turn completion", /Feature background audit · turn complete/i, 0, 4_000);
  await sendAndWait(
    "Continue after the stuck background handoff.\r",
    "background handoff preemption",
    /Background result processing was interrupted; starting your queued input\.[\s\S]*Queued input started after interrupting the stuck background handoff\./i
  );
  const foregroundBeforeTaskCenter = plainText(output.slice(featureTurnStart));
  if (/Task-scoped agent handoff completed|Coordinator began processing the failed task result|Background-only reasoning|background_fetch|Coordinator dispatching background research|background-research|Inspect nested rendering/i.test(foregroundBeforeTaskCenter)) {
    throw new Error("Task-scoped background output leaked into the foreground transcript.");
  }
  if (/Turn cancelled\./i.test(foregroundBeforeTaskCenter)) {
    throw new Error("Esc cancelled the foreground submission while a background handoff was active.");
  }
  const expandedForegroundStart = await sendAndWait("\x0f", "expanded foreground tool transcript", /source text/i);
  const expandedForeground = plainText(output.slice(expandedForegroundStart));
  if (/Coordinator dispatching background research|background-research|Inspect nested rendering|Nested rendering inspected/i.test(expandedForeground)) {
    throw new Error("Expanding foreground tools exposed a background Agent tree.");
  }
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
  await sendAndWait("/search Slash commands\r", "oversized transcript match", /Page 1\/\d+ · ←\/→ or PageUp\/PageDown scroll/i);
  await sendAndWait("\x1b[C", "transcript scroll right", /Page 2\/\d+ · ←\/→ or PageUp\/PageDown scroll/i);
  await sendAndSettle("\x1b");

  await sendAndWait("/mcp\r", "MCP picker", /MCP servers/i);
  await sendAndWait("\r", "MCP action", /MCP connected: docs/i);
  await sendAndWait("/workflows\r", "workflow picker", /Workflow runs/i);
  await sendAndWait("\r", "workflow detail", /Workflow · run_feature/i);
  await sendAndWait("\x1b[B\r", "workflow stop", /Status: cancelled/i);
  await sendAndSettle("\x1b");
  await sendAndWait("/activity\r", "complete activity view", /Current activity[\s\S]*Verify the TUI/i);
  await sendAndSettle("\r");
  await sendAndWait("/tasks\r", "background task picker", /Background tasks/i);
  await sendAndWait("\r", "Bash task detail", /Bash task · bg_feature/i);
  await sendAndWait("\x1b", "return to background task list", /Background tasks/i);
  await sendAndWait(
    "\x1b[B\r",
    "agent task detail",
    /Agent \(reviewer\) task · agent_feature[\s\S]*Background agent reply stored in task activity\.[\s\S]*Background result failed visibly\./i
  );
  const resumePromptStart = await sendAndWait("\r", "resume agent prompt", /Resume background agent/i);
  if (/alpha\/model/i.test(plainText(output.slice(resumePromptStart)))) {
    throw new Error("The main composer remained visible beneath the background agent prompt.");
  }
  await sendAndWait(
    "Fix the recovery issue and rerun the focused test.\r",
    "resumed agent task",
    /Status: running[\s\S]*You: Fix the recovery issue and rerun the focused test\.[\s\S]*Agent "agent_feature" resumed in the background\./i
  );
  await sendAndWait("\x1b[B\r", "restart active agent prompt", /Restart background agent/i);
  await sendAndWait(
    "Restart from the saved state and finish the remaining verification.\r",
    "restarted active agent task",
    /Status: running[\s\S]*Agent "agent_feature" restarted in the background\./i
  );
  await sendAndWait("\x1b", "return to task list after resume", /Background tasks/i);
  await sendAndSettle("\x1b");
  const timerTurnStart = output.length;
  terminal.write("verify aggregate timer\r");
  await waitFor(
    "aggregate timer foreground completion",
    /Timer foreground complete; background still running\./i,
    timerTurnStart
  );
  await waitFor(
    "aggregate timer continuing after foreground",
    /Timer foreground complete; background still running\.[\s\S]*[🕐-🕛] [1-9]\d*s/u,
    timerTurnStart,
    4_000
  );
  const timerForegroundSettled = output.length;
  await waitFor(
    "aggregate timer settling after background failure",
    /✓ [1-9]\d*s/u,
    timerForegroundSettled,
    5_000
  );
  await sendAndWait("/goal pause\r", "paused goal", /Goal: Paused \(\/goal resume\)/i);
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
if (turnNotifications.length !== 8
  || !output.includes("\x1b]9;ZCode · Plan approval fixture complete: allow.")
  || !output.includes("\x1b]9;ZCode · Plan approval fixture complete: deny · plan_approval_feedback.")
  || !output.includes("\x1b]9;ZCode · Queued follow-up started after the active turn.")
  || !output.includes("\x1b]9;ZCode · Queued input started after interrupting the stuck background handoff.")
  || !output.includes("\x1b]9;ZCode · Timer foreground complete; background still running.")
  || !output.includes("\x1b]9;ZCode · Background agent replied · agent_feature · /tasks")
  || !output.includes("\x1b]9;ZCode · Background task needs attention · agent_feature · /tasks")
  || !output.includes("\x1b]9;ZCode · Background result processing failed · agent_feature · /tasks")
  || output.includes("\x1b]9;ZCode · Feature prompt complete.")) {
  throw new Error(`Expected eight idle-boundary and task notifications, received ${turnNotifications.length}.`);
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
  ["context remaining", /ctx 75% left/i],
  ["session tokens", /18\.5K tokens/i],
  ["active goal footer", /Goal: Active \(40K \/ 50K\)/i],
  ["persistent runtime activity", /Activity · 1 in background · 1 open task · \/tasks/i],
  ["background task summary", /Feature background audit · bg_feature/i],
  ["Bash task dialog", /Bash task · bg_feature/i],
  ["agent task dialog", /Agent \(reviewer\) task · agent_feature/i],
  ["task-scoped agent output", /Task activity[\s\S]*Background agent reply stored in task activity\./i],
  ["task-scoped handoff failure", /Task activity[\s\S]*Background result failed visibly\./i],
  ["resumed agent conversation", /You: Fix the recovery issue and rerun the focused test\.[\s\S]*Agent "agent_feature" resumed in the background\./i],
  ["restarted active agent", /Agent "agent_feature" restarted in the background\./i],
  ["paused goal footer", /Goal: Paused \(\/goal resume\)/i],
  ["model picker", /Select model/i],
  ["model providers entry", /Model providers/i],
  ["effort picker", /Select reasoning effort/i],
  ["image attachment", /1 image attached/i],
  ["multiple attachment tokens", /Images[\s\S]*\[Image #1\][\s\S]*\[Image #2\]/i],
  ["attachment selection", /› \[Image #2\][\s\S]*Backspace\/Delete remove/i],
  ["attachment navigation", /› \[Image #1\]/i],
  ["workspace file reference", /›\s*inspect @src\/index\.ts/i],
  ["skill reference", /›\s*inspect @src\/index\.ts \$audit/i],
  ["skill picker", /audit[\s\S]*Review technical quality\./i],
  ["pending active-turn steering", /Steering current turn · 1 waiting[\s\S]*Keep the final response concise\./i],
  ["committed active-turn steering", /› Keep the final response concise\./i],
  ["rejected steer fallback", /Steer was not accepted \(turn not steerable\); queued for the next turn\./i],
  ["editable follow-up queue", /Queued next turn · 1 input[\s\S]*Revise this queued follow-up\./i],
  ["automatic queued follow-up", /Queued follow-up started after the active turn\./i],
  ["background handoff preemption", /Queued input started after interrupting the stuck background handoff\./i],
  ["compact background agent reply", /Background agent replied[\s\S]*agent_feature · \/tasks/i],
  ["compact background task failure", /Background task needs attention[\s\S]*agent_feature · \/tasks/i],
  ["compact handoff failure", /Background result processing failed[\s\S]*agent_feature · \/tasks/i],
  ["completed thinking card", /◇ Thought/i],
  ["updated plan", /● Updated Plan/i],
  ["plan summary", /2 completed · 1 in progress · 0 pending/i],
  ["active plan item", /□ Verify the TUI/i],
  ["pre-tool assistant commentary", /I will inspect the repository first\./i],
  ["tool execution", /Read 1 file · ⎿ demo\.ts/i],
  ["tool result", /source text/i],
  ["file diff header", /✓ Edit demo\.ts \+1 -1/i],
  ["diff browser", /Diff · Turn \d+/i],
  ["diff detail paging", /Page 1\/\d+/i],
  ["context detail", /Estimated prompt composition by characters/i],
  ["status detail", /ZCode Status/i],
  ["transcript navigation", /Transcript \d+\/\d+/i],
  ["transcript search navigation", /Search 2\/\d+: inspect/i],
  ["transcript page navigation", /Page 2\/\d+ · ←\/→ or PageUp\/PageDown scroll/i],
  ["removed diff line", /│- const value = 1;/i],
  ["added diff line", /│\+ const value = 2;/i],
  ["final assistant response", /Feature prompt complete\./i],
  ["Mermaid diagram", /◇ Mermaid · flowchart/i],
  ["CJK Mermaid nodes", /用户输入[\s\S]*编辑器面板/i],
  ["MCP picker", /MCP servers/i],
  ["MCP action", /MCP connected: docs/i],
  ["workflow picker", /Workflow runs/i],
  ["workflow detail", /Feature workflow/i],
  ["workflow stop", /Status: cancelled/i],
  ["complete activity view", /Current activity[\s\S]*Verify the TUI/i]
] as const) {
  if (!pattern.test(plain)) throw new Error(`Missing ${label} in feature TUI smoke.\n${plain.slice(-6_000)}`);
}

if (/[🕐-🕚] 0s/u.test(plain)) {
  throw new Error(`Turn timer animated more than once during its first second.\n${plain.slice(-6_000)}`);
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

if (/(?:^|\n)[ \t]*(?:ready|switching(?:…|\.\.\.)?)[ \t]*(?:\n|$)/imu.test(plain)) {
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
  ["edit mode shortcut", /◈ alpha\/model ─ ◉ edit ─ ⚡ low/i],
  ["yolo mode shortcut", /◈ alpha\/model ─ ◉ yolo ─ ⚡ low/i],
  ["plan mode shortcut", /◈ alpha\/model ─ ◉ plan ─ ⚡ low/i],
  ["model shortcut preserving plan", /◈ beta\/model ─ ◉ plan ─ ⚡ low/i],
  ["effort shortcut preserving plan", /◈ beta\/model ─ ◉ plan ─ ⚡ high/i],
  ["model picker preserving plan", /◈ alpha\/model ─ ◉ plan ─ ⚡ high/i],
  ["effort picker preserving plan", /◈ alpha\/model ─ ◉ plan ─ ⚡ low/i],
  ["build mode shortcut", /◈ alpha\/model ─ ◉ build ─ ⚡ low/i],
  ["scrollable plan approval", /Plan approval fixture complete: allow\./i],
  ["plan feedback continuation", /Plan approval fixture complete: deny · plan_approval_feedback\./i]
] as const) {
  const match = pattern.exec(plain.slice(stateOffset));
  if (!match) throw new Error(`Missing ordered ${label} state in feature TUI smoke.\n${plain.slice(-6_000)}`);
  stateOffset += (match.index ?? 0) + match[0].length;
}

for (const [label, pattern] of [
  ["mode transcript", /Mode: plan/i],
  ["model command transcript", /›\s*\/model\s+(?:alpha|beta)\/model/i],
  ["model response transcript", /Model switched to/i],
  ["effort command transcript", /›\s*\/effort\s+(?:low|high)/i],
  ["effort response transcript", /Reasoning effort switched to/i]
] as const) {
  if (pattern.test(plain)) throw new Error(`Unexpected ${label} in feature TUI smoke.\n${plain.slice(-6_000)}`);
}

console.log("TUI feature smoke test passed.");
