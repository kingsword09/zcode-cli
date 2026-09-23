import { test } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

test.each([60, 110])("workflow inspection restores progress and resumes via keyboard at %i columns", async (cols) => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-workflows-" });
  await using session = TerminalSession.start({ command: [process.execPath, join(import.meta.dir, "fixtures/dynamic-workflows.ts")], workspace, cols });
  await session.waitForScreen("ready", /scenario\/model/u);
  await session.sendAndWait("/workflows\r", "run list", /Review workspace/u);
  session.send("\r");
  await session.waitForScreen("actions", /Resume workflow/u);
  await session.waitForHistory("restored progress", /1\/2 observed steps settled/u);
  await session.waitForHistory("artifact", /report\.md/u);
  if (process.env.ZCODE_TEST_SCREEN_DIRECTORY) {
    await writeFile(join(process.env.ZCODE_TEST_SCREEN_DIRECTORY, `workflow-${cols}.txt`), session.screenText());
  }
  session.send("\x1b[B\r");
  await session.waitForHistory("resume result", /Resumed dynamic workflow run run-1/u);
  await session.waitForHistory("live progress", /2\/2 observed steps settled/u);
  await session.exit();
}, 20_000);
