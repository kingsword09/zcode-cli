import { test, expect } from "bun:test";
import { join } from "node:path";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

// Issue #260: in regular (inline) mode, progress ticks on a live tool card whose
// stdoutTail preview is taller than the terminal viewport pushed the card header
// above the viewport top. Every tick then rewrote a line the inline renderer
// cannot reach, forcing a full screen clear plus scrollback wipe (ESC[2J ESC[3J)
// and a replay of the whole transcript through the pane. The viewport-aware
// active-card preview cap keeps all live updates inside the viewport, so the
// session must never emit a display clear after startup.
test("progress ticks on live tool cards never clear the screen or scrollback", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-redraw-thrash-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/inline-redraw-thrash.ts")],
    workspace,
    cols: 220,
    rows: 15,
    timeoutMilliseconds: 60_000
  });
  await session.waitForScreen("ready", /Ask a task about this workspace/u);
  // Baseline after TUI startup: the initial full-screen clear (ESC[2J ESC[3J at
  // boot) is standard alternate behavior, the regression is wipes DURING a turn.
  const baseline = session.rawHistory().length;
  await session.sendAndWait("go\r", "turn accepted", /Round 0|running/u);
  await session.waitForScreen("turn finished", /\[ ✓/u, 30_000);
  await session.settle();
  await session.exit();

  const raw = session.rawHistory(baseline);
  const displayClears = raw.split("\x1b[2J").length - 1;
  const scrollbackWipes = raw.split("\x1b[3J").length - 1;
  expect(scrollbackWipes, "scrollback wipes (ESC[3J)").toBe(0);
  expect(displayClears, "display clears (ESC[2J)").toBe(0);
}, 60_000);
