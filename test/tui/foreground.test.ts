import { expect, test } from "bun:test";
import { join } from "node:path";

import { runtimeTestEnv } from "../fixtures/runtime-env.ts";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

const command = [Bun.which("node")!, join(import.meta.dir, "fixtures/foreground.mjs")];

function environment(home: string, overrides: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries({ ...runtimeTestEnv(home), ...overrides })
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

test("foreground accepts a draft while runtime is blocked and never sends it before readiness", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-foreground-" });
  await using session = TerminalSession.start({ command, workspace, env: environment(workspace.home) });
  await session.waitForScreen("independent startup editor", /Starting ZCode/u);
  expect(session.screenText()).toContain("╭─ ◆ ZCODE");
  expect(session.screenText()).toContain("Ask a task about this workspace");
  expect(session.screenText()).not.toContain("You can type now");
  session.send("/echo draft-before-runtime\r");
  await session.waitForScreen("editable draft during blocked runtime", /draft-before-runtime/u);
  expect(await workspace.readRuntimeJournal()).not.toContain("RUNTIME_INPUT");
  const handoffCheckpoint = session.historyCheckpoint();
  await workspace.write("release-runtime", "ready");
  await session.waitForScreen("ready backend", /FOREGROUND_READY/u);
  await session.waitForScreen("runtime controls ready", /◉ guarded/u);
  await session.waitForScreen("preserved draft", /draft-before-runtime/u);
  expect(session.rawHistory(handoffCheckpoint)).not.toContain("\x1b[?2004l");
  expect(session.screenText()).not.toContain("Starting ZCode");
  expect(await workspace.readRuntimeJournal()).not.toContain("RUNTIME_INPUT");
  await session.sendAndWait("\r", "explicitly submitted draft", /FOREGROUND_REPLY \/echo draft-before-runtime/u);
  await session.sendAndWait("/copy\r", "foreground clipboard delivery", /Copied the latest assistant response/u);
  expect(await workspace.readRuntimeJournal()).not.toContain("]52;c;");
  await session.exit();
  expect(await workspace.readRuntimeJournal()).toContain("RUNTIME_CLOSED");
}, 20_000);

test("foreground uses the saved fullscreen shell and light palette from its first frame without restarting it", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-foreground-appearance-" });
  const settings = join(workspace.directory, "startup-settings.json");
  await workspace.write("startup-settings.json", JSON.stringify({ ui: { tuiMode: "fullscreen", theme: "light" } }));
  await using session = TerminalSession.start({
    command,
    workspace,
    env: environment(workspace.home, {
      ZCODE_CLI_SETTINGS_FILE: settings,
      ZCODE_TUI_MODE: "",
      ZCODE_TEST_THEME: "light",
      NO_COLOR: ""
    })
  });
  await session.waitForScreen("themed fullscreen startup", /Starting ZCode/u);
  expect(session.screenText()).toContain("Ask a task about this workspace");
  expect(session.screenText()).toContain("Workspace");
  expect(session.rawHistory()).toContain("\x1b[?1049h");
  expect(session.rawHistory()).toContain("\x1b[38;5;25m");
  session.send("/echo fullscreen-draft");
  await session.waitForScreen("fullscreen startup draft", /fullscreen-draft/u);
  const handoffCheckpoint = session.historyCheckpoint();
  await workspace.write("release-runtime", "ready");
  await session.waitForScreen("fullscreen runtime ready", /◉ guarded/u);
  await session.waitForScreen("fullscreen preserved draft", /fullscreen-draft/u);
  const handoff = session.rawHistory(handoffCheckpoint);
  expect(handoff).not.toContain("\x1b[?1049l");
  expect(handoff).not.toContain("\x1b[?1049h");
  expect(handoff).not.toContain("\x1b[?2004l");
  await session.sendAndWait("\r", "fullscreen draft submission", /FOREGROUND_REPLY \/echo fullscreen-draft/u);
  await session.exit();
  expect(session.rawHistory()).toContain("\x1b[?1049l");
  expect(session.historyText()).toContain("FOREGROUND_RAW_MODE false");
}, 20_000);

test("foreground cancellation terminates a blocked runtime and restores the terminal", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-foreground-cancel-" });
  await using session = TerminalSession.start({ command, workspace, env: environment(workspace.home) });
  await session.waitForScreen("startup editor", /Starting ZCode/u);
  session.send("\x03");
  await session.waitForHistory("terminal restored", /FOREGROUND_RAW_MODE false/u);
  await expect(session.exit()).rejects.toThrow("code 130");
  const journal = await workspace.readRuntimeJournal();
  expect(journal).not.toContain("RUNTIME_INPUT");
  const pid = /RUNTIME_PID (\d+)/u.exec(journal)?.[1];
  if (pid) expect(() => process.kill(Number(pid), 0)).toThrow();
}, 10_000);

for (const phase of ["startup", "ready"]) {
  test(`foreground handles runtime death during ${phase} without stranding the terminal`, async () => {
    await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-foreground-failure-" });
    await using session = TerminalSession.start({
      command, workspace, env: environment(workspace.home, { ZCODE_TEST_RUNTIME_FAILURE: phase === "startup" ? "1" : "0" })
    });
    await session.waitForScreen("startup editor", /Starting ZCode/u);
    await workspace.write("release-runtime", "ready");
    if (phase === "ready") {
      await session.waitForScreen("ready backend", /FOREGROUND_READY/u);
      session.send("/crash\r");
    }
    await session.waitForHistory("explicit backend failure", /FOREGROUND_FAILURE/u);
    await session.waitForHistory("terminal restored after failure", /FOREGROUND_RAW_MODE false/u);
    await expect(session.exit()).rejects.toThrow("code 1");
  }, 10_000);
}

test("Bun source launches hand off to a Node foreground and cancel without hanging IPC", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-foreground-source-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "../../bin/zcode.ts")],
    workspace,
    env: environment(workspace.home, { ZCODE_NODE: Bun.which("node")! })
  });
  await session.waitForScreen("Node foreground editor", /Starting ZCode/u);
  session.send("\x03");
  await expect(session.exit()).rejects.toThrow("code 130");
}, 10_000);

test("foreground does not report success when native runtime cleanup fails", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-foreground-cleanup-" });
  await workspace.write("release-runtime", "ready");
  await using session = TerminalSession.start({
    command, workspace, env: environment(workspace.home, { ZCODE_TEST_RUNTIME_CLEANUP_FAILURE: "1" })
  });
  await session.waitForScreen("ready backend", /FOREGROUND_READY/u);
  await expect(session.exit()).rejects.toThrow("code 1");
  expect(session.historyText()).toContain("status 9 during cleanup");
}, 10_000);
