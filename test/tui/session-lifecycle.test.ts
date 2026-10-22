import { expect, test } from "bun:test";
import { join } from "node:path";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

test.each(["unsupported", "missing", "unreadable", "timeout", "saved"])(
  "TUI exit uses only a verified resume target (%s)", async mode => {
    await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-tui-lifecycle-" });
    await using session = TerminalSession.start({
      command: [process.execPath, join(import.meta.dir, "fixtures/session-lifecycle.ts")], workspace,
      env: { ZCODE_TEST_RESUME_TARGET: mode }
    });
    await session.waitForScreen("ready", /◈ fixture\/model/u);
    await session.exit();
    const output = session.historyText();
    expect(output).not.toContain("zcode --resume id-only");
    if (mode === "saved") expect(output).toContain("zcode --resume saved-session");
    else expect(output).not.toContain("To continue this session");
  }, 10_000
);

test("TUI settles a failed submission even when runtime projection reads fail", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-tui-lifecycle-failure-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/session-lifecycle.ts")], workspace,
    env: { ZCODE_TEST_RESUME_TARGET: "missing" }
  });
  await session.waitForScreen("ready", /◈ fixture\/model/u);
  await session.sendAndWait("first prompt\r", "first failure", /Session not found: missing/u);
  await session.waitForScreen("failed turn settled", /\[ ✓ /u);
  const start = session.historyCheckpoint();
  session.send("second prompt\r");
  await session.waitForHistory("second failure", /Session not found: missing/u, start);
  await session.waitForScreen("next failed turn settled", /\[ ✓ /u);
  await session.exit();
}, 10_000);
