import { expect, test } from "bun:test";
import { join } from "node:path";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

const command = [process.execPath, join(import.meta.dir, "fixtures/startup.ts")];

for (const mode of ["lazy", "legacy"]) {
  test(`TUI loads ${mode} startup commands before constructing the editor`, async () => {
    await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-startup-" });
    await using session = TerminalSession.start({ command, workspace, env: { ZCODE_TEST_STARTUP_MODE: mode } });
    if (mode === "lazy") {
      await session.waitForScreen("startup screen", /Starting ZCode/u);
      session.send("must not submit\r");
      await session.settle();
      const journal = await workspace.readRuntimeJournal();
      expect(journal.match(/loader-called/g)?.length).toBe(1);
      expect(journal).not.toMatch(/transcript-read|mcp-read/u);
      await workspace.write("release-startup", "ready");
    }
    await session.waitForScreen("ready", /STARTUP_READY/u);
    await session.waitForScreen("startup model", /ready-model/u);
    await session.waitForScreen("startup permission mode", /guarded/u);
    await session.assertScreenExcludes("startup input not submitted", /STARTUP_SENT/u);
    for (const [prefix, description] of [
      ["/mc", "STARTUP_MCP_COMPLETION"],
      ["/he", "STARTUP_HELP_COMPLETION"],
      ["/custom-st", "STARTUP_CUSTOM_COMPLETION"]
    ] as const) {
      await session.sendAndWait(prefix, "startup command completion", new RegExp(description));
      session.send("\x03");
      await session.settle();
    }
    await session.sendAndWait("/mcp\r", "MCP picker", /fixture_server/u);
    session.send("\r");
    await session.waitForHistory("connect dispatched", /STARTUP_SENT \/mcp connect fixture_server/u);
    await session.exit();
    const journal = await workspace.readRuntimeJournal();
    expect(journal.match(/loader-called/g)?.length ?? 0).toBe(mode === "lazy" ? 1 : 0);
  }, 20_000);
}

for (const mode of ["cancel-resolve", "cancel-reject"]) {
  test(`TUI cancels pending startup and ignores ${mode} completion`, async () => {
    await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-startup-cancel-" });
    await using session = TerminalSession.start({ command, workspace, env: { ZCODE_TEST_STARTUP_MODE: mode } });
    await session.waitForScreen("startup screen", /Starting ZCode/u);
    await session.settle();
    session.send("\x03");
    await session.waitForHistory("startup cancelled without waiting for loader", /STARTUP_CANCELLED/u);
    await session.waitForHistory("raw mode restored after cancellation", /STARTUP_RAW_MODE false/u);
    await workspace.write("release-startup", "settle after cancellation");
    await expect(session.exit()).rejects.toThrow("code 130");
    const journal = await workspace.readRuntimeJournal();
    expect(journal.match(/loader-called/g)?.length).toBe(1);
    expect(journal).toContain("loader-settled");
    expect(journal).not.toMatch(/transcript-read|mcp-read/u);
    expect(session.historyText()).not.toContain("LATE_STARTUP_FAILURE");
  }, 10_000);
}

test("TUI propagates startup failures after restoring terminal raw mode", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-startup-error-" });
  await using session = TerminalSession.start({ command, workspace, env: { ZCODE_TEST_STARTUP_MODE: "failure" } });
  await session.waitForScreen("startup screen", /Starting ZCode/u);
  await workspace.write("release-startup", "fail");
  await session.waitForHistory("original failure", /STORAGE_STARTUP_FAILURE/u);
  await session.waitForHistory("raw mode restored", /STARTUP_RAW_MODE false/u);
  await expect(session.exit()).rejects.toThrow("code 1");
  expect(await workspace.readRuntimeJournal()).not.toMatch(/transcript-read|mcp-read/u);
}, 10_000);

test("TUI honors cancellation while draining input after startup options resolve", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-startup-drain-cancel-" });
  await using session = TerminalSession.start({
    command, workspace, env: { ZCODE_TEST_STARTUP_MODE: "cancel-after-load" }
  });
  await session.waitForScreen("startup screen", /Starting ZCode/u);
  await workspace.write("release-startup", "ready");
  await session.waitForHistory("startup cancelled during input drain", /STARTUP_CANCELLED/u);
  await session.waitForHistory("raw mode restored", /STARTUP_RAW_MODE false/u);
  await expect(session.exit()).rejects.toThrow("code 143");
  expect(await workspace.readRuntimeJournal()).not.toMatch(/transcript-read|mcp-read/u);
}, 10_000);
