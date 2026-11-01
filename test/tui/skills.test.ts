import { test } from "bun:test";
import { join } from "node:path";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

test("slash skills are discoverable, complete through the keyboard and invoke the native skill route", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-slash-skills-" });
  await using session = TerminalSession.start({ command: [process.execPath, join(import.meta.dir, "fixtures/skills.ts")], workspace });
  await session.waitForScreen("ready", /Skill scenario ready/u);
  await session.sendAndWait("/orch", "skill suggestion", /Skill: Coordinate skill tasks/u);
  session.send("\t");
  await session.waitForScreen("completed shortcut", /\/orchestration/u);
  await session.sendAndWait("coordinate work\r", "native skill dispatch", /Runtime received: \/skill orchestration coordinate work/u);
  await session.sendAndWait("/plugin:audit review code\r", "typed qualified skill", /Runtime received: \/skill plugin:audit review code/u);
  await session.sendAndWait("/deploy task\r", "custom command precedence", /Runtime received: \/deploy task/u);
  await session.sendAndWait("/ship task\r", "alias precedence", /Runtime received: \/ship task/u);
  await session.sendAndWait("/unknown task\r", "unknown command preserved", /Runtime received: \/unknown task/u);
  await session.exit();
}, 20_000);
