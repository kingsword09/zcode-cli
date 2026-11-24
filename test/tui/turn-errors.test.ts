import { expect, test } from "bun:test";
import { join } from "node:path";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

test("TUI shows specific turn failures without expanding and clears recovered diagnostics", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-turn-errors-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/turn-errors.ts")], workspace
  });
  await session.waitForScreen("ready", /ERROR_FIXTURE_READY/u);
  await session.sendAndWait("quota\r", "quota failure is visible", /Provider quota exhausted/u);
  expect(session.screenText().match(/Turn failed/gu)).toHaveLength(1);
  session.send("\x0f");
  await session.waitForScreen("HTTP diagnostics are retained", /HTTP: 429/u);
  await session.waitForScreen("error code is retained", /Code: quota_exceeded/u);
  session.send("\x0f");
  await session.sendAndWait("wrapped\r", "thrown cause is visible", /Provider connection refused/u);
  await session.sendAndWait("recover\r", "a recovered request does not replace a later error", /Turn execution failed/u);
  await session.assertScreenExcludes("recovered error is cleared", /Temporary network failure/u);
  await session.exit();
}, 20_000);
