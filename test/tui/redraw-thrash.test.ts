import { test, expect } from "bun:test";
import { join } from "node:path";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

const scenarios = [
  { name: "short wide terminal", cols: 220, rows: 15 },
  { name: "wrapped output", cols: 80, rows: 24 },
  { name: "long output lines", cols: 120, rows: 24, lineWidth: 500 },
  { name: "long output in a short terminal", cols: 220, rows: 15, lineWidth: 500 },
  { name: "multiline draft", cols: 220, rows: 24, draftLines: 7 },
  { name: "queued inputs", cols: 220, rows: 15, queuedInputs: 3 }
];

test.each(scenarios)("progress ticks preserve the screen and scrollback with $name", async (scenario) => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-redraw-thrash-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/inline-redraw-thrash.ts")],
    workspace,
    cols: scenario.cols,
    rows: scenario.rows,
    env: { ZCODE_TEST_THRASH_LINE_WIDTH: String(scenario.lineWidth ?? 0) },
    timeoutMilliseconds: 60_000
  });
  await session.waitForScreen("ready", /Ask a task about this workspace/u);
  if (scenario.queuedInputs) {
    await session.sendAndWait("/queue pause\r", "queue paused", /Queue paused/u);
  }
  const baseline = session.rawHistory().length;
  await session.sendAndWait("go\r", "turn accepted", /Round 0|running/u);
  if (scenario.draftLines) {
    const draft = Array.from({ length: scenario.draftLines }, (_, index) => `draft line ${index + 1}`).join("\n");
    session.send(`\x1b[200~${draft}\x1b[201~`);
    await session.waitForScreen("multiline draft visible", /draft line 7/u);
  }
  for (let index = 0; index < (scenario.queuedInputs ?? 0); index++) {
    session.send(`Next question ${index + 1}`);
    await session.settle();
    session.send("\t");
    await session.waitForScreen("input queued", new RegExp(`${index + 1} inputs?`, "u"));
  }
  await session.waitForHistory("all rounds complete", /All rounds complete\./u, baseline, 30_000);
  await session.waitForScreen("turn finished", /\[ ✓/u, 30_000);
  await session.settle();
  if (scenario.draftLines) {
    session.send("\x03");
    await session.settle();
  }
  await session.exit();

  const raw = session.rawHistory(baseline);
  if (!scenario.lineWidth) {
    expect(session.historyText(baseline)).toContain("15 | df = spark.table");
  }
  const displayClears = raw.split("\x1b[2J").length - 1;
  const scrollbackWipes = raw.split("\x1b[3J").length - 1;
  expect(scrollbackWipes, "scrollback wipes (ESC[3J)").toBe(0);
  expect(displayClears, "display clears (ESC[2J)").toBe(0);
}, 60_000);
